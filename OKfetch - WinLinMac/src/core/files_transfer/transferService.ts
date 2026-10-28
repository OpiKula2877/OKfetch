// File transfer: offer, accept / reject (with an explanation), blocks of 64 KiB with backpressure,
// BLAKE2b check on arrival. Encrypted chats encrypt every block; plain chats send raw blocks.
// A transfer whose connection drops is paused, not failed: the receiver keeps its partial file, and when the
// peer is back the sender asks where the receiver stands and goes on from there (no time limit).
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, truncateSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseChatId, type FileState, type SendResult } from '../../shared/model'
import type { Core } from '../controller'
import { decryptText, encryptText, messageAd } from '../encryption/aead'
import { BLOCK_OVERHEAD, BLOCK_SIZE, decryptBlock, deriveFileKey, encryptBlock } from '../encryption/fileCipher'
import type { Ctrl } from '../network/protocol'
import type { Peer } from '../network/swarm'
import { hashStream } from '../sodium'
import { chatDirName, safeFileName } from '../storage/names'
import { newMessageId, type FileMeta } from '../messages/messageService'
import { cleanName } from '../contacts/contactService'
import type { StoredMessage } from '../records'

type Of<T extends Ctrl['t']> = Extract<Ctrl, { t: T }>

const ID_PATTERN = /^[0-9a-f]{32}$/
const PROGRESS_INTERVAL_MS = 150
/** Stored states that mean "wanted, not finished": when nothing runs them, they wait for the peer. */
const UNFINISHED: ReadonlySet<FileState> = new Set(['accepted', 'transferring', 'paused'])

interface Transfer {
  id: string
  chatId: string
  peer: string
  /** The connection the transfer runs on; when that connection closes, the transfer pauses. */
  session: Peer | null
  direction: 'in' | 'out'
  meta: FileMeta
  key: Buffer | null
  done: number
  /** Blocks sent or received so far: the index of the next block. */
  blocks: number
  state: FileState
  abort: boolean
  // receiving
  partPath?: string
  finalPath?: string
  fd?: number
  chain: Promise<void>
  hasher?: ReturnType<typeof hashStream>
  lastReport: number
}

const MIME: Record<string, string> = {
  gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain', pdf: 'application/pdf',
  zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg'
}

export const IMAGE_MIMES: ReadonlySet<string> = new Set(['image/gif', 'image/png', 'image/jpeg', 'image/webp'])

function guessMime(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME[extension] ?? 'application/octet-stream'
}

// Plain synchronous file calls work the same on the desktop (Node) and on the phone (Bare); the loops yield so the UI stays alive.
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function writeAll(fd: number, data: Buffer): void {
  for (let offset = 0; offset < data.length; ) offset += writeSync(fd, data, offset, data.length - offset)
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return
  try {
    closeSync(fd)
  } catch {
    // already closed
  }
}

/** Feeds the first `length` bytes of a file to `consume`, piece by piece. */
async function feedFile(path: string, length: number, consume: (piece: Buffer) => void): Promise<void> {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    while (position < length) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, length - position), position)
      if (read === 0) break
      consume(buffer.subarray(0, read))
      position += read
      await yieldToLoop()
    }
  } finally {
    closeSync(fd)
  }
}

/** Copies a file and hashes the copy in the same pass. A failed copy leaves nothing behind. */
async function copyAndHash(from: string, to: string): Promise<{ size: number; hash: string }> {
  if (!statSync(from).isFile()) throw new Error('not a file')
  mkdirSync(dirname(to), { recursive: true })
  const hasher = hashStream()
  const input = openSync(from, 'r')
  const output = openSync(to, 'w')
  const buffer = Buffer.alloc(1024 * 1024)
  let size = 0
  let copied = false
  try {
    let read = readSync(input, buffer, 0, buffer.length, size)
    while (read > 0) {
      hasher.update(buffer.subarray(0, read))
      writeAll(output, buffer.subarray(0, read))
      size += read
      await yieldToLoop()
      read = readSync(input, buffer, 0, buffer.length, size)
    }
    copied = true
  } finally {
    closeSync(input)
    closeSync(output)
    if (!copied) rmSync(to, { force: true })
  }
  return { size, hash: hasher.digest().toString('hex') }
}

export class TransferService {
  private active = new Map<string, Transfer>()
  /** A paused receive whose file is still being closed: a resume waits for that. */
  private closing = new Map<string, Promise<void>>()

  constructor(private core: Core) {}

  // --- helpers ------------------------------------------------------------------

  private find(pub: string, id: string): { chatId: string; message: StoredMessage } | null {
    for (const kind of ['enc', 'plain'] as const) {
      const chatId = `${pub}:${kind}`
      const message = this.core.chatLog(chatId).messages.get(id)
      if (message?.kind === 'file' && message.file) return { chatId, message }
    }
    return null
  }

  private readMeta(message: StoredMessage): FileMeta | null {
    try {
      let text = message.body
      if (message.enc) {
        const key = this.core.chatKey(message.chatId)
        const wire = this.core.messages.wireChat(message.chatId) ?? ''
        const plain = key ? decryptText(key, message.body, messageAd(wire, message.id)) : null
        if (plain === null) return null
        text = plain
      }
      return JSON.parse(text) as FileMeta
    } catch {
      return null
    }
  }

  private patch(chatId: string, id: string, file: Partial<NonNullable<StoredMessage['file']>>): void {
    this.core.chatLog(chatId).update(id, { file })
    this.core.chatChanged(chatId)
  }

  private announce(chatId: string, id: string, done: number, total: number, state: FileState): void {
    this.core.emit({ type: 'transfer', progress: { chatId, messageId: id, done, total, state } })
  }

  private report(t: Transfer, force = false): void {
    const now = Date.now()
    if (!force && now - t.lastReport < PROGRESS_INTERVAL_MS) return
    t.lastReport = now
    this.announce(t.chatId, t.id, t.done, t.meta.size, t.state)
  }

  /** Where a file of a chat is kept: `<chat folder>/<id>_<name>`, for my copy and for a received file alike. */
  private relOf(chatId: string, id: string, name: string): string {
    return `${chatDirName(chatId)}/${id}_${safeFileName(name)}`
  }

  private absOf(rel: string): string {
    return join(this.core.filesRoot, ...rel.split('/'))
  }

  /** The partial file of a receive that will not go on. */
  private dropPart(message: StoredMessage): void {
    if (message.file?.direction === 'in' && message.file.rel) rmSync(`${this.absOf(message.file.rel)}.part`, { force: true })
  }

  progressOf(id: string, state: FileState, size: number): number {
    const active = this.active.get(id)
    if (active) return active.done
    return state === 'done' ? size : 0
  }

  /** A transfer that is wanted but not running (its connection closed, or the app stopped) waits for the peer. */
  effectiveState(id: string, state: FileState): FileState {
    return UNFINISHED.has(state) && !this.active.has(id) ? 'paused' : state
  }

  /** The file for the viewer: my own copy at once, a received file once it is complete. */
  filePath(chatId: string, id: string): string | null {
    const file = this.core.chatLog(chatId).messages.get(id)?.file
    if (!file?.rel) return null
    return file.direction === 'out' || file.state === 'done' ? this.absOf(file.rel) : null
  }

  // --- sending ---------------------------------------------------------------------

  async sendFile(chatId: string, path: string): Promise<SendResult> {
    const parsed = parseChatId(chatId)
    if (!parsed || parsed.type !== 'contact' || !this.core.isContact(parsed.pub)) return { ok: false, reason: 'no_chat' }
    const enc = parsed.kind === 'enc'
    const key = enc ? this.core.chatKey(chatId) : null
    if (enc && !key) return { ok: false, reason: 'no_chat' }
    const id = newMessageId()
    const name = basename(path)
    const rel = this.relOf(chatId, id, name)
    // I keep a copy: the chat shows the file and the transfer reads it, whatever happens to the original.
    let copy: { size: number; hash: string }
    try {
      copy = await copyAndHash(path, this.absOf(rel))
    } catch {
      return { ok: false, reason: 'no_file' }
    }
    const json = JSON.stringify({ name, size: copy.size, mime: guessMime(name), hash: copy.hash } satisfies FileMeta)
    const body = key ? encryptText(key, json, messageAd(parsed.kind, id)) : json
    const lamport = this.core.tick()
    const ts = Date.now()
    this.core.chatLog(chatId).add({
      id, chatId, from: this.core.me, ts, lamport, body, enc, kind: 'file', waiting: [parsed.pub], read: false,
      // `source` lets the phone remove its copy in outgoing/ once this transfer is over (mobile/outgoing.ts).
      file: { state: 'offered', direction: 'out', rel, source: path }
    })
    this.core.sendReliable(parsed.pub, { t: 'file_offer', rid: id, chat: parsed.kind, ts, lamport, meta: body, enc })
    this.core.chatChanged(chatId)
    return { ok: true, id }
  }

  onOfferDelivered(pub: string, id: string): void {
    const found = this.find(pub, id)
    if (!found) return
    this.core.chatLog(found.chatId).update(id, { waiting: [] })
    this.core.chatChanged(found.chatId)
  }

  onAccept(peer: Peer, ctrl: Of<'file_accept'>): boolean {
    const found = this.find(peer.pub, String(ctrl.id))
    if (!found || found.message.from !== this.core.me || !found.message.file) return false
    if (found.message.file.state !== 'offered' || this.active.has(found.message.id)) return true
    return this.startOut(peer, found.message, 0)
  }

  /** Sends the file of an outgoing message on this connection, from block `from` on. */
  private startOut(peer: Peer, message: StoredMessage, from: number): boolean {
    const file = message.file
    const meta = this.readMeta(message)
    const path = file?.rel ? this.absOf(file.rel) : file?.source
    if (!meta || !path) return false
    const key = message.enc ? this.core.chatKey(message.chatId) : null
    const start = Math.min(Math.max(0, Math.floor(from)), Math.ceil(meta.size / BLOCK_SIZE))
    const t: Transfer = {
      id: message.id, chatId: message.chatId, peer: peer.pub, session: peer, direction: 'out', meta,
      key: key ? deriveFileKey(key, message.id) : null, done: Math.min(start * BLOCK_SIZE, meta.size), blocks: start,
      state: 'transferring', abort: false, chain: Promise.resolve(), lastReport: 0
    }
    this.active.set(message.id, t)
    this.patch(message.chatId, message.id, { state: 'transferring' })
    void this.pump(t, peer, path)
    return true
  }

  private async pump(t: Transfer, peer: Peer, path: string): Promise<void> {
    let fd: number | null = null
    try {
      fd = openSync(path, 'r')
      const buffer = Buffer.alloc(BLOCK_SIZE)
      for (let index = t.blocks; !t.abort; index++) {
        const bytesRead = readSync(fd, buffer, 0, BLOCK_SIZE, index * BLOCK_SIZE)
        if (bytesRead === 0) break
        const block = buffer.subarray(0, bytesRead)
        const data = t.key ? encryptBlock(t.key, index, block) : Buffer.from(block)
        // The connection closed: onPeerClosed pauses the transfer, and the next connection carries on from its position.
        if (!(await peer.sendBlock(t.id, index, data))) return
        t.done += bytesRead
        t.blocks = index + 1
        this.report(t)
        if (index % 16 === 15) await yieldToLoop()
      }
      if (t.abort) return
      if (t.done !== t.meta.size) throw new Error('changed')
      peer.send({ t: 'file_end', id: t.id, blocks: t.blocks })
    } catch (error) {
      if (!t.abort) this.fail(t, error instanceof Error ? error.message : 'failed')
    } finally {
      closeQuietly(fd ?? undefined)
    }
  }

  /** The receiver's answer to a resume: it has these blocks, so the sender goes on from block `blocks`. */
  onPosition(peer: Peer, ctrl: Of<'file_position'>): void {
    const id = String(ctrl.id)
    const found = this.find(peer.pub, id)
    if (!found || found.message.from !== this.core.me || found.message.file?.direction !== 'out') return
    if (this.active.has(id) || this.effectiveState(id, found.message.file.state) !== 'paused') return
    this.startOut(peer, found.message, Number.isSafeInteger(ctrl.blocks) ? ctrl.blocks : 0)
  }

  /** The receiver's verdict on a file of mine. */
  onDone(peer: Peer, ctrl: Of<'file_done'>): void {
    const id = String(ctrl.id)
    const found = this.find(peer.pub, id)
    if (!found || found.message.from !== this.core.me || found.message.file?.direction !== 'out') return
    if (!UNFINISHED.has(this.effectiveState(id, found.message.file.state))) return
    const t = this.active.get(id)
    this.active.delete(id)
    if (t) t.abort = true
    const total = this.readMeta(found.message)?.size ?? 0
    const state: FileState = ctrl.ok ? 'done' : 'failed'
    this.patch(found.chatId, id, { state, feedback: ctrl.ok ? undefined : 'failed' })
    this.announce(found.chatId, id, ctrl.ok ? total : (t?.done ?? 0), total, state)
  }

  // --- receiving ---------------------------------------------------------------------

  onOffer(peer: Peer, ctrl: Of<'file_offer'>): boolean {
    if (!this.core.isContact(peer.pub) || !ID_PATTERN.test(String(ctrl.rid))) return false
    if ((ctrl.chat !== 'enc' && ctrl.chat !== 'plain') || (ctrl.chat === 'enc') !== Boolean(ctrl.enc) || typeof ctrl.meta !== 'string' || ctrl.meta.length > 8192) return false
    const chatId = `${peer.pub}:${ctrl.chat}`
    const log = this.core.chatLog(chatId)
    if (log.has(ctrl.rid)) return true
    const lamport = Number.isFinite(ctrl.lamport) ? Math.max(0, Math.floor(ctrl.lamport)) : 0
    const message: StoredMessage = {
      id: ctrl.rid, chatId, from: peer.pub, ts: Number.isFinite(ctrl.ts) ? Math.min(ctrl.ts, Date.now() + 86_400_000) : Date.now(), lamport,
      body: ctrl.meta, enc: ctrl.enc, kind: 'file', waiting: [], read: false, file: { state: 'offered', direction: 'in' }
    }
    const meta = this.readMeta(message)
    if (!meta || typeof meta.name !== 'string' || !Number.isSafeInteger(meta.size) || meta.size < 0 || !/^[0-9a-f]{64}$/.test(String(meta.hash))) return false
    this.core.tick(lamport)
    log.add(message)
    this.core.chatChanged(chatId)
    this.core.emit({ type: 'incoming', chatId, title: this.core.nameOf(peer.pub), text: cleanName(meta.name, 120), muted: this.core.chatMuted(chatId) })
    return true
  }

  accept(chatId: string, id: string): boolean {
    const message = this.core.chatLog(chatId).messages.get(id)
    const parsed = parseChatId(chatId)
    if (!message || parsed?.type !== 'contact' || message.kind !== 'file' || message.file?.direction !== 'in' || message.file.state !== 'offered') return false
    const meta = this.readMeta(message)
    if (!meta) return false
    const key = message.enc ? this.core.chatKey(chatId) : null
    const rel = this.relOf(chatId, id, meta.name)
    const finalPath = this.absOf(rel)
    mkdirSync(dirname(finalPath), { recursive: true })
    this.active.set(id, {
      id, chatId, peer: parsed.pub, session: null, direction: 'in', meta, key: key ? deriveFileKey(key, id) : null, done: 0, blocks: 0, state: 'accepted', abort: false,
      partPath: `${finalPath}.part`, finalPath, chain: Promise.resolve(), hasher: hashStream(), lastReport: 0
    })
    this.patch(chatId, id, { state: 'accepted', rel })
    this.core.sendReliable(parsed.pub, { t: 'file_accept', rid: newMessageId(), id })
    return true
  }

  reject(chatId: string, id: string, feedback = ''): boolean {
    const message = this.core.chatLog(chatId).messages.get(id)
    const parsed = parseChatId(chatId)
    if (!message || parsed?.type !== 'contact' || message.file?.direction !== 'in' || message.file.state !== 'offered') return false
    this.patch(chatId, id, { state: 'rejected', feedback: cleanName(feedback, 300) || undefined })
    this.core.sendReliable(parsed.pub, { t: 'file_reject', rid: newMessageId(), id, feedback: cleanName(feedback, 300) })
    return true
  }

  onReject(peer: Peer, ctrl: Of<'file_reject'>): boolean {
    const found = this.find(peer.pub, String(ctrl.id))
    if (!found || found.message.from !== this.core.me || found.message.file?.state !== 'offered') return found !== null
    this.patch(found.chatId, found.message.id, { state: 'rejected', feedback: cleanName(ctrl.feedback, 300) || undefined })
    return true
  }

  onBlock(peer: Peer, block: { id: string; index: number; data: Buffer }): void {
    const t = this.active.get(block.id)
    if (!t || t.direction !== 'in' || t.peer !== peer.pub || (t.state !== 'accepted' && t.state !== 'transferring')) return
    if (block.index !== t.blocks || block.data.length > BLOCK_SIZE + BLOCK_OVERHEAD) return this.fail(t, 'order')
    const plain = t.key ? decryptBlock(t.key, block.index, block.data) : block.data
    if (!plain) return this.fail(t, 'decrypt')
    if (t.done + plain.length > t.meta.size) return this.fail(t, 'size')
    t.session = peer
    if (t.state === 'accepted') {
      t.state = 'transferring'
      this.patch(t.chatId, t.id, { state: 'transferring' })
    }
    t.blocks++
    t.done += plain.length
    t.hasher!.update(plain)
    const data = Buffer.from(plain)
    t.chain = t.chain
      .then(() => {
        if (t.fd === undefined) {
          mkdirSync(dirname(t.partPath!), { recursive: true })
          // Append: a resumed receive keeps what it has.
          t.fd = openSync(t.partPath!, 'a')
        }
        writeAll(t.fd, data)
      })
      .catch(() => {
        t.abort = true
      })
    this.report(t)
  }

  async onEnd(peer: Peer, ctrl: Of<'file_end'>): Promise<void> {
    const t = this.active.get(String(ctrl.id))
    if (!t || t.direction !== 'in' || t.peer !== peer.pub) return
    await t.chain
    // Paused or stopped while the last blocks were written: the sender ends the file again on its next resume.
    if (this.active.get(t.id) !== t) return
    if (t.fd !== undefined) closeSync(t.fd)
    t.fd = undefined
    const good = !t.abort && ctrl.blocks === t.blocks && t.done === t.meta.size && t.hasher!.digest().toString('hex') === t.meta.hash
    if (!good) {
      peer.send({ t: 'file_done', id: t.id, ok: false })
      return this.fail(t, 'hash', false)
    }
    try {
      if (t.meta.size === 0) {
        mkdirSync(dirname(t.finalPath!), { recursive: true })
        closeSync(openSync(t.finalPath!, 'w'))
      } else {
        renameSync(t.partPath!, t.finalPath!)
      }
    } catch {
      peer.send({ t: 'file_done', id: t.id, ok: false })
      return this.fail(t, 'disk', false)
    }
    this.active.delete(t.id)
    t.state = 'done'
    this.patch(t.chatId, t.id, { state: 'done' })
    this.report(t, true)
    peer.send({ t: 'file_done', id: t.id, ok: true })
  }

  /** The sender wants to go on after a pause: the partial file is checked, its position is sent back, and the transfer runs again. */
  async onResume(peer: Peer, ctrl: Of<'file_resume'>): Promise<void> {
    const id = String(ctrl.id)
    const found = this.find(peer.pub, id)
    if (!found || found.message.from !== peer.pub || found.message.file?.direction !== 'in') return
    const { chatId, message } = found
    const state = this.effectiveState(id, message.file!.state)
    if (state === 'done') return void peer.send({ t: 'file_done', id, ok: true })
    if (state === 'failed') return void peer.send({ t: 'file_done', id, ok: false })
    if (state === 'canceled' || state === 'rejected') return void peer.send({ t: 'file_cancel', id })
    if (state === 'offered') return
    const running = this.active.get(id)
    if (running) {
      running.session = peer
      return void peer.send({ t: 'file_position', id, blocks: running.blocks })
    }
    const meta = this.readMeta(message)
    const rel = message.file!.rel
    if (!meta || !rel) return
    const finalPath = this.absOf(rel)
    const partPath = `${finalPath}.part`
    await this.closing.get(id)
    this.closing.delete(id)
    // Only whole blocks count: a block cut short by the pause is cut off the file again.
    const size = existsSync(partPath) ? statSync(partPath).size : 0
    let blocks = Math.floor(size / BLOCK_SIZE)
    if (blocks * BLOCK_SIZE > meta.size) blocks = 0
    if (existsSync(partPath)) truncateSync(partPath, blocks * BLOCK_SIZE)
    const hasher = hashStream()
    if (blocks > 0) await feedFile(partPath, blocks * BLOCK_SIZE, (piece) => hasher.update(piece))
    if (this.active.has(id) || !this.core.chatLog(chatId).messages.get(id)) return
    const key = message.enc ? this.core.chatKey(chatId) : null
    this.active.set(id, {
      id, chatId, peer: peer.pub, session: peer, direction: 'in', meta, key: key ? deriveFileKey(key, id) : null, done: blocks * BLOCK_SIZE, blocks,
      state: 'transferring', abort: false, partPath, finalPath, chain: Promise.resolve(), hasher, lastReport: 0
    })
    this.patch(chatId, id, { state: 'transferring' })
    peer.send({ t: 'file_position', id, blocks })
  }

  /** "Try to connect again": the peer is reached now and the transfer goes on from where it stopped. */
  retry(chatId: string, id: string): boolean {
    const parsed = parseChatId(chatId)
    const message = this.core.chatLog(chatId).messages.get(id)
    if (!parsed || parsed.type !== 'contact' || !message?.file) return false
    if (this.effectiveState(id, message.file.state) !== 'paused') return false
    this.core.net.reconnect(parsed.pub)
    const peer = this.core.net.peer(parsed.pub)
    if (peer) this.onPeerOpen(peer)
    return true
  }

  /** Something is still being sent or received (or waits for the peer): the app stays in the tray instead of quitting. */
  hasUnfinished(): boolean {
    if (this.active.size > 0) return true
    for (const contact of this.core.state.contacts) {
      for (const kind of ['enc', 'plain'] as const) {
        for (const message of this.core.chatLog(`${contact.pub}:${kind}`).messages.values()) {
          const file = message.file
          if (!file) continue
          if (file.direction === 'out' && file.state === 'offered') return true
          if (UNFINISHED.has(this.effectiveState(message.id, file.state))) return true
        }
      }
    }
    return false
  }

  // --- cancel and cleanup ------------------------------------------------------------------

  cancel(chatId: string, id: string): boolean {
    const t = this.active.get(id)
    if (t) {
      this.core.sendNow(t.peer, { t: 'file_cancel', id })
      this.stop(t, 'canceled')
      return true
    }
    const message = this.core.chatLog(chatId).messages.get(id)
    const parsed = parseChatId(chatId)
    if (!message?.file || parsed?.type !== 'contact') return false
    if (message.file.state === 'offered') {
      // Still waiting for an answer: withdraw the offer.
      this.core.dropOutbox((entry) => entry.frame.t === 'file_offer' && entry.frame.rid === id)
      this.core.sendNow(parsed.pub, { t: 'file_cancel', id })
      this.patch(chatId, id, { state: 'canceled' })
      return true
    }
    if (UNFINISHED.has(this.effectiveState(id, message.file.state))) {
      // Paused: the peer hears about it now, or when it is back (its resume is answered with the cancel).
      this.core.sendNow(parsed.pub, { t: 'file_cancel', id })
      this.dropPart(message)
      this.patch(chatId, id, { state: 'canceled' })
      return true
    }
    return false
  }

  onCancel(peer: Peer, ctrl: Of<'file_cancel'>): void {
    const id = String(ctrl.id)
    const t = this.active.get(id)
    if (t && t.peer === peer.pub) return this.stop(t, 'canceled')
    const found = this.find(peer.pub, id)
    if (!found?.message.file) return
    if (found.message.file.state === 'offered') this.patch(found.chatId, id, { state: 'canceled' })
    else if (UNFINISHED.has(this.effectiveState(id, found.message.file.state))) {
      this.dropPart(found.message)
      this.patch(found.chatId, id, { state: 'canceled' })
    }
  }

  private fail(t: Transfer, feedback: string, notify = true): void {
    if (notify) this.core.sendNow(t.peer, { t: 'file_cancel', id: t.id })
    this.stop(t, 'failed', feedback)
  }

  private stop(t: Transfer, state: FileState, feedback?: string): void {
    t.abort = true
    this.active.delete(t.id)
    const fd = t.fd
    t.fd = undefined
    void t.chain.finally(() => {
      closeQuietly(fd)
      if (t.partPath) rmSync(t.partPath, { force: true })
    })
    t.state = state
    this.patch(t.chatId, t.id, { state, feedback })
    this.report(t, true)
  }

  /** The connection closed: its transfers wait for the peer. A receive keeps its partial file; nothing is failed. */
  private pause(t: Transfer): void {
    t.abort = true
    this.active.delete(t.id)
    const fd = t.fd
    t.fd = undefined
    this.closing.set(t.id, t.chain.finally(() => closeQuietly(fd)))
    this.patch(t.chatId, t.id, { state: 'paused' })
    this.report(t, true)
  }

  onPeerClosed(peer: Peer): void {
    for (const t of [...this.active.values()]) if (t.session === peer) this.pause(t)
  }

  /** A connection to a contact is up again: my transfers that wait for it ask the receiver where it stands. */
  onPeerOpen(peer: Peer): void {
    for (const kind of ['enc', 'plain'] as const) {
      for (const message of this.core.chatLog(`${peer.pub}:${kind}`).messages.values()) {
        const file = message.file
        if (message.kind !== 'file' || file?.direction !== 'out' || file.state === 'offered' || this.active.has(message.id)) continue
        if (UNFINISHED.has(this.effectiveState(message.id, file.state))) peer.send({ t: 'file_resume', id: message.id })
      }
    }
  }

  cancelAllFor(pub: string): void {
    for (const t of [...this.active.values()]) if (t.peer === pub) this.stop(t, 'canceled')
  }

  /** The message was deleted: stop its transfer, and remove the received file or my copy. */
  discard(message: StoredMessage): void {
    const t = this.active.get(message.id)
    if (t) {
      this.core.sendNow(t.peer, { t: 'file_cancel', id: t.id })
      this.stop(t, 'canceled')
    }
    this.dropPart(message)
    if (message.file?.rel) this.core.messages.removeFile(message.file.rel)
    this.core.dropOutbox((entry) => entry.frame.t === 'file_offer' && entry.frame.rid === message.id)
  }

  shutdown(): void {
    for (const t of [...this.active.values()]) {
      t.abort = true
      closeQuietly(t.fd)
    }
    this.active.clear()
  }
}

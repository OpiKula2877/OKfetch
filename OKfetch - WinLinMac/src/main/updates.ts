// The Windows app updates itself: the newest release on GitHub is downloaded in the background. Its size and
// SHA-256 digest (from the GitHub API) must match before the file is kept. The installer starts only when the
// user asks for it, after the app has quit.
import { app, shell } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { join } from 'node:path'
import type { UpdateState } from '../shared/ipc'

const REPO = 'OpiKula2877/OKfetch'
const ASSET = 'OKfetch-Setup.exe'
const FIRST_CHECK_MS = 20_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const MAX_REDIRECTS = 5

interface Release {
  version: string
  url: string
  size: number
  sha256: string
}

/** `1.2.3` or `v1.2.3` as numbers; null for anything else. */
function parseVersion(text: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** Is `candidate` newer than `current`? Unknown formats are never newer. */
export function isNewer(candidate: string, current: string): boolean {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (!next || !now) return false
  for (let i = 0; i < 3; i++) if (next[i] !== now[i]) return next[i] > now[i]
  return false
}

function userAgent(): string {
  return `OKfetch/${app.getVersion()}`
}

/** The text of an HTTPS response; anything but 200 is an error. */
function getText(url: string, accept: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { 'User-Agent': userAgent(), Accept: accept } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('error', reject)
      res.on('end', () => resolve(body))
    })
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

/** The newest published release with its installer. Drafts and pre-releases are not "latest". */
async function latestRelease(): Promise<Release | null> {
  const body = await getText(`https://api.github.com/repos/${REPO}/releases/latest`, 'application/vnd.github+json')
  const data = JSON.parse(body) as { tag_name?: unknown; assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[] }
  const version = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : ''
  const asset = data.assets?.find((item) => item.name === ASSET)
  if (!parseVersion(version) || !asset) return null
  const url = asset.browser_download_url
  const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest) : null
  if (typeof url !== 'string' || !url.startsWith(`https://github.com/${REPO}/releases/download/`)) return null
  if (!digest || typeof asset.size !== 'number') return null
  return { version, url, size: asset.size, sha256: digest[1] }
}

/** Downloads the installer into `target`. The file is kept only when its size and SHA-256 match the release. */
function download(release: Release, target: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const partial = `${target}.part`
    const fetchFrom = (address: string, redirects: number): void => {
      const req = request(address, { headers: { 'User-Agent': userAgent() } }, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
          res.resume()
          fetchFrom(new URL(res.headers.location, address).toString(), redirects + 1)
          return
        }
        if (status !== 200) {
          res.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        const file = createWriteStream(partial)
        const hash = createHash('sha256')
        let received = 0
        let shown = -1
        res.on('data', (chunk: Buffer) => {
          hash.update(chunk)
          received += chunk.length
          // The window gets the progress once per percent, not once per chunk.
          const percent = Math.min(99, Math.floor((received * 100) / release.size))
          if (percent !== shown) {
            shown = percent
            onProgress(percent)
          }
        })
        res.pipe(file)
        res.on('error', (error) => {
          file.destroy()
          reject(error)
        })
        // A connection cut in the middle ends the response without 'end', and the file would never finish.
        res.on('close', () => {
          if (!res.complete) {
            file.destroy()
            reject(new Error('The connection was interrupted.'))
          }
        })
        file.on('error', reject)
        file.on('finish', () => {
          if (received !== release.size || hash.digest('hex') !== release.sha256) {
            rmSync(partial, { force: true })
            reject(new Error('The download does not match the release.'))
            return
          }
          try {
            renameSync(partial, target)
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      })
      req.setTimeout(60_000, () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      req.end()
    }
    fetchFrom(release.url, 0)
  })
}

export class Updater {
  private state: UpdateState = { status: 'idle', current: app.getVersion() }
  private installer: string | null = null
  private running = false
  private timer: NodeJS.Timeout | null = null

  constructor(private publish: (state: UpdateState) => void) {}

  snapshot(): UpdateState {
    return this.state
  }

  /** Checks shortly after the start and then every few hours. Development builds never update themselves. */
  start(): void {
    if (!app.isPackaged || this.timer) return
    this.timer = setTimeout(() => {
      void this.check()
      this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
    }, FIRST_CHECK_MS)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Looks for a newer release and downloads it. Nothing is installed here. */
  async check(): Promise<void> {
    if (this.running || this.installer) return
    this.running = true
    this.set({ status: 'checking' })
    try {
      const release = await latestRelease()
      if (!release || !isNewer(release.version, app.getVersion())) {
        this.set({ status: 'upToDate' })
        return
      }
      const dir = join(app.getPath('userData'), 'updates')
      mkdirSync(dir, { recursive: true })
      for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true })
      const target = join(dir, `OKfetch-Setup-${release.version}.exe`)
      this.set({ status: 'downloading', latest: release.version, progress: 0 })
      await download(release, target, (progress) => this.set({ status: 'downloading', latest: release.version, progress }))
      this.installer = target
      this.set({ status: 'ready', latest: release.version })
    } catch (error) {
      this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.running = false
    }
  }

  /** The user asked for the new version: the app quits, then the installer starts. */
  install(quit: () => void): boolean {
    const installer = this.installer
    if (!installer || !existsSync(installer)) return false
    app.once('quit', () => void shell.openPath(installer))
    quit()
    return true
  }

  private set(state: Omit<UpdateState, 'current'>): void {
    this.state = { current: app.getVersion(), ...state }
    this.publish(this.state)
  }
}

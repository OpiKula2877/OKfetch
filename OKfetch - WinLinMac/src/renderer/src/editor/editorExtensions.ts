// TipTap setup for the message composer: paragraphs, headings (H1/H2), bold, italic, links and block indentation.
import { Extension, combineTransactionSteps, findChildrenInRange, getChangedRanges, type Extensions } from '@tiptap/core'
import { isHistoryTransaction } from '@tiptap/pm/history'
import type { Mark, MarkType, Node as ProseNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { tokenize } from 'linkifyjs'

export const INDENT_WIDTH = 28
export const MAX_INDENT = 10
const INDENT_TYPES = ['paragraph', 'heading']

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType
      outdent: () => ReturnType
    }
  }
}

const clamp = (value: number): number => Math.max(0, Math.min(MAX_INDENT, Number.isFinite(value) ? value : 0))

function parseIndent(element: HTMLElement): number {
  const own = element.getAttribute('data-indent')
  return own !== null ? clamp(parseInt(own, 10)) : 0
}

export const Indent = Extension.create({
  name: 'indent',

  addGlobalAttributes() {
    return [
      {
        types: INDENT_TYPES,
        attributes: {
          indent: {
            default: 0,
            parseHTML: parseIndent,
            renderHTML: (attributes: { indent?: number }) =>
              attributes.indent ? { 'data-indent': attributes.indent, style: `margin-left: ${attributes.indent * INDENT_WIDTH}px` } : {}
          }
        }
      }
    ]
  },

  addCommands() {
    const change =
      (delta: number) =>
      () =>
      ({ tr, state, dispatch }: { tr: import('@tiptap/pm/state').Transaction; state: import('@tiptap/pm/state').EditorState; dispatch?: unknown }) => {
        const { from, to } = state.selection
        let changed = false
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!INDENT_TYPES.includes(node.type.name)) return true
          const next = clamp((node.attrs.indent ?? 0) + delta)
          if (next !== node.attrs.indent) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next })
            changed = true
          }
          return false
        })
        if (changed && dispatch) (dispatch as (t: typeof tr) => void)(tr)
        return true
      }
    return { indent: change(1), outdent: change(-1) }
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.indent(),
      'Shift-Tab': () => this.editor.commands.outdent()
    }
  }
})

/** Ctrl/Cmd+0 normal text, +1 heading, +2 subheading. */
export const BlockShortcuts = Extension.create({
  name: 'blockShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-0': () => this.editor.commands.setParagraph(),
      'Mod-1': () => this.editor.commands.setHeading({ level: 1 }),
      'Mod-2': () => this.editor.commands.setHeading({ level: 2 })
    }
  }
})

/** Enter sends, Shift+Enter inserts a line break. The handler is looked up at the time of the key press. */
export function sendOnEnter(getHandler: () => (() => void) | undefined): Extension {
  return Extension.create({
    name: 'sendOnEnter',
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        Enter: () => {
          const handler = getHandler()
          if (!handler) return false
          handler()
          return true
        }
      }
    }
  })
}

export const LINK_PROTOCOLS = ['http', 'https', 'mailto']
const LINK_HREF = /^(?:https?:\/\/|mailto:)/i
/** Class of a link made from typed text: it is taken off again once the text stops being an address. Links set by hand have none. */
const AUTO_LINK = 'autolink'

/** Every link mark inside [from, to], with the part of the range it covers. */
function linkMarks(doc: ProseNode, type: MarkType, from: number, to: number): { mark: Mark; from: number; to: number }[] {
  const found: { mark: Mark; from: number; to: number }[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true
    for (const mark of node.marks) {
      if (mark.type === type) found.push({ mark, from: Math.max(from, pos), to: Math.min(to, pos + node.nodeSize) })
    }
    return false
  })
  return found
}

/**
 * Links one word (the text from `from` to `to`) when it is an address; the trailing punctuation stays out of the link.
 * An auto link on a word that is no longer an address is taken off. Links set by hand are never changed.
 */
function linkWord(tr: Transaction, type: MarkType, from: number, to: number, word: string): void {
  const links = tokenize(word).filter((token) => token.isLink)
  const link = links.length === 1 ? links[0].toObject('https') : null
  const target = link && LINK_HREF.test(link.href) ? { from: from + link.start, to: from + link.end, href: link.href } : null
  const ranges = linkMarks(tr.doc, type, from, to)
  if (ranges.some(({ mark }) => mark.attrs.class !== AUTO_LINK)) return
  const length = ranges.reduce((sum, range) => sum + range.to - range.from, 0)
  const kept = target !== null && length === target.to - target.from && ranges.every((range) => range.from >= target.from && range.to <= target.to && range.mark.attrs.href === target.href)
  if (kept) return
  for (const range of ranges) tr.removeMark(range.from, range.to, range.mark)
  if (target) tr.addMark(target.from, target.to, type.create({ href: target.href, class: AUTO_LINK }))
}

/** Links the words of one textblock that a change touched; the change first grows to whole words (a word ends at a space). */
function linkChanged(tr: Transaction, type: MarkType, block: ProseNode, start: number, change: { from: number; to: number }): void {
  // A leaf (a line break, an image) reads as a space: it ends a word and keeps one character per position.
  const text = block.textBetween(0, block.content.size, undefined, ' ')
  const isWordChar = (index: number): boolean => index >= 0 && index < text.length && !/\s/.test(text[index])
  let from = Math.max(change.from, start) - start
  let to = Math.min(change.to, start + text.length) - start
  if (from > to) return
  while (isWordChar(from - 1)) from--
  while (isWordChar(to)) to++
  for (const match of text.slice(from, to).matchAll(/\S+/g)) {
    const at = start + from + (match.index ?? 0)
    linkWord(tr, type, at, at + match[0].length, match[0])
  }
}

/**
 * Links an address as soon as it is typed. TipTap's autolink waits for a space after the address, so a message that ends with one stayed plain text.
 * Every change is checked: the words it touched become links when they are addresses, and auto links that stopped being addresses lose their link.
 */
export const LiveLink = Extension.create({
  name: 'liveLink',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('liveLink'),
        appendTransaction(transactions, oldState, state) {
          if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta('preventAutolink') || isHistoryTransaction(tr))) return null
          const type = state.schema.marks.link
          const tr = state.tr
          for (const { newRange } of getChangedRanges(combineTransactionSteps(oldState.doc, [...transactions]))) {
            for (const { node, pos } of findChildrenInRange(state.doc, newRange, (block) => block.isTextblock)) {
              linkChanged(tr, type, node, pos + 1, newRange)
            }
          }
          return tr.docChanged ? tr : null
        }
      })
    ]
  }
})

export function baseExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2] },
      blockquote: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      strike: false,
      underline: false,
      // Autolink off: a link that grew with the text typed after it would take in the next words. LiveLink links instead.
      link: { openOnClick: false, autolink: false, protocols: LINK_PROTOCOLS, HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null } },
      trailingNode: false
    }),
    Indent,
    BlockShortcuts,
    LiveLink
  ]
}

/** Add "https://" to a link typed without a scheme; null when the address is not usable. */
export function normalizeLink(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? `mailto:${text}` : `https://${text}`
  return /^(https?:\/\/|mailto:)\S+$/i.test(candidate) ? candidate : null
}

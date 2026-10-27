import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import type { MessageView } from '../../../shared/model'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { useApp } from '../context'
import { formatTime } from '../util/format'
import { highlight } from '../util/sanitize'
import { FileOfferCard } from './FileOfferCard'

/** How far (px) a phone bubble has to be dragged to the right to answer it. */
const SWIPE_PX = 56

interface Props {
  message: MessageView
  showSender: boolean
  selectionMode: boolean
  selected: boolean
  onToggle: () => void
  query: string
  /** Index of the highlighted occurrence inside this message, or null. */
  activeMatch: number | null
  transferDone?: number
  /** Phone: holding a message starts selecting (Android fires contextmenu on a long press). */
  onLongPress?: () => void
  /** Answer this message (the reply bar of the composer). */
  onReply: () => void
  /** Show the message a reply quotes. */
  onQuote: (id: string) => void
}

function StatusMark({ message }: { message: MessageView }) {
  const { t } = useApp()
  if (!message.mine || !message.status) return null
  if (message.status === 'pending') return <span title={t('chat.status.pending')}><Icon name="clock" size={14} /></span>
  if (message.status === 'delivered') return <span title={t('chat.status.delivered')}><Icon name="check" size={14} /></span>
  return <span className="read-mark" title={t('chat.status.read')}><Icon name="check_double" size={14} /></span>
}

export function MessageBubble({ message, showSender, selectionMode, selected, onToggle, query, activeMatch, transferDone, onLongPress, onReply, onQuote }: Props) {
  const { t, settings } = useApp()
  const bubble = useRef<HTMLDivElement>(null)
  const html = useMemo(() => (message.file || message.broken ? '' : highlight(message.html, query, activeMatch)), [message.html, message.file, message.broken, query, activeMatch])
  const swipe = useRef<{ id: number; x: number; y: number; moving: boolean; offset: number } | null>(null)
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    if (activeMatch !== null) bubble.current?.querySelector('mark.active')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeMatch, query])

  // Links open in the system browser, never inside the app.
  const onClick = (event: MouseEvent): void => {
    const link = (event.target as HTMLElement).closest('a')
    if (link) {
      event.preventDefault()
      void api.openExternal(link.getAttribute('href') ?? '')
    } else if (selectionMode) {
      onToggle()
    }
  }

  // Phone: drag the bubble to the right to answer it. A move up or down is left to the chat's scrolling.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (selectionMode || event.pointerType === 'mouse') return
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moving: false, offset: 0 }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = swipe.current
    if (!drag || drag.id !== event.pointerId) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moving) {
      // Mostly vertical: the chat scrolls, there is no swipe.
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        swipe.current = null
        return
      }
      if (dx < 8) return
      drag.moving = true
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // the pointer is gone already
      }
    }
    drag.offset = Math.max(0, Math.min(dx, SWIPE_PX * 1.5))
    setOffset(drag.offset)
  }
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = swipe.current
    if (!drag || drag.id !== event.pointerId) return
    swipe.current = null
    setOffset(0)
    if (drag.moving && drag.offset >= SWIPE_PX) onReply()
  }

  return (
    <div
      className={`message-row ${message.mine ? 'mine' : 'theirs'} ${selectionMode ? 'selecting' : ''} ${selected ? 'selected' : ''}`}
      onClick={selectionMode ? onToggle : undefined}
      onContextMenu={
        onLongPress
          ? (event) => {
              event.preventDefault()
              onLongPress()
            }
          : undefined
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {selectionMode && <input type="checkbox" className="select-box" checked={selected} onChange={onToggle} onClick={(e) => e.stopPropagation()} />}
      {offset > 0 && (
        <span className="swipe-hint" style={{ opacity: Math.min(1, offset / SWIPE_PX) }} aria-hidden="true">
          <Icon name="reply" size={18} />
        </span>
      )}
      <div className="bubble" ref={bubble} data-message={message.id} style={offset ? { transform: `translateX(${offset}px)`, transition: 'none' } : undefined}>
        {showSender && !message.mine && <div className="bubble-sender">{message.fromName}</div>}
        {message.reply && (
          <div
            className="bubble-quote"
            title={t('chat.reply_show')}
            onClick={(event) => {
              if (selectionMode) return
              event.stopPropagation()
              onQuote(message.reply!.id)
            }}
          >
            <div className="quote-name">{message.reply.fromName || t('chat.reply_me')}</div>
            <div className="quote-text">{message.reply.text}</div>
          </div>
        )}
        {message.broken && !message.file ? (
          <div className="muted">{t('chat.undecryptable')}</div>
        ) : message.file ? (
          <FileOfferCard message={message} done={transferDone} />
        ) : (
          <div className="bubble-text editor-html" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        )}
        <div className="bubble-meta muted">
          <span>{formatTime(message.ts, settings.language)}</span>
          <StatusMark message={message} />
        </div>
      </div>
    </div>
  )
}

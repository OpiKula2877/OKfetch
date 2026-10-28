import { Icon } from '../components/Icon'
import { useApp } from '../context'

interface Props {
  count: number
  /** False when the selection contains a message written by the other side. */
  canDeleteBoth: boolean
  onCopy: () => void
  /** Answer the selected message: offered only when exactly one message is selected. */
  onReply: () => void
  onDeleteMe: () => void
  onDeleteBoth: () => void
  onCancel: () => void
}

/** Desktop: one row. Phone: the count, then Reply and Copy, then the three buttons below (mobile.css). */
export function SelectionBar({ count, canDeleteBoth, onCopy, onReply, onDeleteMe, onDeleteBoth, onCancel }: Props) {
  const { t } = useApp()
  return (
    <div className="selection-bar">
      <span className="selection-count grow">{t('chat.selected', { n: count })}</span>
      <div className="selection-head">
        {count === 1 && (
          <button type="button" onClick={onReply}>
            <Icon name="reply" size={16} /> {t('chat.reply')}
          </button>
        )}
        <button type="button" disabled={count === 0} onClick={onCopy}>
          <Icon name="copy" size={16} /> {t('chat.copy')}
        </button>
      </div>
      <div className="selection-actions">
        <button type="button" disabled={count === 0} title={t('chat.delete_me')} aria-label={t('chat.delete_me')} onClick={onDeleteMe}>
          <Icon name="trash" size={16} /> {t('chat.delete_me_short')}
        </button>
        <button
          type="button"
          className="danger-outline"
          disabled={count === 0 || !canDeleteBoth}
          title={canDeleteBoth ? t('chat.delete_both') : t('chat.delete_both_locked')}
          aria-label={t('chat.delete_both')}
          onClick={onDeleteBoth}
        >
          <Icon name="trash" size={16} /> {t('chat.delete_both_short')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

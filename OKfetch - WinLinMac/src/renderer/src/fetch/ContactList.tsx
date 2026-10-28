import { useState } from 'react'
import { contactChatId, groupChatId, type ChatKind, type ContactView, type GroupView } from '../../../shared/model'
import { Avatar } from '../components/Avatar'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { Icon, IconButton } from '../components/Icon'
import { useApp } from '../context'
import { api } from '../api'
import { usePhone } from '../mobile/phone'

interface Props {
  contacts: ContactView[]
  groups: GroupView[]
  query: string
  activeChat: string | null
  onOpen: (chatId: string) => void
  onRename: (contact: ContactView) => void
  onIcon: (contact: ContactView) => void
  onIconRemove: (contact: ContactView) => void
  onVerify: (contact: ContactView) => void
  onBlock: (contact: ContactView) => void
  onUnblock: (contact: ContactView) => void
  onRemove: (contact: ContactView) => void
  onGroupSettings: (group: GroupView) => void
  onLeaveGroup: (group: GroupView) => void
}

interface Menu {
  x: number
  y: number
  items: MenuItem[]
}

export function ContactList(props: Props) {
  const { t } = useApp()
  const phone = usePhone()
  const [menu, setMenu] = useState<Menu | null>(null)
  const needle = props.query.trim().toLocaleLowerCase()
  const contacts = props.contacts
    .filter((c) => !needle || `${c.name} ${c.username}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  const groups = props.groups
    .filter((g) => g.state === 'active' && (!needle || g.name.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))

  const contactItems = (contact: ContactView): MenuItem[] => [
    { label: contact.pinned ? t('chat.unpin') : t('chat.pin'), onSelect: () => void api.setChatFlags(contactChatId(contact.pub, 'enc'), { pinned: !contact.pinned }) },
    { label: contact.muted ? t('chat.unmute') : t('chat.mute'), onSelect: () => void api.setChatFlags(contactChatId(contact.pub, 'enc'), { muted: !contact.muted }) },
    { label: t('contact.rename'), onSelect: () => props.onRename(contact), separatorBefore: true },
    { label: t('contact.icon'), onSelect: () => props.onIcon(contact) },
    { label: t('contact.icon_remove'), onSelect: () => props.onIconRemove(contact) },
    { label: t('contact.verify'), onSelect: () => props.onVerify(contact) },
    contact.blocked ? { label: t('contact.unblock'), onSelect: () => props.onUnblock(contact), separatorBefore: true } : { label: t('contact.block'), onSelect: () => props.onBlock(contact), separatorBefore: true },
    { label: t('contact.remove'), onSelect: () => props.onRemove(contact), danger: true }
  ]
  const groupItems = (group: GroupView): MenuItem[] => [
    { label: group.pinned ? t('chat.unpin') : t('chat.pin'), onSelect: () => void api.setChatFlags(groupChatId(group.id), { pinned: !group.pinned }) },
    { label: group.muted ? t('chat.unmute') : t('chat.mute'), onSelect: () => void api.setChatFlags(groupChatId(group.id), { muted: !group.muted }) },
    { label: t('group.settings'), onSelect: () => props.onGroupSettings(group), separatorBefore: true },
    { label: t('group.leave'), onSelect: () => props.onLeaveGroup(group), danger: true, separatorBefore: true }
  ]

  // Desktop: right-click on the row. Phone: a gear button beside the row (a long press opens nothing there).
  const rightClick = (event: React.MouseEvent, items: MenuItem[]): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, items })
  }
  const gearClick = (event: React.MouseEvent<HTMLButtonElement>, items: MenuItem[]): void => {
    event.stopPropagation()
    const box = event.currentTarget.getBoundingClientRect()
    setMenu({ x: box.right, y: box.bottom, items })
  }

  const kindRow = (contact: ContactView, kind: ChatKind) => {
    const chatId = contactChatId(contact.pub, kind)
    const unread = contact.unread[kind]
    return (
      <button key={kind} type="button" className={`kind-row ${props.activeChat === chatId ? 'selected' : ''}`} onClick={() => props.onOpen(chatId)}>
        <Icon name={kind === 'enc' ? 'lock' : 'unlock'} size={13} />
        <span className="grow">{t(kind === 'enc' ? 'contact.chat_enc' : 'contact.chat_plain')}</span>
        {unread > 0 && <span className="badge">{unread}</span>}
      </button>
    )
  }

  return (
    <div className="contact-list">
      <div className="section-title muted">{t('list.contacts')}</div>
      {contacts.length === 0 && <div className="empty-hint muted">{t(needle ? 'list.no_match' : 'list.no_contacts')}</div>}
      {contacts.map((contact) => (
        <div key={contact.pub} className={`contact ${contact.blocked ? 'blocked' : ''}`} onContextMenu={phone ? undefined : (e) => rightClick(e, contactItems(contact))}>
          <div className="contact-head">
            <Avatar name={contact.name} src={contact.avatar} online={contact.online} />
            <div className="contact-names">
              <div className="item-title">
                {contact.name}
                {contact.verified && <span className="verified" title={t('contact.verified')}><Icon name="shield" size={13} /></span>}
                {contact.pinned && <Icon name="pin" size={12} />}
                {contact.muted && <Icon name="bell_off" size={12} />}
              </div>
              <div className="item-sub">{contact.blocked ? t('contact.blocked') : contact.online && contact.via === 'relay' ? t('status.online_relay') : t(contact.online ? 'status.online' : 'status.offline')}</div>
            </div>
            {phone && <IconButton icon="gear" label={t('list.options')} size={18} className="row-options" onClick={(e) => gearClick(e, contactItems(contact))} />}
          </div>
          {!contact.blocked && (
            <div className="kind-rows">
              {kindRow(contact, 'enc')}
              {kindRow(contact, 'plain')}
            </div>
          )}
        </div>
      ))}
      <div className="section-title muted">{t('list.groups')}</div>
      {groups.length === 0 && <div className="empty-hint muted">{t(needle ? 'list.no_match' : 'list.no_groups')}</div>}
      {groups.map((group) => {
        const chatId = groupChatId(group.id)
        return (
          <div
            key={group.id}
            className={`contact group-row ${props.activeChat === chatId ? 'selected' : ''}`}
            onClick={() => props.onOpen(chatId)}
            onContextMenu={phone ? undefined : (event) => rightClick(event, groupItems(group))}
          >
            <div className="contact-head">
              <Avatar name={group.name} group size={34} />
              <div className="contact-names">
                <div className="item-title">
                  {group.type === 'enc' && <Icon name="lock" size={13} />} {group.name}
                  {group.pinned && <Icon name="pin" size={12} />}
                  {group.muted && <Icon name="bell_off" size={12} />}
                </div>
                <div className="item-sub">{t('group.members_online', { online: group.members.filter((m) => m.online).length, total: group.members.length })}</div>
              </div>
              {group.unread > 0 && <span className="badge">{group.unread}</span>}
              {phone && <IconButton icon="gear" label={t('list.options')} size={18} className="row-options" onClick={(e) => gearClick(e, groupItems(group))} />}
            </div>
          </div>
        )
      })}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

import { useNavigate } from 'react-router-dom';
import type { Notification } from '@projekttool/shared';
import { api, fmtDateTime } from '../lib/api';
import { useOpenChat } from './Messenger';

/**
 * Meldung öffnen (Glocke und Dashboard): ungelesene zuerst als gelesen markieren, dann Chat-Links im Messenger öffnen
 * (Desktop als Overlay, alte Projektchat-Links eingeschlossen), sonst zum Link navigieren.
 */
export function useOpenNotification() {
  const nav = useNavigate();
  const openChat = useOpenChat();
  return async (n: Notification) => {
    if (!n.readAt) await api.post('/notifications/read', { ids: [n.id] }).catch(() => undefined);
    const m = n.link?.match(/^\/chat\/([0-9a-f-]{36})(?:\?thread=([0-9a-f-]{36}))?/);
    if (m) { openChat(m[1], m[2] ?? null); return; }
    if (n.link) nav(n.link);
  };
}

/** Meldung im Dashboard: Klick markiert sie als gelesen und öffnet das Ziel wie in der Glocke. */
export function NotificationRow({ n, onOpened }: { n: Notification; onOpened?: () => void }) {
  const open = useOpenNotification();
  const go = (e?: { preventDefault(): void }) => { e?.preventDefault(); void open(n).then(() => onOpened?.()); };
  return (
    <div className={`notif ${n.readAt ? '' : 'unread'}`} style={{ padding: '6px 0', cursor: 'pointer' }} role="button" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go(e); }}>
      <div className="t">{n.link ? <a href={n.link}>{n.title}</a> : n.title}</div>
      <div className="b muted small">{fmtDateTime(n.createdAt)}</div>
    </div>
  );
}

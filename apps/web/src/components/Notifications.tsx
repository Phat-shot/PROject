import { useNavigate } from 'react-router-dom';
import type { Notification } from '@projekttool/shared';
import { api, fmtDateTime } from '../lib/api';
import { useOpenChat } from './Messenger';
import { NOTIFY_EVENTS } from '@projekttool/shared';

/** Klasse der Meldung als kurzes Präfix („Eskalation · “), leer bei Information. */
export const eventLabel = (n: Notification) => (n.event && n.event !== 'info' ? `${NOTIFY_EVENTS.find((e) => e.key === n.event)?.label ?? n.event} · ` : '');

/**
 * openNotification() – gemeinsamer Handler von Glocke und Dashboard: ungelesene zuerst als gelesen markieren (gesehen,
 * nicht erledigt), dann per Deep-Link öffnen: Chat-Kanal oder Thread im Messenger (Desktop als Overlay; aus dem Link oder
 * dem Bezug der Meldung), sonst zum Link navigieren.
 */
export function useOpenNotification() {
  const nav = useNavigate();
  const openChat = useOpenChat();
  return async function openNotification(n: Notification) {
    if (!n.readAt) await api.post('/notifications/read', { ids: [n.id] }).catch(() => undefined);
    const m = n.link?.match(/^\/chat\/([0-9a-f-]{36})(?:\?(?:.*&)?thread=([0-9a-f-]{36}))?/);
    const msg = n.link?.match(/[?&]msg=([0-9a-f-]{36})/);
    if (m) { openChat(m[1], m[2] ?? null, msg?.[1] ?? null); return; }
    if (n.ref?.type === 'chat_channel') { openChat(n.ref.id, null); return; }
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
      <div className="b muted small">{eventLabel(n)}{fmtDateTime(n.createdAt)}</div>
    </div>
  );
}

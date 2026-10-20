import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Notification, NotifyEvent } from '@projekttool/shared';
import { api, fmtDateTime } from '../lib/api';
import { useOpenChat } from './Messenger';
import { NOTIFY_EVENTS } from '@projekttool/shared';

/** Ungelesene zuerst, darin und danach neu vor alt. */
export const sortNotifications = (list: Notification[]) =>
  [...list].sort((a, b) => Number(Boolean(a.readAt)) - Number(Boolean(b.readAt)) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

// Linien-Icons (24er Raster, Strichstärke 2) je Ereignisklasse
const ICON: Record<NotifyEvent | 'bell', ReactNode> = {
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></>,
  question: <><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>,
  decision: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="9" r="3" /><path d="M6 9v6" /><path d="M18 12a6 6 0 0 1-6 6H9" /></>,
  approval: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>,
  synergy: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  confirm: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /><path d="M12 14v3" /></>,
  order_request: <><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M12 11v6M9 14h6" /></>,
  external_referral: <><path d="M9 14 4 9l5-5" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></>,
  progress: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  assigned: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></>,
  blocked: <><circle cx="12" cy="12" r="10" /><path d="m4.93 4.93 14.14 14.14" /></>,
  escalation: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></>,
  review: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>,
  mail_in: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 6-10 7L2 6" /></>,
  log: <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  due: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  booking: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>
};
export function NotifIcon({ event, size = 16 }: { event: NotifyEvent | 'bell'; size?: number }) {
  return <svg className="notif-ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[event] ?? ICON.info}</svg>;
}
const eventOf = (n: Notification): NotifyEvent => n.event ?? 'info';

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

/** Meldung in der Glocke: Icon der Klasse, Titel, Text, Klasse und Zeit. */
export function NotificationItem({ n, onOpen }: { n: Notification; onOpen: (n: Notification) => void }) {
  return (
    <div className={`notif ev-${eventOf(n)} ${n.readAt ? '' : 'unread'}`} role="button" tabIndex={0} onClick={() => onOpen(n)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(n); }}>
      <NotifIcon event={eventOf(n)} />
      <div className="c">
        <div className="t">{n.title}</div>
        {n.body && <div className="b">{n.body}</div>}
        <div className="b">{eventLabel(n)}{fmtDateTime(n.createdAt)}{n.ref?.type === 'question' && !n.resolvedAt ? ' · offen' : ''}</div>
      </div>
    </div>
  );
}

/** Meldung im Dashboard: Klick markiert sie als gelesen und öffnet das Ziel wie in der Glocke. */
export function NotificationRow({ n, onOpened }: { n: Notification; onOpened?: () => void }) {
  const open = useOpenNotification();
  const go = (e?: { preventDefault(): void }) => { e?.preventDefault(); void open(n).then(() => onOpened?.()); };
  return (
    <div className={`notif ev-${eventOf(n)} ${n.readAt ? '' : 'unread'}`} role="button" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go(e); }}>
      <NotifIcon event={eventOf(n)} />
      <div className="c">
        <div className="t">{n.link ? <a href={n.link}>{n.title}</a> : n.title}</div>
        <div className="b">{eventLabel(n)}{fmtDateTime(n.createdAt)}</div>
      </div>
    </div>
  );
}

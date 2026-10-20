import { useEffect, useState } from 'react';
import { api } from './api';

export interface MailUnread { total: number; byProject: Record<string, number> }
const EMPTY: MailUnread = { total: 0, byProject: {} };
let cache: MailUnread = EMPTY;
const listeners = new Set<(u: MailUnread) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
const load = () => api.get<MailUnread>('/mail/unread').then((u) => { cache = u; listeners.forEach((l) => l(u)); }).catch(() => undefined);

/** Ungelesene Mails (gesamt und je Projekt), alle 30 s und beim Fokus neu; refreshMailUnread() nach dem Öffnen einer Mail. */
export function useMailUnread(): MailUnread {
  const [u, setU] = useState<MailUnread>(cache);
  useEffect(() => {
    listeners.add(setU);
    if (!timer) { void load(); timer = setInterval(load, 30_000); window.addEventListener('focus', () => void load()); }
    return () => { listeners.delete(setU); };
  }, []);
  return u;
}
export function refreshMailUnread() { void load(); }

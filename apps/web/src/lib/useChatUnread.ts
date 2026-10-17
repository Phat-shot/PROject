import { useEffect, useState } from 'react';
import { api } from './api';

export interface ChatUnread { dm: number; projects: Record<string, number>; total: number }
const EMPTY: ChatUnread = { dm: 0, projects: {}, total: 0 };

/** Ungelesene Chat-Nachrichten (Direktnachrichten und je Projekt), alle 20 s aktualisiert. */
export function useChatUnread(): ChatUnread {
  const [u, setU] = useState<ChatUnread>(EMPTY);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<ChatUnread>('/chat/unread').then((x) => { if (alive) setU(x); }).catch(() => undefined);
    void load();
    const h = setInterval(load, 20_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(h); window.removeEventListener('focus', onFocus); };
  }, []);
  return u;
}

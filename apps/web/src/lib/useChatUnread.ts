import { useEffect, useState } from 'react';
import { api } from './api';

export interface ChatUnread { dm: number; projects: Record<string, number>; total: number }
const EMPTY: ChatUnread = { dm: 0, projects: {}, total: 0 };

/** Ungelesene Chat-Nachrichten (Direktnachrichten und je Projekt), alle 20 s aktualisiert; reload() frischt sofort auf. */
export function useChatUnread(): ChatUnread & { reload: () => void } {
  const [u, setU] = useState<ChatUnread>(EMPTY);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<ChatUnread>('/chat/unread').then((x) => { if (alive) setU(x); }).catch(() => undefined);
    void load();
    const h = setInterval(load, 20_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(h); window.removeEventListener('focus', onFocus); };
  }, [tick]);
  return { ...u, reload: () => setTick((x) => x + 1) };
}

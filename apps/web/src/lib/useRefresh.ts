import { useEffect, useRef } from 'react';
import { CHANGED } from './events';

/**
 * Daten aktuell halten ohne Neuladen der Seite: nach eigenen Änderungen (gebündelt), beim Zurückkehren ins Fenster und
 * im Takt für Änderungen anderer (Agenten, Worker).
 */
export function useRefresh(fn: () => unknown, intervalMs = 30_000) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (t) clearTimeout(t); t = setTimeout(() => void ref.current(), 400); };
    const tick = setInterval(() => { if (document.visibilityState !== 'hidden') void ref.current(); }, intervalMs);
    window.addEventListener(CHANGED, soon);
    window.addEventListener('focus', soon);
    return () => { if (t) clearTimeout(t); clearInterval(tick); window.removeEventListener(CHANGED, soon); window.removeEventListener('focus', soon); };
  }, [intervalMs]);
}

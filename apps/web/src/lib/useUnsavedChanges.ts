import { useEffect } from 'react';
import { useBlocker, type Blocker } from 'react-router-dom';
import { useDialog } from '../components/ui';

/**
 * Schutz vor Verlust ungespeicherter Eingaben: warnt beim Schließen/Neuladen des Tabs (beforeunload) und fragt bei
 * Navigation innerhalb der App nach („Eingaben verwerfen?“). Die In-App-Sperre braucht den Data-Router (main.tsx);
 * ohne ihn (Tests mit MemoryRouter) bleibt nur die Browser-Warnung.
 */
export function useUnsavedChanges(dirty: boolean) {
  const dialog = useDialog();
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  let blocker: Blocker | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  } catch { blocker = null; }
  const state = blocker?.state ?? 'unblocked';
  useEffect(() => {
    if (!blocker || blocker.state !== 'blocked') return;
    void dialog.confirm({ title: 'Eingaben verwerfen?', text: 'Ungespeicherte Eingaben gehen verloren.', confirmLabel: 'Verwerfen', danger: true }).then((ok) => { if (ok) blocker.proceed(); else blocker.reset(); });
  }, [state]);
}

import { useEffect, useState } from 'react';

/** true unter 900 px Breite (Telefon, schmales Tablet): Panels stapeln sich, Listen statt Raster. */
export function useIsMobile(query = '(max-width: 900px)'): boolean {
  const [m, setM] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const q = window.matchMedia(query);
    const h = () => setM(q.matches);
    q.addEventListener('change', h);
    return () => q.removeEventListener('change', h);
  }, [query]);
  return m;
}

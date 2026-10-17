/** Board-Filter in der URL: teilbar, Zurück-Taste funktioniert. */
export interface BoardFilter { q: string; member: string; label: string; mine: boolean; overdue: boolean; conflicts: boolean; prio: string; archived: boolean; escalated: boolean }
export const EMPTY_FILTER: BoardFilter = { q: '', member: '', label: '', mine: false, overdue: false, conflicts: false, prio: '', archived: false, escalated: false };
const FLAGS: (keyof BoardFilter)[] = ['mine', 'overdue', 'conflicts', 'archived', 'escalated'];

export function readFilter(p: URLSearchParams): BoardFilter {
  const f: BoardFilter = { ...EMPTY_FILTER, q: p.get('q') ?? '', member: p.get('person') ?? '', label: p.get('label') ?? '', prio: p.get('prio') ?? '' };
  for (const k of FLAGS) if (p.get(k) === '1') (f as any)[k] = true;
  return f;
}

export function writeFilter(p: URLSearchParams, f: BoardFilter): URLSearchParams {
  const n = new URLSearchParams(p);
  const set = (k: string, v: string) => { if (v) n.set(k, v); else n.delete(k); };
  set('q', f.q); set('person', f.member); set('label', f.label); set('prio', f.prio);
  for (const k of FLAGS) set(k, f[k] ? '1' : '');
  return n;
}

export const isFilterActive = (f: BoardFilter) => Boolean(f.q || f.member || f.label || f.mine || f.overdue || f.conflicts || f.prio || f.escalated);

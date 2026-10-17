import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, isFilterActive, readFilter, writeFilter } from './boardFilter';

describe('Board-Filter in der URL', () => {
  it('liest und schreibt alle Felder symmetrisch', () => {
    const f = { ...EMPTY_FILTER, q: 'design', member: 'u1', label: 'l1', prio: 'high', mine: true, overdue: true };
    const p = writeFilter(new URLSearchParams('task=abc'), f);
    expect(p.get('task')).toBe('abc');
    expect(p.get('person')).toBe('u1');
    expect(p.get('mine')).toBe('1');
    expect(p.get('conflicts')).toBeNull();
    expect(readFilter(p)).toEqual(f);
  });
  it('leerer Filter entfernt die Parameter wieder', () => {
    const p = writeFilter(writeFilter(new URLSearchParams(), { ...EMPTY_FILTER, q: 'x', archived: true }), EMPTY_FILTER);
    expect([...p.keys()]).toEqual([]);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, escalated: true })).toBe(true);
  });
});

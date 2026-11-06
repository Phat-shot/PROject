import { describe, expect, it } from 'vitest';
import { addMonths, formatDe, isoWeek, monthGrid, mondayOfWeek, parseDateInput } from './dates';

describe('Datumseingabe (Parser des Datumswählers)', () => {
  const today = '2026-11-06'; // Freitag
  it.each([
    ['12.11.2026', '2026-11-12'], ['12.11.26', '2026-11-12'], ['12.11.', '2026-11-12'], ['12.11', '2026-11-12'], ['1.2.2027', '2027-02-01'],
    ['2026-11-12', '2026-11-12'], ['12112026', '2026-11-12'], ['heute', today], ['Heute', today], ['morgen', '2026-11-07'], ['übermorgen', '2026-11-08'],
    ['gestern', '2026-11-05'], ['+3', '2026-11-09'], ['-2', '2026-11-04'], ['+2w', '2026-11-20'], ['+1m', '2026-12-06'],
    ['Fr', today], ['Mo', '2026-11-09'], ['montag', '2026-11-09'], ['Do', '2026-11-12'], ['KW 47', '2026-11-16'], ['kw1/2027', '2027-01-04'],
    // „05.01.“ im November: liegt mehr als ein halbes Jahr zurück → nächstes Jahr
    ['05.01.', '2027-01-05'], ['', '']
  ])('„%s“ → %s', (input, out) => expect(parseDateInput(input, today)).toBe(out));
  it.each(['31.02.2026', '32.1.', 'irgendwann', '13/13/2026', 'KW 60'])('„%s“ ist kein Datum', (input) => expect(parseDateInput(input, today)).toBeNull());
  it('KW nach ISO 8601, Anzeige TT.MM.JJJJ, Monatsraster ab Montag', () => {
    expect(isoWeek('2026-11-06')).toBe(45);
    expect(isoWeek('2027-01-01')).toBe(53);
    expect(isoWeek('2026-12-31')).toBe(53);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(mondayOfWeek(2026, 1)).toBe('2025-12-29');
    expect(formatDe('2026-11-06')).toBe('06.11.2026');
    expect(formatDe('')).toBe('');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    const g = monthGrid(2026, 10);
    expect(g[0][0]).toBe('2026-10-26');
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g.flat()).toContain('2026-11-30');
  });
});

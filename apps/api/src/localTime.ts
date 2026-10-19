/**
 * Ortszeit für Regelläufe des Workers (Digest, später Projektdurchlauf und Buchungen): Datum, Uhrzeit und Wochentag in
 * Europe/Berlin, unabhängig von der Zeitzone des Servers.
 */
export const LOCAL_TZ = 'Europe/Berlin';

export function localParts(d: Date, tz = LOCAL_TZ): { date: string; time: string; weekday: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1 };
}

/**
 * Fällig zur Ortszeit: ab Uhrzeit at (Stunde oder „HH:MM“) heute, wenn last nicht schon heute ab dieser Uhrzeit liegt.
 * weekdays: nur Montag bis Freitag. Ersetzt die feste Digest-Stunde in Serverzeit.
 */
export function dueLocal(now: Date, at: number | string, last?: Date | string | null, opts: { weekdays?: boolean; tz?: string } = {}): boolean {
  const n = localParts(now, opts.tz);
  const atStr = typeof at === 'number' ? `${String(Math.max(0, Math.min(23, Math.floor(at)))).padStart(2, '0')}:00` : at;
  if (opts.weekdays && n.weekday > 5) return false;
  if (n.time < atStr) return false;
  if (!last) return true;
  const l = localParts(new Date(last), opts.tz);
  if (l.date > n.date) return false;
  return !(l.date === n.date && l.time >= atStr);
}

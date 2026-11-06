/**
 * Datumswerte des eigenen Datumswählers: intern ISO (JJJJ-MM-TT, wie <input type="date">), angezeigt deutsch (TT.MM.JJJJ).
 * Rechnen in UTC, damit Sommerzeit und Zeitzone keine Tage verschieben.
 */

const pad = (n: number) => String(n).padStart(2, '0');
export const isoOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const addDays = (iso: string, n: number) => { const d = dateOf(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
export const addMonths = (iso: string, n: number) => {
  const d = dateOf(iso); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return isoOf(d);
};
/** Heute in der lokalen Zeitzone als ISO-Datum. */
export function todayIso(now = new Date()): string { return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
export const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && isoOf(dateOf(v)) === v;

/** TT.MM.JJJJ */
export function formatDe(iso: string | null | undefined): string {
  if (!iso || !isIsoDate(iso.slice(0, 10))) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}
/** Wochentag 0 = Montag … 6 = Sonntag */
export const weekdayMon = (iso: string) => (dateOf(iso).getUTCDay() + 6) % 7;
export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const WEEKDAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** ISO-Kalenderwoche (KW) nach DIN 1355 / ISO 8601. */
export function isoWeek(iso: string): number {
  const thu = dateOf(addDays(iso, 3 - weekdayMon(iso))); // Donnerstag derselben Woche bestimmt das Jahr
  const jan4 = isoOf(new Date(Date.UTC(thu.getUTCFullYear(), 0, 4)));
  const firstThu = dateOf(addDays(jan4, 3 - weekdayMon(jan4)));
  return 1 + Math.round((thu.getTime() - firstThu.getTime()) / (7 * 86400_000));
}
/** Montag der KW n im Jahr y */
export function mondayOfWeek(y: number, n: number): string {
  const jan4 = isoOf(new Date(Date.UTC(y, 0, 4)));
  return addDays(addDays(jan4, -weekdayMon(jan4)), (n - 1) * 7);
}

const WD: Record<string, number> = { mo: 0, montag: 0, di: 1, dienstag: 1, mi: 2, mittwoch: 2, do: 3, donnerstag: 3, fr: 4, freitag: 4, sa: 5, samstag: 5, so: 6, sonntag: 6 };

/**
 * Eingabe in ein ISO-Datum: „12.11.2026“, „12.11.26“, „12.11.“ / „12.11“ (dieses Jahr, liegt das mehr als ein halbes Jahr
 * zurück: nächstes), „2026-11-12“, „heute“, „morgen“, „übermorgen“, „gestern“, „+3“ / „-2“ (Tage), „+2w“ (Wochen), „+1m“
 * (Monate), Wochentag „Fr“ / „Freitag“ (nächster, heute eingeschlossen), „KW 47“ (Montag). '' = leer, null = nicht erkannt.
 */
export function parseDateInput(raw: string, today: string = todayIso()): string | '' | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (s === 'heute' || s === 'h') return today;
  if (s === 'morgen' || s === 'm') return addDays(today, 1);
  if (s === 'übermorgen' || s === 'uebermorgen') return addDays(today, 2);
  if (s === 'gestern') return addDays(today, -1);
  let r = s.match(/^([+-])\s*(\d{1,4})\s*([tdwm]?)$/);
  if (r) {
    const n = Number(r[2]) * (r[1] === '-' ? -1 : 1);
    return r[3] === 'w' ? addDays(today, 7 * n) : r[3] === 'm' ? addMonths(today, n) : addDays(today, n);
  }
  if (s.replace(/\.$/, '') in WD) { const want = WD[s.replace(/\.$/, '')]; return addDays(today, (want - weekdayMon(today) + 7) % 7); }
  r = s.match(/^kw ?(\d{1,2})(?:[ /.](\d{2}|\d{4}))?$/);
  if (r) {
    const wk = Number(r[1]); const y = r[2] ? (r[2].length === 2 ? 2000 + Number(r[2]) : Number(r[2])) : Number(today.slice(0, 4));
    if (wk < 1 || wk > 53) return null;
    const mon = mondayOfWeek(y, wk);
    return isoWeek(mon) === wk ? mon : null;
  }
  r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (r) return valid(Number(r[1]), Number(r[2]), Number(r[3]));
  r = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4})?)?\.?$/);
  if (r) {
    const d = Number(r[1]); const m = Number(r[2]);
    if (r[3]) return valid(r[3].length === 2 ? 2000 + Number(r[3]) : Number(r[3]), m, d);
    const y = Number(today.slice(0, 4));
    const v = valid(y, m, d);
    if (v && v < addMonths(today, -6)) return valid(y + 1, m, d);
    return v;
  }
  // 12112026 oder 121126
  r = s.match(/^(\d{2})(\d{2})(\d{2}|\d{4})$/);
  if (r) return valid(r[3].length === 2 ? 2000 + Number(r[3]) : Number(r[3]), Number(r[2]), Number(r[1]));
  return null;
}

function valid(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isIsoDate(iso) ? iso : null;
}

/** Wochen eines Monats (Montag bis Sonntag), mit Tagen der Nachbarmonate aufgefüllt. */
export function monthGrid(year: number, month: number): string[][] {
  const first = isoOf(new Date(Date.UTC(year, month, 1)));
  let cur = addDays(first, -weekdayMon(first));
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) { week.push(cur); cur = addDays(cur, 1); }
    weeks.push(week);
    if (dateOf(cur).getUTCMonth() !== month) break;
  }
  return weeks;
}

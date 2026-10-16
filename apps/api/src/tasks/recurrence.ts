export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly' | 'monthly_weekday';
  interval?: number;
  /** monthly_weekday: n-ter Wochentag im Monat, z. B. 1. Montag → nth 1, weekday 1 (0 = Sonntag) */
  nth?: number;
  weekday?: number;
  /** on_due: nächste Instanz entsteht lead_days vor Fälligkeit; after_done: nach Erledigung */
  mode: 'on_due' | 'after_done';
  leadDays?: number;
}

const DAY = 86400_000;

export function nextDueDate(current: string, r: Recurrence): string {
  const d = new Date(current + 'T00:00:00Z');
  const n = Math.max(1, r.interval ?? 1);
  switch (r.freq) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + n);
      break;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7 * n);
      break;
    case 'monthly': {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + n);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      break;
    }
    case 'monthly_weekday': {
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + n);
      const wd = r.weekday ?? 1;
      const nth = Math.max(1, r.nth ?? 1);
      const offset = (wd - d.getUTCDay() + 7) % 7;
      d.setUTCDate(1 + offset + (nth - 1) * 7);
      break;
    }
  }
  return d.toISOString().slice(0, 10);
}

export function shouldCreateOnDue(due: string, r: Recurrence, today: string): boolean {
  const lead = Math.max(0, r.leadDays ?? 0);
  const trigger = new Date(new Date(due + 'T00:00:00Z').getTime() - lead * DAY).toISOString().slice(0, 10);
  return today >= trigger;
}

export function describeRecurrence(r: Recurrence): string {
  const n = r.interval ?? 1;
  const every = n === 1 ? 'jede' : `alle ${n}`;
  const names = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const base =
    r.freq === 'daily' ? (n === 1 ? 'täglich' : `alle ${n} Tage`)
    : r.freq === 'weekly' ? (n === 1 ? 'wöchentlich' : `${every} ${n} Wochen`)
    : r.freq === 'monthly' ? (n === 1 ? 'monatlich' : `alle ${n} Monate`)
    : `jeden ${r.nth ?? 1}. ${names[r.weekday ?? 1]} im Monat`;
  return `${base}, ${r.mode === 'after_done' ? 'nächste nach Erledigung' : `nächste ${r.leadDays ?? 0} Tage vor Fälligkeit`}`;
}

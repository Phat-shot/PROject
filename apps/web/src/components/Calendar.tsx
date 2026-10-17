import { useMemo, useState } from 'react';
import { today } from '../lib/api';
import { useIsMobile } from '../lib/useMedia';

export interface CalItem {
  id: string;
  kind: 'task' | 'ms' | 'meeting';
  /** Uhrzeit (nur Besprechungen) */
  time?: string;
  title: string;
  /** Beginn (nur Arbeitspakete mit Start); läuft bis date */
  start: string | null;
  /** Deadline bzw. Meilenstein-Datum */
  date: string;
  done?: boolean;
  projectKey?: string;
  onOpen?: () => void;
}

type Mode = 'month' | 'week' | 'agenda';
const MODES: [Mode, string][] = [['month', 'Monat'], ['week', 'Woche'], ['agenda', 'Agenda']];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monday = (d: Date) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));

/**
 * Kalender mit Monat, Woche und Agenda. Deadlines und Meilensteine stehen am Tag, Arbeitspakete mit Start
 * erscheinen am Starttag (▶) und in der Wochenansicht an jedem laufenden Tag; Besprechungen mit Uhrzeit. Auf dem Telefon startet die Agenda.
 */
export function Calendar({ items, hint }: { items: CalItem[]; hint?: string }) {
  const mobile = useIsMobile();
  const [mode, setMode] = useState<Mode>(() => { try { return (localStorage.getItem('pt_cal_mode') as Mode) || (mobile ? 'agenda' : 'month'); } catch { return mobile ? 'agenda' : 'month'; } });
  const setModeKeep = (m: Mode) => { setMode(m); try { localStorage.setItem('pt_cal_mode', m); } catch { /* ignore */ } };
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); });
  const t = today();

  const byDay = useMemo(() => {
    const m = new Map<string, { item: CalItem; role: 'due' | 'start' | 'running' }[]>();
    const push = (k: string, v: { item: CalItem; role: 'due' | 'start' | 'running' }) => m.set(k, [...(m.get(k) ?? []), v]);
    for (const it of items) {
      push(it.date, { item: it, role: 'due' });
      if (it.start && it.start < it.date) push(it.start, { item: it, role: 'start' });
    }
    return m;
  }, [items]);
  const running = (day: string) => items.filter((it) => it.start && it.start < day && day < it.date && !it.done);

  const range = useMemo(() => {
    if (mode === 'week') { const s = monday(cursor); return { start: s, days: Array.from({ length: 7 }, (_, i) => addDays(s, i)), label: `KW ${isoWeek(s)} · ${s.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} – ${addDays(s, 6).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}` }; }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const s = monday(first);
    return { start: s, days: Array.from({ length: 42 }, (_, i) => addDays(s, i)), label: first.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) };
  }, [cursor, mode]);
  const step = (n: number) => setCursor(mode === 'week' ? addDays(cursor, 7 * n) : new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));

  const Ev = ({ item, role }: { item: CalItem; role: 'due' | 'start' | 'running' }) => (
    <span className={`ev ${item.kind} ${role} ${item.done ? 'done' : ''} ${!item.done && item.kind === 'task' && item.date < t && role === 'due' ? 'overdue' : ''}`}
      title={`${item.title}${item.start ? ` · ${item.start.split('-').reverse().join('.')} – ${item.date.split('-').reverse().join('.')}` : ''}`} onClick={item.onOpen}>
      {role === 'start' ? '▶ ' : role === 'running' ? '· ' : item.kind === 'ms' ? '◆ ' : item.kind === 'meeting' ? `${item.time ?? ''} ` : ''}{item.projectKey && <b>{item.projectKey} </b>}{item.title}
    </span>
  );

  const agendaDays = (mode === 'agenda' ? range.days.filter((d) => d.getMonth() === cursor.getMonth()) : []).filter((d) => (byDay.get(iso(d)) ?? []).length > 0);
  return (
    <div className="calendar">
      <div className="row mb">
        <button className="btn sm" onClick={() => step(-1)}>‹</button>
        <strong style={{ minWidth: 160, textAlign: 'center' }}>{range.label}</strong>
        <button className="btn sm" onClick={() => step(1)}>›</button>
        <button className="btn sm" onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), d.getDate())); }}>Heute</button>
        <span className="row" style={{ gap: 2 }}>{MODES.map(([m, l]) => <button key={m} className={`chip ${mode === m ? 'on' : ''}`} onClick={() => setModeKeep(m)}>{l}</button>)}</span>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      {mode === 'agenda' && (
        <div className="cal-agenda">
          {agendaDays.length === 0 && <div className="empty">Keine Termine in diesem Monat.</div>}
          {agendaDays.map((d) => { const k = iso(d); return (
            <div key={k} className={`day ${k === t ? 'today' : ''}`}>
              <div className="d">{d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</div>
              {(byDay.get(k) ?? []).map((e, i) => <Ev key={e.item.kind + e.item.id + i} {...e} />)}
            </div>
          ); })}
        </div>
      )}
      {mode === 'week' && (
        <div className="cal cal-week">
          {range.days.map((d) => { const k = iso(d); return (
            <div key={k} className={`day ${k === t ? 'today' : ''}`}>
              <span className="n">{d.toLocaleDateString('de-DE', { weekday: 'short' })} {d.getDate()}.</span>
              {(byDay.get(k) ?? []).map((e, i) => <Ev key={e.item.kind + e.item.id + i} {...e} />)}
              {running(k).map((it) => <Ev key={'r' + it.id} item={it} role="running" />)}
            </div>
          ); })}
        </div>
      )}
      {mode === 'month' && (
        <div className="cal">
          {['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => <div key={d} className="hd">{d}</div>)}
          {range.days.map((d) => { const k = iso(d); return (
            <div key={k} className={`day ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${k === t ? 'today' : ''}`}>
              <span className="n">{d.getDate()}</span>
              {(byDay.get(k) ?? []).map((e, i) => <Ev key={e.item.kind + e.item.id + i} {...e} />)}
            </div>
          ); })}
        </div>
      )}
    </div>
  );
}

function isoWeek(d: Date): number {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x.getTime() - y0.getTime()) / 86400_000 + 1) / 7);
}

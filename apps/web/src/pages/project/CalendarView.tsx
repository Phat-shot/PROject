import { useMemo, useState } from 'react';
import { today } from '../../lib/api';
import { useProject } from '../ProjectPage';

export function CalendarView() {
  const { detail, tasks, openTask } = useProject();
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const t = today();
  const days = useMemo(() => {
    const first = new Date(cursor);
    const startOffset = (first.getDay() + 6) % 7; // Montag zuerst
    const start = new Date(first); start.setDate(first.getDate() - startOffset);
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); out.push(d); }
    return out;
  }, [cursor]);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const byDay = useMemo(() => {
    const m = new Map<string, { kind: 'task' | 'ms'; id: string; title: string; done?: boolean; overdue?: boolean }[]>();
    for (const x of tasks) if (x.dueDate) m.set(x.dueDate, [...(m.get(x.dueDate) ?? []), { kind: 'task', id: x.id, title: x.title, done: x.done, overdue: !x.done && x.dueDate < t }]);
    for (const ms of detail.milestones) m.set(ms.date, [...(m.get(ms.date) ?? []), { kind: 'ms', id: ms.id, title: `◆ ${ms.name}` }]);
    return m;
  }, [tasks, detail.milestones, t]);
  const label = cursor.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  // Agenda (Telefon): nur Tage des Monats mit Einträgen
  const agenda = days.filter((d) => d.getMonth() === cursor.getMonth() && (byDay.get(iso(d)) ?? []).length > 0);
  return (
    <div className="content">
      <div className="row mb">
        <button className="btn sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>‹</button>
        <strong style={{ minWidth: 160, textAlign: 'center' }}>{label}</strong>
        <button className="btn sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>›</button>
        <button className="btn sm" onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Heute</button>
        <span className="muted small">Deadlines und Meilensteine. Kalender-Anbindung (M365, Google, CalDAV) folgt.</span>
      </div>
      <div className="cal-agenda">
        {agenda.length === 0 && <div className="empty">Keine Termine in diesem Monat.</div>}
        {agenda.map((d) => { const k = iso(d); return (
          <div key={k} className={`day ${k === t ? 'today' : ''}`}>
            <div className="d">{d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</div>
            {(byDay.get(k) ?? []).map((e) => <span key={e.kind + e.id} className={`ev ${e.kind} ${e.done ? 'done' : ''} ${e.overdue ? 'overdue' : ''}`} onClick={() => e.kind === 'task' && openTask(e.id)}>{e.title}</span>)}
          </div>
        ); })}
      </div>
      <div className="cal">
        {['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => <div key={d} className="hd">{d}</div>)}
        {days.map((d) => {
          const k = iso(d);
          const ev = byDay.get(k) ?? [];
          return (
            <div key={k} className={`day ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${k === t ? 'today' : ''}`}>
              <span className="n">{d.getDate()}</span>
              {ev.map((e) => <span key={e.kind + e.id} className={`ev ${e.kind} ${e.done ? 'done' : ''} ${e.overdue ? 'overdue' : ''}`} title={e.title} onClick={() => e.kind === 'task' && openTask(e.id)}>{e.title}</span>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

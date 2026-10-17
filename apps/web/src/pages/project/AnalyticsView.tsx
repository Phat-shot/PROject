import { useState } from 'react';
import { downloadCsv, fmtDate } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useAuth } from '../../lib/auth';
import { useProject } from '../ProjectPage';

interface Analytics {
  from: string; to: string;
  weeks: { week: string; created: number; done: number; escalations: number; minutes: number }[];
  throughput: { created: number; done: number };
  cycleTime: { count: number; medianDays: number | null; avgDays: number | null; slowest: { title: string; days: number; subproject: string | null }[] };
  overdue: { total: number; aging: { d1_7: number; d8_30: number; d31: number }; list: { id: string; title: string; dueDate: string; days: number; responsible: string | null; subproject: string | null; priority: string; escalationLevel: number }[] };
  escalations: { total: number; byLevel: { level: number; label: string; count: number }[]; current: { id: string; title: string; level: number; label: string }[] };
  blocked: number;
  bySubproject: { name: string; open: number; done: number; overdue: number; medianCycleDays: number | null }[];
  minutes: number;
}

const hours = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;

/** Auswertung (W9): Durchsatz je Woche, Durchlaufzeit, Verzug nach Alter, Eskalationen, Zeit; Zeitraum wählbar, alles als CSV. */
export function AnalyticsView() {
  const { detail, openTask } = useProject();
  const { timeTracking } = useAuth();
  const [range, setRange] = useState({ from: '', to: '' });
  const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const d = useData<Analytics>(`/projects/${detail.project.id}/analytics${q ? `?${q}` : ''}`, [q]);
  if (d.error) return <div className="content"><div className="error">{d.error}</div></div>;
  if (!d.data) return <div className="content muted">Lade …</div>;
  const a = d.data;
  const max = Math.max(1, ...a.weeks.map((w) => Math.max(w.created, w.done)));
  const showTime = timeTracking && detail.project.timeTrackingEnabled;
  const key = detail.project.key;
  return (
    <div className="content">
      <div className="row mb">
        <label className="field" style={{ margin: 0 }}><span>Von</span><input type="date" value={range.from || a.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label className="field" style={{ margin: 0 }}><span>Bis</span><input type="date" value={range.to || a.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <span className="row" style={{ gap: 2, alignSelf: 'flex-end' }}>
          {[['4 Wochen', 28], ['12 Wochen', 84], ['Quartal', 91], ['Jahr', 365]].map(([l, n]) => <button key={l} className="chip" onClick={() => { const to = new Date(); const from = new Date(to.getTime() - Number(n) * 86400_000); setRange({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }); }}>{l}</button>)}
        </span>
        <button className="btn sm right" onClick={() => downloadCsv(`auswertung_${key}_${a.from}_${a.to}.csv`, ['Woche', 'Angelegt', 'Erledigt', 'Eskalationen', 'Minuten'], a.weeks.map((w) => [w.week, w.created, w.done, w.escalations, w.minutes]))}>CSV Wochen</button>
      </div>
      <div className="kpis mb">
        <div className="kpi"><div className="v">{a.throughput.done}</div><div className="l">erledigt im Zeitraum</div></div>
        <div className="kpi"><div className="v">{a.throughput.created}</div><div className="l">angelegt im Zeitraum</div></div>
        <div className="kpi"><div className="v">{a.cycleTime.medianDays ?? '–'}</div><div className="l">Durchlaufzeit Median (Tage)</div></div>
        <div className={`kpi ${a.overdue.total ? 'bad' : 'ok'}`}><div className="v">{a.overdue.total}</div><div className="l">überfällig heute</div></div>
        <div className={`kpi ${a.escalations.total ? 'warn' : ''}`}><div className="v">{a.escalations.total}</div><div className="l">Eskalationen im Zeitraum</div></div>
        <div className={`kpi ${a.blocked ? 'bad' : ''}`}><div className="v">{a.blocked}</div><div className="l">blockiert heute</div></div>
        {showTime && <div className="kpi"><div className="v">{hours(a.minutes)}</div><div className="l">gebucht im Zeitraum</div></div>}
      </div>
      <div className="card mb">
        <h2>Durchsatz je Woche <span className="muted small" style={{ fontWeight: 400 }}>angelegt (grau) und erledigt (grün)</span></h2>
        <div className="weeks">
          {a.weeks.map((w) => (
            <div key={w.week} className="wk" title={`${w.week}: ${w.created} angelegt, ${w.done} erledigt${w.escalations ? `, ${w.escalations} Eskalationen` : ''}${w.minutes ? `, ${hours(w.minutes)}` : ''}`}>
              <div className="bars"><div className="b created" style={{ height: `${(w.created / max) * 100}%` }} /><div className="b done" style={{ height: `${(w.done / max) * 100}%` }} /></div>
              <div className="l">{w.week.slice(5)}{w.escalations > 0 && <span className="esc" title={`${w.escalations} Eskalationen`}>!</span>}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid cols-2 mb">
        <div className="card">
          <div className="row between"><h2 style={{ margin: 0 }}>Verzug nach Alter</h2><button className="btn sm" onClick={() => downloadCsv(`ueberfaellig_${key}.csv`, ['Arbeitspaket', 'Fällig', 'Tage', 'Zuständig', 'Teilprojekt', 'Priorität', 'Eskalation'], a.overdue.list.map((o) => [o.title, o.dueDate, o.days, o.responsible, o.subproject, o.priority, o.escalationLevel]))}>CSV</button></div>
          <div className="row mt small"><span className="badge">1–7 Tage: {a.overdue.aging.d1_7}</span><span className="badge warn">8–30 Tage: {a.overdue.aging.d8_30}</span><span className="badge danger">über 30 Tage: {a.overdue.aging.d31}</span></div>
          {a.overdue.list.length === 0 && <div className="empty mt">Nichts überfällig.</div>}
          {a.overdue.list.length > 0 && <table className="table mt"><thead><tr><th>Arbeitspaket</th><th>Fällig</th><th>Tage</th><th>Zuständig</th></tr></thead><tbody>
            {a.overdue.list.slice(0, 15).map((o) => <tr key={o.id}><td><button className="btn sm link" onClick={() => openTask(o.id)}>{o.title}</button>{o.escalationLevel > 0 && <span className="badge danger" style={{ marginLeft: 4 }}>Esk. {o.escalationLevel}</span>}</td><td className="nowrap small">{fmtDate(o.dueDate)}</td><td style={{ color: 'var(--danger)', fontWeight: 600 }}>{o.days}</td><td className="small">{o.responsible ?? '–'}</td></tr>)}
          </tbody></table>}
        </div>
        <div className="card">
          <h2>Durchlaufzeit <span className="muted small" style={{ fontWeight: 400 }}>angelegt bis erledigt, {a.cycleTime.count} Arbeitspakete</span></h2>
          <p className="small">Median {a.cycleTime.medianDays ?? '–'} Tage · Durchschnitt {a.cycleTime.avgDays ?? '–'} Tage</p>
          {a.cycleTime.slowest.length > 0 && <><div className="muted small">Längste:</div><ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>{a.cycleTime.slowest.map((s, i) => <li key={i}>{s.title} · {s.days} Tage{s.subproject ? ` · ${s.subproject}` : ''}</li>)}</ul></>}
          <h3 className="mt">Eskalationen</h3>
          {a.escalations.byLevel.length === 0 && <div className="muted small">Keine im Zeitraum.</div>}
          {a.escalations.byLevel.length > 0 && <div className="row small">{a.escalations.byLevel.map((l) => <span key={l.level} className="badge warn">{l.label}: {l.count}</span>)}</div>}
          {a.escalations.current.length > 0 && <div className="small mt"><span className="muted">Aktuell eskaliert:</span> {a.escalations.current.map((c) => <button key={c.id} className="btn sm link" onClick={() => openTask(c.id)}>{c.title} ({c.label})</button>)}</div>}
        </div>
      </div>
      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>Je Teilprojekt</h2><button className="btn sm" onClick={() => downloadCsv(`teilprojekte_${key}.csv`, ['Teilprojekt', 'Offen', 'Erledigt', 'Überfällig', 'Durchlaufzeit Median'], a.bySubproject.map((s) => [s.name, s.open, s.done, s.overdue, s.medianCycleDays]))}>CSV</button></div>
        <table className="table mt"><thead><tr><th>Teilprojekt</th><th>Offen</th><th>Erledigt</th><th>Überfällig</th><th>Fortschritt</th><th>Durchlaufzeit (Median)</th></tr></thead><tbody>
          {a.bySubproject.map((s) => { const total = s.open + s.done; return <tr key={s.name}><td>{s.name}</td><td>{s.open}</td><td>{s.done}</td><td style={s.overdue ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{s.overdue}</td><td style={{ minWidth: 120 }}><div className="bar"><div className="done" style={{ width: `${total ? (s.done / total) * 100 : 0}%` }} /></div></td><td>{s.medianCycleDays ?? '–'}{s.medianCycleDays != null ? ' Tage' : ''}</td></tr>; })}
        </tbody></table>
      </div>
    </div>
  );
}

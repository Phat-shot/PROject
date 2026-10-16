import { useState } from 'react';
import type { TimeEntry } from '@projekttool/shared';
import { api, fmtDate, today } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';

interface TimeData {
  enabled: boolean;
  entries: TimeEntry[];
  byUser: { userId: string; name: string; minutes: number }[];
  bySubproject: { name: string; minutes: number; estimateMinutes: number }[];
  totalMinutes: number | null;
  estimateMinutes: number;
  budgetHours: number | null;
}

export const fmtH = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} h`;

export function TimeView() {
  const { detail, tasks, reload, openTask } = useProject();
  const me = detail.project.myMembership;
  const [range, setRange] = useState({ from: '', to: '', userId: '' });
  const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const d = useData<TimeData>(`/projects/${detail.project.id}/time${q ? `?${q}` : ''}`, [q]);
  const [f, setF] = useState({ taskId: '', date: today(), hours: '', minutes: '', note: '' });
  const { busy, error, run } = useAsync();
  if (!d.data) return <div className="content muted">Lade …</div>;
  if (!d.data.enabled) {
    return (
      <div className="content"><div className="card">
        <h2>Zeiterfassung</h2>
        <p className="muted">In diesem Projekt nicht aktiviert. {me.role === 'pl' ? <button className="btn sm primary" onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { timeTrackingEnabled: true }); await reload(); await d.reload(); })}>Jetzt aktivieren</button> : 'Der PL kann sie unter Mitglieder → Projekt aktivieren.'}</p>
      </div></div>
    );
  }
  const data = d.data;
  const budgetMin = data.budgetHours ? data.budgetHours * 60 : null;
  const total = data.totalMinutes ?? data.entries.reduce((a, e) => a + e.minutes, 0);
  const minutes = (Number(f.hours || 0) * 60) + Number(f.minutes || 0);
  const csv = () => {
    const rows = [['Datum', 'Person', 'Aufgabe', 'Minuten', 'Notiz'], ...data.entries.map((e) => [e.date, e.userName ?? '', e.taskTitle ?? '', String(e.minutes), (e.note ?? '').replace(/\n/g, ' ')])];
    const blob = new Blob([rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `zeiten_${detail.project.key}.csv`; a.click();
  };
  return (
    <div className="content">
      <div className="grid cols-3 mb">
        <div className="card">
          <h3>{me.role === 'pl' ? 'Gesamt gebucht' : 'Meine Buchungen'}</h3>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{fmtH(total)}</div>
          {budgetMin && me.role === 'pl' && <><div className={`time-bar mt ${total > budgetMin ? 'over' : ''}`}><div style={{ width: `${Math.min(100, (total / budgetMin) * 100)}%` }} /></div><div className="muted small">Budget {data.budgetHours} h · {Math.round((total / budgetMin) * 100)} %</div></>}
          {data.estimateMinutes > 0 && <div className="muted small">Schätzung offener/aller Aufgaben: {fmtH(data.estimateMinutes)}</div>}
        </div>
        <div className="card">
          <h3>Je Person</h3>
          <table className="table"><tbody>{data.byUser.map((u) => <tr key={u.userId}><td>{u.name}</td><td className="nowrap">{fmtH(u.minutes)}</td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <h3>Je Teilprojekt (Ist / Schätzung)</h3>
          <table className="table"><tbody>{data.bySubproject.map((s) => <tr key={s.name}><td>{s.name}</td><td className="nowrap">{fmtH(s.minutes)}{s.estimateMinutes ? <span className="muted"> / {fmtH(s.estimateMinutes)}</span> : ''}</td></tr>)}</tbody></table>
        </div>
      </div>
      {me.role !== 'reader' && (
        <div className="card mb">
          <h3>Zeit buchen</h3>
          <div className="row">
            <select value={f.taskId} onChange={(e) => setF({ ...f, taskId: e.target.value })} style={{ width: 280 }}><option value="">– ohne Aufgabe –</option>{tasks.filter((t) => !t.done).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
            <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={{ width: 150 }} />
            <input type="number" min={0} placeholder="Std" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} style={{ width: 70 }} />
            <input type="number" min={0} max={59} placeholder="Min" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} style={{ width: 70 }} />
            <input type="text" placeholder="Notiz" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ flex: 1 }} />
            <button className="btn primary" disabled={busy || minutes <= 0} onClick={() => void run(async () => { await api.post(`/projects/${detail.project.id}/time`, { taskId: f.taskId || null, date: f.date, minutes, note: f.note }); setF({ ...f, hours: '', minutes: '', note: '' }); await d.reload(); })}>Buchen</button>
          </div>
          {error && <div className="error mt">{error}</div>}
        </div>
      )}
      <div className="card">
        <div className="row mb">
          <h3 style={{ margin: 0 }}>Buchungen</h3>
          <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ width: 150 }} />
          <span className="muted">bis</span>
          <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ width: 150 }} />
          {me.role === 'pl' && <select value={range.userId} onChange={(e) => setRange({ ...range, userId: e.target.value })} style={{ width: 'auto' }}><option value="">Alle Personen</option>{detail.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select>}
          <button className="btn sm right" onClick={csv}>CSV-Export</button>
        </div>
        <table className="table"><thead><tr><th>Datum</th><th>Person</th><th>Aufgabe</th><th>Dauer</th><th>Notiz</th><th /></tr></thead><tbody>
          {data.entries.map((e) => <tr key={e.id}><td className="nowrap">{fmtDate(e.date)}</td><td>{e.userName}</td><td>{e.taskId ? <a href="#" onClick={(ev) => { ev.preventDefault(); openTask(e.taskId!); }}>{e.taskTitle}</a> : <span className="muted">–</span>}</td><td className="nowrap">{fmtH(e.minutes)}</td><td className="muted small">{e.note}</td>
            <td>{(e.userId === me.userId || me.role === 'pl') && <button className="btn sm link" onClick={() => void run(async () => { await api.del(`/time/${e.id}`); await d.reload(); })}>✕</button>}</td></tr>)}
          {data.entries.length === 0 && <tr><td colSpan={6} className="muted">Keine Buchungen im Zeitraum.</td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

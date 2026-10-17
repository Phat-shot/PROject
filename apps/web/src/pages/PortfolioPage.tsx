import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProjectHealth } from '@projekttool/shared';
import { api, downloadCsv, fmtDate, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { Modal, useAsync } from '../components/ui';

interface Row {
  id: string; key: string; name: string; description: string | null; myRole: string; leadName: string | null;
  stats: { open: number; done: number; overdue: number; dueWeek: number; blocked: number; escalated: number; redRisks: number };
  computed: 'green' | 'yellow' | 'red'; health: ProjectHealth;
  nextMilestone: { name: string; date: string } | null;
  budgetHours: number | null; loggedMinutes: number; timeTrackingEnabled: boolean; lastActivity: string | null;
}
interface Portfolio { projects: Row[]; workload: { userId: string; name: string; open: number; overdue: number; perProject: { key: string; open: number }[] }[] }

const COLOR_LABEL = { green: 'grün', yellow: 'gelb', red: 'rot' } as const;
const rank = { red: 0, yellow: 1, green: 2 } as const;

/** Portfolio: alle Projekte mit Ampel (manuell und berechnet), Fortschritt, Verzug, Meilenstein, Budget; Auslastung über Projekte. */
export function PortfolioPage() {
  const d = useData<Portfolio>('/portfolio');
  const [edit, setEdit] = useState<Row | null>(null);
  const rows = [...(d.data?.projects ?? [])].sort((a, b) => rank[a.health.color ?? a.computed] - rank[b.health.color ?? b.computed] || b.stats.overdue - a.stats.overdue);
  const effective = (r: Row) => r.health.color ?? r.computed;
  return (
    <>
      <TopBar title="Portfolio" />
      <div className="content">
        {d.error && <div className="error mb">{d.error}</div>}
        <div className="kpis mb">
          {(['red', 'yellow', 'green'] as const).map((c) => <div key={c} className={`kpi ${c === 'red' ? 'bad' : c === 'yellow' ? 'warn' : 'ok'}`}><div className="v">{rows.filter((r) => effective(r) === c).length}</div><div className="l">Projekte {COLOR_LABEL[c]}</div></div>)}
          <div className="kpi"><div className="v">{rows.reduce((a, r) => a + r.stats.open, 0)}</div><div className="l">offene Arbeitspakete</div></div>
          <div className={`kpi ${rows.some((r) => r.stats.overdue) ? 'bad' : 'ok'}`}><div className="v">{rows.reduce((a, r) => a + r.stats.overdue, 0)}</div><div className="l">überfällig</div></div>
        </div>
        <div className="card mb">
          <h2>Projekte</h2>
          {d.data && rows.length === 0 && <div className="empty">Keine aktiven Projekte.</div>}
          {rows.length > 0 && (
            <table className="table portfolio"><thead><tr><th>Ampel</th><th>Projekt</th><th>PL</th><th>Fortschritt</th><th>Offen</th><th>Überfällig</th><th>Blockiert / Esk.</th><th>Risiken rot</th><th>Nächster Meilenstein</th><th>Budget</th><th>Aktivität</th></tr></thead><tbody>
              {rows.map((r) => {
                const total = r.stats.open + r.stats.done;
                const c = effective(r);
                return (
                  <tr key={r.id}>
                    <td className="nowrap">
                      <button className={`ampel ${c}`} title={`${r.health.color ? `Von der PL gesetzt: ${COLOR_LABEL[r.health.color]}` : `Berechnet: ${COLOR_LABEL[r.computed]}`}${r.health.note ? ` · ${r.health.note}` : ''}${r.health.color && r.health.color !== r.computed ? ` (berechnet ${COLOR_LABEL[r.computed]})` : ''}`} onClick={() => r.myRole === 'pl' && setEdit(r)} disabled={r.myRole !== 'pl'} />
                      {r.health.color && r.health.color !== r.computed && <span className={`ampel small ${r.computed}`} title={`Berechnet: ${COLOR_LABEL[r.computed]}`} />}
                    </td>
                    <td><Link to={`/projekte/${r.id}`}><span className="badge">{r.key}</span> {r.name}</Link>{r.health.note && <div className="muted small">{r.health.note}</div>}</td>
                    <td className="small">{r.leadName ?? '–'}</td>
                    <td style={{ minWidth: 120 }}><div className="bar" title={`${r.stats.done} von ${total} erledigt`}><div className="done" style={{ width: `${total ? (r.stats.done / total) * 100 : 0}%` }} /></div><span className="muted small">{total ? Math.round((r.stats.done / total) * 100) : 0} %</span></td>
                    <td>{r.stats.open}{r.stats.dueWeek > 0 && <span className="muted small"> · {r.stats.dueWeek} in 7 Tagen</span>}</td>
                    <td className={r.stats.overdue ? 'bad' : ''} style={r.stats.overdue ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{r.stats.overdue}</td>
                    <td>{r.stats.blocked + r.stats.escalated > 0 ? <span className="badge danger">{r.stats.blocked} / {r.stats.escalated}</span> : <span className="muted">–</span>}</td>
                    <td>{r.stats.redRisks > 0 ? <Link to={`/projekte/${r.id}/raid`} className="badge danger">{r.stats.redRisks}</Link> : <span className="muted">–</span>}</td>
                    <td className="small nowrap">{r.nextMilestone ? <>◆ {fmtDate(r.nextMilestone.date)} {r.nextMilestone.name}</> : <span className="muted">–</span>}</td>
                    <td className="small nowrap">{r.timeTrackingEnabled ? <>{Math.round(r.loggedMinutes / 60)} h{r.budgetHours ? ` / ${r.budgetHours} h` : ''}</> : <span className="muted">–</span>}</td>
                    <td className="small muted nowrap">{r.lastActivity ? fmtDateTime(r.lastActivity) : '–'}</td>
                  </tr>
                );
              })}
            </tbody></table>
          )}
          <p className="muted small mt">Ampel: von der Projektleitung gesetzt (Klick, nur PL) oder berechnet: rot bei Blockaden, Eskalation ab Stufe 2 oder mehr als einem Viertel Verzug, gelb bei Verzug, sonst grün. Ein kleiner zweiter Punkt zeigt die berechnete Farbe, wenn sie abweicht.</p>
        </div>
        <div className="card">
          <h2>Auslastung über alle Projekte <span className="muted small" style={{ fontWeight: 400 }}>offene Arbeitspakete je Person</span></h2>
          {d.data && d.data.workload.length === 0 && <div className="muted small">Keine zugewiesenen Arbeitspakete.</div>}
          {d.data && d.data.workload.length > 0 && (
            <table className="table"><thead><tr><th>Person</th><th>Offen</th><th>Überfällig</th><th>Je Projekt</th></tr></thead><tbody>
              {d.data.workload.map((w) => <tr key={w.userId}><td>{w.name}</td><td>{w.open}</td><td style={w.overdue ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{w.overdue}</td><td className="small">{w.perProject.map((p) => <span key={p.key} className="badge" style={{ marginRight: 4 }}>{p.key} {p.open}</span>)}</td></tr>)}
            </tbody></table>
          )}
        </div>
      </div>
      <TimeAcrossProjects />
      {edit && <HealthDialog row={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await d.reload(); }} />}
    </>
  );
}

interface PortfolioTime { from: string; to: string; projects: { projectId: string; key: string; name: string; minutes: number; people: { userId: string; name: string; minutes: number }[] }[]; people: { userId: string; name: string; minutes: number }[]; total: number }
const hours = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;

/** Zeiten über alle Projekte im Zeitraum: je Projekt und Person (PL sieht alle Personen seiner Projekte, sonst nur eigene Buchungen). */
function TimeAcrossProjects() {
  const { timeTracking } = useAuth();
  const [range, setRange] = useState({ from: '', to: '' });
  const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const d = useData<PortfolioTime>(timeTracking ? `/portfolio/time${q ? `?${q}` : ''}` : null, [q]);
  if (!timeTracking || !d.data) return null;
  const t = d.data;
  return (
    <div className="content" style={{ paddingTop: 0 }}>
      <div className="card">
        <h2>Zeiten über Projekte <span className="muted small" style={{ fontWeight: 400 }}>{fmtDate(t.from)} – {fmtDate(t.to)} · {hours(t.total)}</span></h2>
        <div className="row small">
          <span className="muted">Zeitraum</span><input type="date" style={{ width: 'auto' }} value={range.from || t.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /><input type="date" style={{ width: 'auto' }} value={range.to || t.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          <button className="btn sm" onClick={() => downloadCsv(`zeiten_projekte_${t.from}_${t.to}.csv`, ['Projekt', 'Person', 'Minuten'], t.projects.flatMap((p) => p.people.map((x) => [p.key, x.name, x.minutes])))}>CSV</button>
        </div>
        {t.projects.length === 0 && <div className="muted small mt">Keine Buchungen im Zeitraum.</div>}
        {t.projects.length > 0 && <table className="table mt"><thead><tr><th>Projekt</th><th>Gebucht</th><th>Je Person</th></tr></thead><tbody>
          {t.projects.map((p) => <tr key={p.projectId}><td><Link to={`/projekte/${p.projectId}/zeiten`}><span className="badge">{p.key}</span> {p.name}</Link></td><td className="nowrap">{hours(p.minutes)}</td><td className="small">{p.people.map((x) => <span key={x.userId} className="badge" style={{ marginRight: 4 }}>{x.name} {hours(x.minutes)}</span>)}</td></tr>)}
        </tbody></table>}
        {t.people.length > 1 && <p className="small mt"><span className="muted">Je Person:</span> {t.people.map((x) => <span key={x.userId} className="badge" style={{ marginRight: 4 }}>{x.name} {hours(x.minutes)}</span>)}</p>}
      </div>
    </div>
  );
}

/** Ampel setzen: Farbe und Begründung; „automatisch“ nimmt die berechnete Farbe. */
export function HealthDialog({ row, onClose, onSaved }: { row: { id: string; name: string; computed: 'green' | 'yellow' | 'red'; health: ProjectHealth }; onClose: () => void; onSaved: () => Promise<void> }) {
  const [color, setColor] = useState<string>(row.health.color ?? '');
  const [note, setNote] = useState(row.health.note ?? '');
  const { busy, error, run } = useAsync();
  return (
    <Modal title={`Ampel: ${row.name}`} onClose={onClose}>
      <div className="form">
        <div className="row">{(['', 'green', 'yellow', 'red'] as const).map((c) => <button key={c} className={`chip ${color === c ? 'on' : ''}`} onClick={() => setColor(c)}>{c ? <><span className={`ampel small ${c}`} /> {COLOR_LABEL[c]}</> : `automatisch (${COLOR_LABEL[row.computed]})`}</button>)}</div>
        <label className="field"><span>Begründung (erscheint im Portfolio und in der Übersicht)</span><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. Lieferant verzögert Modul X, Go-Live gefährdet" /></label>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.put(`/projects/${row.id}/health`, { color: color || null, note }); await onSaved(); })}>Speichern</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

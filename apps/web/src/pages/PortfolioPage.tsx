import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProjectHealth, ReportBlock, ReportBlockType, ReportPeriod } from '@projekttool/shared';
import { REPORT_BLOCK_LABEL } from '@projekttool/shared';
import { api, downloadCsv, fmtDate, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/useData';
import { Button, Modal, SafeHtml, useAsync } from '../components/ui';
import { reportQuery } from '../components/ReportBlocks';
import { IconArrowUpRight, IconDiamond } from '../components/icons';

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

/**
 * Dashboard › Projekte (früher Portfolio): alle Projekte mit Ampel (manuell und berechnet), Fortschritt, Verzug,
 * Meilenstein, Budget; Auslastung und Zeiten über Projekte. Mit Projektfilter nur dieses Projekt.
 */
export function PortfolioView({ projectId }: { projectId: string | null }) {
  const d = useData<Portfolio>('/portfolio');
  const [edit, setEdit] = useState<Row | null>(null);
  const [report, setReport] = useState(false);
  const rows = [...(d.data?.projects ?? [])].filter((r) => !projectId || r.id === projectId).sort((a, b) => rank[a.health.color ?? a.computed] - rank[b.health.color ?? b.computed] || b.stats.overdue - a.stats.overdue);
  const effective = (r: Row) => r.health.color ?? r.computed;
  const workload = (d.data?.workload ?? []).map((w) => {
    if (!projectId) return w;
    const key = rows[0]?.key;
    const here = w.perProject.filter((p) => p.key === key);
    return { ...w, open: here.reduce((a, p) => a + p.open, 0), perProject: here };
  }).filter((w) => w.open > 0 || !projectId);
  return (
    <>
      <div>
        {d.error && <div className="error mb">{d.error}</div>}
        <div className="kpis mb">
          {(['red', 'yellow', 'green'] as const).map((c) => <div key={c} className={`kpi ${c === 'red' ? 'bad' : c === 'yellow' ? 'warn' : 'ok'}`}><div className="v">{rows.filter((r) => effective(r) === c).length}</div><div className="l">Projekte {COLOR_LABEL[c]}</div></div>)}
          <div className="kpi"><div className="v">{rows.reduce((a, r) => a + r.stats.open, 0)}</div><div className="l">offene Arbeitspakete</div></div>
          <div className={`kpi ${rows.some((r) => r.stats.overdue) ? 'bad' : 'ok'}`}><div className="v">{rows.reduce((a, r) => a + r.stats.overdue, 0)}</div><div className="l">überfällig</div></div>
        </div>
        <div className="card mb">
          <div className="row between mb"><h2 className="m-0">Projekte</h2>{rows.length > 0 && <Button size="sm" onClick={() => setReport(true)}>Management-Report</Button>}</div>
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
                    <td className="min-w-120"><div className="bar" title={`${r.stats.done} von ${total} erledigt`}><div className="done" style={{ width: `${total ? (r.stats.done / total) * 100 : 0}%` }} /></div><span className="muted small">{total ? Math.round((r.stats.done / total) * 100) : 0} %</span></td>
                    <td>{r.stats.open}{r.stats.dueWeek > 0 && <span className="muted small"> · {r.stats.dueWeek} in 7 Tagen</span>}</td>
                    <td className={r.stats.overdue ? 'bad' : ''} style={r.stats.overdue ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{r.stats.overdue}</td>
                    <td>{r.stats.blocked + r.stats.escalated > 0 ? <span className="badge danger">{r.stats.blocked} / {r.stats.escalated}</span> : <span className="muted">–</span>}</td>
                    <td>{r.stats.redRisks > 0 ? <Link to={`/projekte/${r.id}/raid`} className="badge danger">{r.stats.redRisks}</Link> : <span className="muted">–</span>}</td>
                    <td className="small nowrap">{r.nextMilestone ? <><IconDiamond size={12} /> {fmtDate(r.nextMilestone.date)} {r.nextMilestone.name}</> : <span className="muted">–</span>}</td>
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
          <h2>Auslastung über alle Projekte <span className="muted small fw-400">offene Arbeitspakete je Person</span></h2>
          {d.data && workload.length === 0 && <div className="muted small">Keine zugewiesenen Arbeitspakete.</div>}
          {d.data && workload.length > 0 && (
            <table className="table"><thead><tr><th>Person</th><th>Offen</th><th>Überfällig</th><th>Je Projekt</th></tr></thead><tbody>
              {workload.map((w) => <tr key={w.userId}><td>{w.name}</td><td>{w.open}</td><td style={w.overdue && !projectId ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{projectId ? <span className="muted" title="Nur über alle Projekte ausgewertet">–</span> : w.overdue}</td><td className="small">{w.perProject.map((p) => <span key={p.key} className="badge mr-1">{p.key} {p.open}</span>)}</td></tr>)}
            </tbody></table>
          )}
        </div>
      </div>
      <TimeAcrossProjects projectId={projectId} />
      {edit && <HealthDialog row={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await d.reload(); }} />}
      {report && <PortfolioReportDialog projects={rows.map((r) => ({ id: r.id, key: r.key, name: r.name }))} onClose={() => setReport(false)} />}
    </>
  );
}

interface PortfolioTime { from: string; to: string; projects: { projectId: string; key: string; name: string; minutes: number; people: { userId: string; name: string; minutes: number }[] }[]; people: { userId: string; name: string; minutes: number }[]; total: number }
const hours = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;

/** Zeiten über alle Projekte im Zeitraum: je Projekt und Person (PL sieht alle Personen seiner Projekte, sonst nur eigene Buchungen). */
function TimeAcrossProjects({ projectId }: { projectId: string | null }) {
  const { timeTracking } = useAuth();
  const [range, setRange] = useState({ from: '', to: '' });
  const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const d = useData<PortfolioTime>(timeTracking ? `/portfolio/time${q ? `?${q}` : ''}` : null, [q]);
  if (!timeTracking || !d.data) return null;
  const t = projectId ? (() => {
    const projects = d.data!.projects.filter((p) => p.projectId === projectId);
    const people = projects.flatMap((p) => p.people);
    return { ...d.data!, projects, people, total: projects.reduce((a, p) => a + p.minutes, 0) };
  })() : d.data;
  return (
    <div className="mt">
      <div className="card">
        <h2>Zeiten über Projekte <span className="muted small fw-400">{fmtDate(t.from)} – {fmtDate(t.to)} · {hours(t.total)}</span></h2>
        <div className="row small">
          <span className="muted">Zeitraum</span><input className="w-auto" type="date" value={range.from || t.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /><input className="w-auto" type="date" value={range.to || t.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          <button className="btn sm" onClick={() => downloadCsv(`zeiten_projekte_${t.from}_${t.to}.csv`, ['Projekt', 'Person', 'Minuten'], t.projects.flatMap((p) => p.people.map((x) => [p.key, x.name, x.minutes])))}>CSV</button>
        </div>
        {t.projects.length === 0 && <div className="muted small mt">Keine Buchungen im Zeitraum.</div>}
        {t.projects.length > 0 && <table className="table mt"><thead><tr><th>Projekt</th><th>Gebucht</th><th>Je Person</th></tr></thead><tbody>
          {t.projects.map((p) => <tr key={p.projectId}><td><Link to={`/projekte/${p.projectId}/zeiten`}><span className="badge">{p.key}</span> {p.name}</Link></td><td className="nowrap">{hours(p.minutes)}</td><td className="small">{p.people.map((x) => <span key={x.userId} className="badge mr-1">{x.name} {hours(x.minutes)}</span>)}</td></tr>)}
        </tbody></table>}
        {t.people.length > 1 && <p className="small mt"><span className="muted">Je Person:</span> {t.people.map((x) => <span key={x.userId} className="badge mr-1">{x.name} {hours(x.minutes)}</span>)}</p>}
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

const PORTFOLIO_PERIODS: { key: ReportPeriod; label: string }[] = [{ key: 'week', label: 'Woche' }, { key: 'month', label: 'Monat' }, { key: 'quarter', label: 'Quartal' }, { key: 'days', label: 'n Tage' }];
const PORTFOLIO_EXTRAS: ReportBlockType[] = ['changes', 'milestones', 'outlook', 'overdue', 'blocked', 'risks'];

/**
 * Management-Report über die sichtbaren Projekte: Zeitraum, Projektauswahl, Diagramme und Zusatzblöcke je Projekt;
 * Vorschau als HTML im Dialog, PDF in neuem Tab (GET /portfolio/report.pdf).
 */
export function PortfolioReportDialog({ projects, onClose }: { projects: { id: string; key: string; name: string }[]; onClose: () => void }) {
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [days, setDays] = useState(30);
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>(projects.map((p) => p.id));
  const [graphic, setGraphic] = useState(true);
  const [extras, setExtras] = useState<ReportBlockType[]>(['changes', 'milestones', 'outlook']);
  const [preview, setPreview] = useState<{ html: string; title: string } | null>(null);
  const { busy, error, run } = useAsync();
  const params = () => {
    const blocks: ReportBlock[] = PORTFOLIO_EXTRAS.filter((t) => extras.includes(t)).map((t, i) => ({ id: `p${i + 1}`, type: t }));
    return { period, days: period === 'days' ? days : undefined, graphic, projectIds: all ? undefined : selected, blocks };
  };
  const toggle = (id: string) => setSelected((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const none = !all && selected.length === 0;
  return (
    <Modal title="Management-Report (Portfolio)" onClose={onClose}>
      <div className="form">
        <p className="muted small">Gesamtübersicht aller gewählten Projekte mit Ampel, Fortschritt, Verzug und nächstem Meilenstein; dazu je Projekt die gewählten Zusatzblöcke im Zeitraum.</p>
        <div className="row small">
          <label className="row gap-1"><span>Zeitraum</span><select aria-label="Zeitraum" value={period} onChange={(e) => setPeriod(e.target.value as ReportPeriod)}>{PORTFOLIO_PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
          {period === 'days' && <label className="row gap-1"><input type="number" min={1} max={365} className="w-64" aria-label="Tage" value={days} onChange={(e) => setDays(Number(e.target.value) || 1)} /><span>Tage</span></label>}
          <label className="check"><input type="checkbox" checked={graphic} onChange={(e) => setGraphic(e.target.checked)} /> grafisch (Diagramme)</label>
        </div>
        <fieldset className="report-fieldset">
          <legend className="small">Projekte</legend>
          <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> alle sichtbaren Projekte ({projects.length})</label>
          {!all && <div className="report-choice" role="group" aria-label="Projekte auswählen">
            {projects.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} /> <span className="badge">{p.key}</span> {p.name}</label>)}
          </div>}
        </fieldset>
        <fieldset className="report-fieldset">
          <legend className="small">Zusatzblöcke je Projekt</legend>
          <div className="report-choice" role="group" aria-label="Zusatzblöcke">
            {PORTFOLIO_EXTRAS.map((t) => <label key={t} className="check"><input type="checkbox" checked={extras.includes(t)} onChange={(e) => setExtras((xs) => (e.target.checked ? [...xs, t] : xs.filter((x) => x !== t)))} /> {REPORT_BLOCK_LABEL[t]}</label>)}
          </div>
        </fieldset>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <Button variant="primary" loading={busy} disabled={none} onClick={() => void run(async () => { setPreview(await api.post<{ html: string; title: string }>('/portfolio/report', params())); })}>Vorschau</Button>
          <Button icon={<IconArrowUpRight />} disabled={none || busy} onClick={() => window.open(`/api/portfolio/report.pdf?${reportQuery(params())}`, '_blank', 'noopener')}>PDF</Button>
          <Button variant="link" onClick={onClose}>Schließen</Button>
        </div>
        {preview && <div className="report-preview mt"><h3 className="m-0 mb">{preview.title}</h3><SafeHtml html={preview.html} /></div>}
      </div>
    </Modal>
  );
}

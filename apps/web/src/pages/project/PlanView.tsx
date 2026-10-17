import { useMemo, useState } from 'react';
import { fmtDate, today } from '../../lib/api';
import { useProject } from '../ProjectPage';
import { MilestoneForm, MilestonesTable, SubprojectForm, SubprojectsTable } from './planForms';

const DAY = 86400_000;
const PX_PER_DAY = 4;

export function PlanView() {
  const { detail, tasks, openTask } = useProject();
  const me = detail.project.myMembership;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const [newSp, setNewSp] = useState(false);
  const [newMs, setNewMs] = useState(false);

  const range = useMemo(() => {
    const dates: string[] = [today()];
    for (const t of tasks) { if (t.startDate) dates.push(t.startDate); if (t.dueDate) dates.push(t.dueDate); }
    for (const s of detail.subprojects) { if (s.startDate) dates.push(s.startDate); if (s.endDate) dates.push(s.endDate); }
    for (const m of detail.milestones) dates.push(m.date);
    const min = new Date(dates.reduce((a, b) => (a < b ? a : b)));
    const max = new Date(dates.reduce((a, b) => (a > b ? a : b)));
    min.setDate(1); min.setDate(min.getDate() - 7);
    max.setMonth(max.getMonth() + 1, 1); max.setDate(max.getDate() + 7);
    return { min, max, days: Math.round((max.getTime() - min.getTime()) / DAY) };
  }, [tasks, detail]);
  const x = (d: string) => Math.round((new Date(d + 'T00:00:00').getTime() - range.min.getTime()) / DAY) * PX_PER_DAY;
  const width = range.days * PX_PER_DAY;
  const months = useMemo(() => {
    const out: { label: string; left: number; w: number }[] = [];
    const d = new Date(range.min); d.setDate(1);
    while (d < range.max) {
      const start = new Date(d); const end = new Date(d); end.setMonth(end.getMonth() + 1);
      const l = Math.max(0, (start.getTime() - range.min.getTime()) / DAY) * PX_PER_DAY;
      const r = Math.min(range.days * DAY, end.getTime() - range.min.getTime()) / DAY * PX_PER_DAY;
      out.push({ label: start.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }), left: l, w: r - l });
      d.setMonth(d.getMonth() + 1);
    }
    return out;
  }, [range]);

  const rows: { kind: 'sub' | 'task' | 'ms'; id: string; label: string; start: string | null; end: string | null; done?: boolean; conflict?: boolean; resp?: string | null }[] = [];
  const spRows = (spId: string | null) => {
    for (const t of tasks.filter((t) => t.subprojectId === spId)) {
      rows.push({ kind: 'task', id: t.id, label: t.title, start: t.startDate, end: t.dueDate, done: t.done, conflict: t.conflicts.length > 0, resp: t.responsible.name ?? t.responsible.email });
    }
    for (const m of detail.milestones.filter((m) => m.subprojectId === spId)) rows.push({ kind: 'ms', id: m.id, label: m.name, start: m.date, end: m.date });
  };
  for (const s of detail.subprojects) {
    const inSp = tasks.filter((t) => t.subprojectId === s.id);
    const starts = inSp.map((t) => t.startDate ?? t.dueDate).filter(Boolean) as string[];
    const ends = inSp.map((t) => t.dueDate).filter(Boolean) as string[];
    const start = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : s.startDate;
    const end = ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : s.endDate;
    rows.push({ kind: 'sub', id: s.id, label: s.name, start: s.startDate ?? start, end: s.endDate ?? end, resp: s.responsible.name });
    spRows(s.id);
  }
  const loose = tasks.filter((t) => !t.subprojectId);
  if (loose.length || detail.milestones.some((m) => !m.subprojectId)) { rows.push({ kind: 'sub', id: 'none', label: 'Ohne Teilprojekt', start: null, end: null }); spRows(null); }

  return (
    <div className="content">
      <div className="row mb">
        <span className="muted small">Balken = Start bis Deadline, Punkt = nur Deadline. Teilprojekt-Balken = frühester Start bis späteste Deadline. Konflikte orange, nichts verschiebt sich automatisch.</span>
        {canPlan && <><button className="btn right" onClick={() => setNewSp(true)}>Teilprojekt</button><button className="btn" onClick={() => setNewMs(true)}>Meilenstein</button></>}
      </div>
      <div className="card gantt" style={{ padding: 0 }}>
        <table>
          <thead><tr><th className="label">Element</th><th style={{ width }}><div style={{ position: 'relative', height: 24, width }}>{months.map((m) => <div key={m.label + m.left} className="month" style={{ position: 'absolute', left: m.left, width: m.w, top: 0, bottom: 0 }}>{m.label}</div>)}</div></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.kind + r.id} id={r.kind === 'sub' ? `sp-${r.id}` : undefined}>
                <td className={`label ${r.kind === 'sub' ? 'sub' : ''}`} style={{ cursor: r.kind === 'task' ? 'pointer' : undefined }} onClick={() => r.kind === 'task' && openTask(r.id)}>
                  {r.kind === 'task' && <span style={{ paddingLeft: 10 }} />}{r.kind === 'ms' && '◆ '}{r.label}
                  {r.resp && <span className="muted"> · {r.resp}</span>}
                </td>
                <td className="bars" style={{ width }}>
                  <div style={{ position: 'relative', height: 30, width }}>
                    <div className="today" style={{ left: x(today()) }} />
                    {r.kind === 'ms' && r.start && <div className="milestone" style={{ left: x(r.start) - 8 }} title={fmtDate(r.start)} />}
                    {r.kind !== 'ms' && r.start && r.end && r.start <= r.end && <div className={`bar ${r.kind} ${r.done ? 'done' : ''} ${r.conflict ? 'conflict' : ''}`} style={{ left: x(r.start), width: Math.max(6, x(r.end) - x(r.start) + PX_PER_DAY) }} title={`${fmtDate(r.start)} – ${fmtDate(r.end)}`}>{r.kind === 'sub' ? '' : `${fmtDate(r.start)} – ${fmtDate(r.end)}`}</div>}
                    {r.kind === 'task' && !r.start && r.end && <div className={`dot ${r.conflict ? 'conflict' : ''}`} style={{ left: x(r.end) - 6 }} title={`Deadline ${fmtDate(r.end)}`} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid cols-2 mt">
        <div className="card"><h2>Teilprojekte</h2><SubprojectsTable /></div>
        <div className="card"><h2>Meilensteine</h2><MilestonesTable /></div>
      </div>
      {newSp && <SubprojectForm onClose={() => setNewSp(false)} />}
      {newMs && <MilestoneForm onClose={() => setNewMs(false)} />}
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDate, today } from '../../lib/api';
import { useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';
import { MilestoneForm, MilestonesTable, SubprojectForm, SubprojectsTable } from './planForms';

const DAY = 86400_000;
const ZOOM: [number, string][] = [[2, 'Quartal'], [4, 'Monat'], [10, 'Woche'], [24, 'Tag']];
const ROW_H = 30;
const addDaysIso = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Laufende Verschiebung per Maus: Balken (move), rechte Kante (resize), Meilenstein (ms); dx in Pixel */
interface Drag { id: string; kind: 'move' | 'resize' | 'ms'; x0: number; dx: number }

export function PlanView() {
  const { detail, tasks, openTask, reload, reloadTasks } = useProject();
  const me = detail.project.myMembership;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const [drag, setDrag] = useState<Drag | null>(null);
  const save = useAsync();
  const [geom, setGeom] = useState({ labelW: 280, headH: 30 });
  const tableRef = useRef<HTMLTableElement>(null);
  const [newSp, setNewSp] = useState(false);
  const [newMs, setNewMs] = useState(false);
  const [PX_PER_DAY, setZoom] = useState(() => { try { return Number(localStorage.getItem('pt_gantt_zoom')) || 4; } catch { return 4; } });
  const zoomTo = (v: number) => { setZoom(v); try { localStorage.setItem('pt_gantt_zoom', String(v)); } catch { /* ignore */ } };
  const scrollRef = useRef<HTMLDivElement>(null);

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
  const dragDays = drag ? Math.round(drag.dx / PX_PER_DAY) : 0;
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  /** Termine ändern darf, wer den Plan ändern darf oder für das Arbeitspaket zuständig ist. */
  const mayDrag = (id: string) => { const t = taskById.get(id); return Boolean(t && !t.done && !t.archivedAt && (canPlan || t.responsible.userId === me.userId)); };
  const startDrag = (e: React.PointerEvent, id: string, kind: Drag['kind']) => {
    if (kind === 'ms' ? !canPlan : !mayDrag(id)) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id, kind, x0: e.clientX, dx: 0 });
  };
  const moveDrag = (e: React.PointerEvent) => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.x0 }); };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const days = Math.round((e.clientX - drag.x0) / PX_PER_DAY);
    const d = drag; setDrag(null);
    if (days === 0) return;
    void save.run(async () => {
      if (d.kind === 'ms') {
        const m = detail.milestones.find((x) => x.id === d.id); if (!m) return;
        await api.patch(`/projects/${detail.project.id}/milestones/${m.id}`, { date: addDaysIso(m.date, days) }); await reload();
      } else {
        const t = taskById.get(d.id); if (!t || !t.dueDate) return;
        const body: Record<string, unknown> = d.kind === 'move'
          ? { dueDate: addDaysIso(t.dueDate, days), ...(t.startDate ? { startDate: addDaysIso(t.startDate, days) } : {}) }
          : { dueDate: addDaysIso(t.dueDate, Math.max(days, t.startDate ? Math.round((new Date(t.startDate).getTime() - new Date(t.dueDate).getTime()) / DAY) : -Infinity)) };
        await api.patch(`/tasks/${t.id}`, body); await reloadTasks();
      }
    });
  };
  // Spaltenbreite und Kopfhöhe messen, damit die Abhängigkeitslinien über den Zeilen liegen
  useLayoutEffect(() => {
    const el = tableRef.current; if (!el) return;
    const th = el.querySelector('th.label') as HTMLElement | null; const head = el.querySelector('thead') as HTMLElement | null;
    setGeom({ labelW: th?.offsetWidth ?? 280, headH: head?.offsetHeight ?? 30 });
  }, [PX_PER_DAY, tasks.length]);
  const width = range.days * PX_PER_DAY;
  // „heute“ beim Öffnen und nach Zoom in Sicht bringen
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollLeft = Math.max(0, x(today()) + 280 - el.clientWidth / 2); }, [PX_PER_DAY, range.min.getTime()]);
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
  /** Zeilenindex je Arbeitspaket und sichtbare Lage des Balkens (mit laufender Verschiebung) */
  const rowIndex = new Map(rows.map((r, i) => [r.kind + r.id, i]));
  const shifted = (r: (typeof rows)[number]): { start: string | null; end: string | null } => {
    if (!drag || drag.id !== r.id || (r.kind === 'ms') !== (drag.kind === 'ms')) return { start: r.start, end: r.end };
    if (drag.kind === 'resize') return { start: r.start, end: r.end ? addDaysIso(r.end, dragDays) : r.end };
    return { start: r.start ? addDaysIso(r.start, dragDays) : r.start, end: r.end ? addDaysIso(r.end, dragDays) : r.end };
  };
  // Abhängigkeitslinien Ende → Anfang, rot bei Konflikt (Nachfolger beginnt vor dem Ende des Vorgängers)
  const links: { x1: number; y1: number; x2: number; y2: number; bad: boolean; key: string }[] = [];
  for (const r of rows) {
    if (r.kind !== 'task') continue;
    const t = taskById.get(r.id); if (!t || !r.end) continue;
    const si = rowIndex.get('task' + r.id)!; const sv = shifted(r);
    const sStart = sv.start ?? sv.end!;
    for (const pid of t.predecessorIds ?? []) {
      const pi = rowIndex.get('task' + pid); const pr = rows[pi ?? -1]; if (pi === undefined || !pr?.end) continue;
      const pv = shifted(pr);
      links.push({ key: `${pid}>${r.id}`, x1: x(pv.end!) + PX_PER_DAY, y1: pi * ROW_H + ROW_H / 2, x2: x(sStart), y2: si * ROW_H + ROW_H / 2, bad: sStart < pv.end! });
    }
  }

  return (
    <div className="content">
      <div className="row mb">
        <span className="muted small">Balken ziehen verschiebt Start und Deadline, rechte Kante ändert die Deadline, Meilensteine lassen sich ziehen. Linien = Vorgänger → Nachfolger, rot bei Konflikt. Nichts verschiebt sich automatisch.{save.busy && ' · speichert …'}</span>
        {save.error && <span className="error small">{save.error}</span>}
        <span className="row right" style={{ gap: 2 }}>{ZOOM.map(([v, l]) => <button key={v} className={`chip ${PX_PER_DAY === v ? 'on' : ''}`} onClick={() => zoomTo(v)} title={`${v} px je Tag`}>{l}</button>)}<button className="chip" onClick={() => { const el = scrollRef.current; if (el) el.scrollTo({ left: Math.max(0, x(today()) + 280 - el.clientWidth / 2), behavior: 'smooth' }); }}>Heute</button></span>
        {canPlan && <><button className="btn" onClick={() => setNewSp(true)}>Teilprojekt</button><button className="btn" onClick={() => setNewMs(true)}>Meilenstein</button></>}
      </div>
      <div className={`card gantt ${drag ? 'dragging' : ''}`} style={{ padding: 0 }} ref={scrollRef}>
        <div className="gantt-wrap" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
        <svg className="gantt-links" style={{ left: geom.labelW, top: geom.headH, width, height: rows.length * ROW_H }} aria-hidden="true">
          <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" /></marker><marker id="arr-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--danger)" /></marker></defs>
          {links.map((l) => { const mid = l.x2 >= l.x1 + 12 ? (l.x1 + l.x2) / 2 : l.x1 + 10; const d = l.x2 >= l.x1 + 12
            ? `M${l.x1},${l.y1} H${mid} V${l.y2} H${l.x2}`
            : `M${l.x1},${l.y1} H${l.x1 + 10} V${l.y1 + (l.y2 > l.y1 ? ROW_H / 2 : -ROW_H / 2)} H${l.x2 - 10} V${l.y2} H${l.x2}`;
            return <path key={l.key} d={d} className={l.bad ? 'bad' : ''} markerEnd={l.bad ? 'url(#arr-bad)' : 'url(#arr)'} />; })}
        </svg>
        <table ref={tableRef}>
          <thead><tr><th className="label">Element</th><th style={{ width }}><div style={{ position: 'relative', height: 24, width }}>{months.map((m) => <div key={m.label + m.left} className="month" style={{ position: 'absolute', left: m.left, width: m.w, top: 0, bottom: 0 }}>{m.label}</div>)}</div></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.kind + r.id} id={r.kind === 'sub' ? `sp-${r.id}` : undefined}>
                <td className={`label ${r.kind === 'sub' ? 'sub' : ''}`} style={{ cursor: r.kind === 'task' ? 'pointer' : undefined }} onClick={() => r.kind === 'task' && openTask(r.id)}>
                  {r.kind === 'task' && <span style={{ paddingLeft: 10 }} />}{r.kind === 'ms' && '◆ '}{r.label}
                  {r.resp && <span className="muted"> · {r.resp}</span>}
                </td>
                <td className="bars" style={{ width }}>
                  {(() => { const v = shifted(r); const isDrag = drag?.id === r.id; const draggable = r.kind === 'task' ? mayDrag(r.id) : r.kind === 'ms' ? canPlan : false; return (
                  <div style={{ position: 'relative', height: ROW_H, width }}>
                    <div className="today" style={{ left: x(today()) }} />
                    {r.kind === 'ms' && v.start && <div className={`milestone ${draggable ? 'draggable' : ''} ${isDrag ? 'drag' : ''}`} style={{ left: x(v.start) - 8 }} title={`${fmtDate(v.start)}${draggable ? ' · ziehen zum Verschieben' : ''}`} onPointerDown={(e) => startDrag(e, r.id, 'ms')} />}
                    {r.kind !== 'ms' && v.start && v.end && v.start <= v.end && (
                      <div className={`bar ${r.kind} ${r.done ? 'done' : ''} ${r.conflict ? 'conflict' : ''} ${draggable ? 'draggable' : ''} ${isDrag ? 'drag' : ''}`} style={{ left: x(v.start), width: Math.max(6, x(v.end) - x(v.start) + PX_PER_DAY) }} title={`${fmtDate(v.start)} – ${fmtDate(v.end)}${draggable ? ' · ziehen verschiebt, rechte Kante ändert die Deadline' : ''}`}
                        onPointerDown={(e) => r.kind === 'task' && startDrag(e, r.id, 'move')} onClick={(e) => { if (r.kind === 'task' && !drag) { e.stopPropagation(); openTask(r.id); } }}>
                        {r.kind === 'sub' ? '' : `${fmtDate(v.start)} – ${fmtDate(v.end)}`}
                        {r.kind === 'task' && draggable && <span className="handle" onPointerDown={(e) => startDrag(e, r.id, 'resize')} />}
                      </div>
                    )}
                    {r.kind === 'task' && !v.start && v.end && <div className={`dot ${r.conflict ? 'conflict' : ''} ${draggable ? 'draggable' : ''}`} style={{ left: x(v.end) - 6 }} title={`Deadline ${fmtDate(v.end)}${draggable ? ' · ziehen zum Verschieben' : ''}`} onPointerDown={(e) => startDrag(e, r.id, 'move')} />}
                    {isDrag && dragDays !== 0 && <span className="drag-hint" style={{ left: x(v.end ?? v.start!) + PX_PER_DAY + 6 }}>{dragDays > 0 ? '+' : ''}{dragDays} Tage</span>}
                  </div>); })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
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

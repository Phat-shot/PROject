import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChecklistItem, Subproject, Task } from '@projekttool/shared';
import { api, fmtDate, today } from '../lib/api';
import { prioLabel } from '../components/ui';

export interface WorkProject {
  id: string; key: string; name: string; myRole: string;
  lead: { userId: string | null; name: string | null };
  subprojects: Subproject[];
  tasks: Task[];
  checklist: ChecklistItem[];
}
export interface WorkLane { sub: Subproject | null; mine: boolean; items: WorkItem[] }
export interface WorkItem { ap: Task; mine: boolean; tasks: { item: ChecklistItem; inherited: boolean }[]; subs: WorkItem[] }
export interface WorkNode { p: WorkProject; leadIsMe: boolean; lanes: WorkLane[] }

/**
 * Baum Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task: nur was mir zugewiesen ist, ausdrücklich oder geerbt
 * (Projektleitung → Teilprojekt → Arbeitspaket → Aufgabe → Task). Explizit anderen zugewiesene Elemente fallen heraus.
 */
export function buildWorkTree(projects: WorkProject[], me: string | undefined, showDone: boolean): WorkNode[] {
  return projects.map((p) => {
    const leadIsMe = p.lead.userId === me;
    const laneOf = (sub: Subproject | null): WorkLane => {
      const subMine = sub ? sub.responsible.userId === me : leadIsMe;
      const aps = p.tasks.filter((x) => !x.parentId && (sub ? x.subprojectId === sub.id : !x.subprojectId) && (showDone || !x.done));
      const itemOf = (ap: Task): WorkItem => {
        const apMine = ap.responsible.userId === me;
        const tasks = p.checklist.filter((c) => c.taskId === ap.id && (showDone || !c.done))
          .map((c) => ({ item: c, inherited: !c.responsibleUserId && !c.responsibleEmail }))
          .filter((x) => (x.item.responsibleUserId ? x.item.responsibleUserId === me : !x.item.responsibleEmail && apMine));
        const subs = ap.parentId ? [] : p.tasks.filter((c) => c.parentId === ap.id && (showDone || !c.done)).map(itemOf).filter(relevant);
        return { ap, mine: apMine, tasks, subs };
      };
      const relevant = (x: WorkItem) => x.mine || x.tasks.length > 0 || x.subs.length > 0;
      const items = aps.map(itemOf).filter(relevant);
      return { sub, mine: subMine, items };
    };
    const lanes = [...p.subprojects.map(laneOf), laneOf(null)].filter((l) => l.items.length > 0 || (l.sub && l.mine && !l.sub.responsible.inherited));
    return { p, leadIsMe, lanes };
  }).filter((x) => x.leadIsMe || x.lanes.length > 0);
}

export function WorkTree({ nodes, reload }: { nodes: WorkNode[]; reload: () => Promise<void> }) {
  const t = today();
  const toggleTask = async (ap: Task, c: ChecklistItem) => { await api.patch(`/tasks/${ap.id}/checklist/${c.id}`, { done: !c.done }); await reload(); };
  if (nodes.length === 0) return <div className="empty">Nichts zugewiesen.</div>;
  return (
    <div className="worktree">
      {nodes.map(({ p, leadIsMe, lanes }) => (
        <div key={p.id} className="card wt-project">
          <div className="wt-head">
            <Link to={`/projekte/${p.id}`} className="row" style={{ gap: 8 }}><span className="badge">{p.key}</span><strong>{p.name}</strong></Link>
            {leadIsMe && <span className="badge pl">Projektleitung</span>}
            <span className="muted small right">{p.lead.name && !leadIsMe ? `PL: ${p.lead.name}` : ''}</span>
          </div>
          {lanes.length === 0 && <div className="muted small" style={{ padding: '4px 0 0 18px' }}>Keine offenen Arbeitspakete für dich.</div>}
          {lanes.map((l) => (
            <div key={l.sub?.id ?? 'none'} className="wt-lane">
              <div className="wt-sub">
                <span className="wt-bracket" />
                <span className="wt-label">{l.sub ? l.sub.name : 'Ohne Teilprojekt'}{l.sub?.restricted && <span title="Eingeschränkt sichtbar"> 🔒</span>}</span>
                {l.sub && l.mine && <span className="muted small">verantwortlich: ich{l.sub.responsible.inherited ? ' (geerbt vom PL)' : ''}</span>}
                {l.sub && !l.mine && <span className="muted small">verantwortlich: {l.sub.responsible.name ?? '–'}{l.sub.responsible.inherited ? ' (geerbt)' : ''}</span>}
                {l.sub?.endDate && <span className="muted small">· bis {fmtDate(l.sub.endDate)}</span>}
              </div>
              {l.items.map((it) => <ApNode key={it.ap.id} projectId={p.id} it={it} t={t} toggleTask={toggleTask} />)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const FROM_LABEL: Record<string, string> = { task: 'Arbeitspaket', subproject: 'Teilprojekt', project: 'PL' };

/** Arbeitspaket oder Aufgabe mit eigenen Tasks; Aufgaben hängen eingerückt am Arbeitspaket. */
function ApNode({ projectId, it, t, toggleTask }: { projectId: string; it: WorkItem; t: string; toggleTask: (ap: Task, c: ChecklistItem) => Promise<void> }) {
  const { ap, mine, tasks, subs } = it;
  return (
    <div className={`wt-ap ${ap.parentId ? 'wt-aufgabe' : ''}`}>
      <div className="wt-ap-row">
        <span className="wt-bracket" />
        {ap.parentId && <span className="badge" title="Aufgabe im Arbeitspaket">Aufgabe</span>}
        <Link to={`/projekte/${projectId}/board?task=${ap.id}`} className={ap.done ? 'muted' : ''} style={ap.done ? { textDecoration: 'line-through' } : undefined}>{ap.title}</Link>
        {ap.priority !== 'normal' && <span className={`badge prio-${ap.priority}`}>{prioLabel[ap.priority]}</span>}
        {ap.blocked && <span className="badge blocked">blockiert</span>}
        {ap.escalationLevel > 0 && <span className="badge danger">Esk. {ap.escalationLevel}</span>}
        {ap.dueDate && <span style={!ap.done && ap.dueDate < t ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{fmtDate(ap.dueDate)}</span>}
        <span className="muted small">{mine ? (ap.responsible.inherited ? `ich (geerbt vom ${FROM_LABEL[ap.responsible.inheritedFrom ?? 'project']})` : 'ich') : `${ap.responsible.name ?? ap.responsible.email ?? '–'}${ap.responsible.inherited ? ' (geerbt)' : ''}`}</span>
        {(ap.subtaskTotal ?? 0) > 0 && <span className="muted small" title="Aufgaben erledigt / gesamt">▤ {ap.subtaskDone}/{ap.subtaskTotal}</span>}
        {ap.checklistTotal > 0 && <span className="muted small">☑ {ap.checklistDone}/{ap.checklistTotal}</span>}
      </div>
      {tasks.map(({ item, inherited }) => (
        <label key={item.id} className={`wt-task ${item.done ? 'done' : ''}`}>
          <span className="wt-bracket" />
          <input type="checkbox" checked={item.done} onChange={() => void toggleTask(ap, item)} />
          <span>{item.title}</span>
          <span className="muted small">{inherited ? 'ich (geerbt)' : 'ich'}</span>
        </label>
      ))}
      {subs.map((s) => <ApNode key={s.ap.id} projectId={projectId} it={s} t={t} toggleTask={toggleTask} />)}
    </div>
  );
}

/** Umschalter „erledigte zeigen“ als kleines Hilfs-Hook für Seiten mit dem Baum. */
export function useShowDone() {
  const [showDone, setShowDone] = useState(false);
  return { showDone, setShowDone };
}

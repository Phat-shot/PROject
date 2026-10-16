import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChecklistItem, Subproject, Task } from '@projekttool/shared';
import { api, fmtDate, today } from '../lib/api';
import { useData } from '../lib/useData';
import { useAuth } from '../lib/auth';
import { prioLabel } from '../components/ui';

interface WorkProject {
  id: string; key: string; name: string; myRole: string;
  lead: { userId: string | null; name: string | null };
  subprojects: Subproject[];
  tasks: Task[];
  checklist: ChecklistItem[];
}

/**
 * Meine Arbeit: Projekt › Teilprojekt › Arbeitspaket › Task, geklammert nach Hierarchie.
 * Gezeigt wird nur, was mir zugewiesen ist, ausdrücklich oder geerbt (Projektleitung → Teilprojekt → Arbeitspaket → Task).
 */
export function WorkTree() {
  const { user } = useAuth();
  const { data, error, reload } = useData<{ projects: WorkProject[] }>('/my/work');
  const [showDone, setShowDone] = useState(false);
  const me = user?.id;
  const t = today();
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Lade …</div>;

  const tree = data.projects.map((p) => {
    const leadIsMe = p.lead.userId === me;
    const lanes: { sub: Subproject | null; mine: boolean; items: { ap: Task; mine: boolean; tasks: { item: ChecklistItem; inherited: boolean }[] }[] }[] = [];
    const laneOf = (sub: Subproject | null) => {
      const subMine = sub ? sub.responsible.userId === me : leadIsMe;
      const aps = p.tasks.filter((x) => (sub ? x.subprojectId === sub.id : !x.subprojectId) && (showDone || !x.done));
      const items = aps.map((ap) => {
        const apMine = ap.responsible.userId === me;
        const tasks = p.checklist.filter((c) => c.taskId === ap.id && (showDone || !c.done))
          .map((c) => ({ item: c, inherited: !c.responsibleUserId }))
          .filter((x) => (x.item.responsibleUserId ? x.item.responsibleUserId === me : apMine));
        return { ap, mine: apMine, tasks };
      }).filter((x) => x.mine || x.tasks.length > 0);
      return { sub, mine: subMine, items };
    };
    for (const s of p.subprojects) lanes.push(laneOf(s));
    lanes.push(laneOf(null));
    const shown = lanes.filter((l) => l.items.length > 0 || (l.sub && l.mine && !l.sub.responsible.inherited));
    return { p, leadIsMe, lanes: shown };
  }).filter((x) => x.leadIsMe || x.lanes.length > 0);

  const total = tree.reduce((n, x) => n + x.lanes.reduce((m, l) => m + l.items.length, 0), 0);
  const toggleTask = async (ap: Task, c: ChecklistItem) => { await api.patch(`/tasks/${ap.id}/checklist/${c.id}`, { done: !c.done }); await reload(); };
  return (
    <div className="worktree">
      <div className="row mb">
        <span className="muted small">{total} Arbeitspakete in {tree.length} Projekten</span>
        <label className="check small right"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> erledigte zeigen</label>
      </div>
      {tree.length === 0 && <div className="empty">Nichts zugewiesen.</div>}
      {tree.map(({ p, leadIsMe, lanes }) => (
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
              {l.items.map(({ ap, mine, tasks }) => (
                <div key={ap.id} className="wt-ap">
                  <div className="wt-ap-row">
                    <span className="wt-bracket" />
                    <Link to={`/projekte/${p.id}/board?task=${ap.id}`} className={ap.done ? 'muted' : ''} style={ap.done ? { textDecoration: 'line-through' } : undefined}>{ap.title}</Link>
                    {ap.priority !== 'normal' && <span className={`badge prio-${ap.priority}`}>{prioLabel[ap.priority]}</span>}
                    {ap.blocked && <span className="badge blocked">blockiert</span>}
                    {ap.escalationLevel > 0 && <span className="badge danger">Esk. {ap.escalationLevel}</span>}
                    {ap.dueDate && <span className={`due ${!ap.done && ap.dueDate < t ? 'overdue' : ''}`} style={!ap.done && ap.dueDate < t ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{fmtDate(ap.dueDate)}</span>}
                    <span className="muted small">{mine ? (ap.responsible.inherited ? `ich (geerbt vom ${ap.responsible.inheritedFrom === 'subproject' ? 'Teilprojekt' : 'PL'})` : 'ich') : `${ap.responsible.name ?? ap.responsible.email ?? '–'}${ap.responsible.inherited ? ' (geerbt)' : ''}`}</span>
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
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

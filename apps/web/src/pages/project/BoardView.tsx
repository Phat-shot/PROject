import { useMemo, useState } from 'react';
import type { Task } from '@projekttool/shared';
import { api, fmtDate, today } from '../../lib/api';
import { Initials, Modal, prioLabel, useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';

export function BoardView() {
  const { detail, tasks, reloadTasks, openTask } = useProject();
  const [lanes, setLanes] = useState(true);
  const [filterSp, setFilterSp] = useState<string>('');
  const [create, setCreate] = useState<{ columnId: string; subprojectId: string | null } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const canEdit = detail.project.myMembership.role !== 'reader';
  const t = today();

  const groups = useMemo(() => {
    const filtered = filterSp ? tasks.filter((x) => (filterSp === 'none' ? !x.subprojectId : x.subprojectId === filterSp)) : tasks;
    if (!lanes) return [{ key: 'all', name: null as string | null, tasks: filtered }];
    const out = detail.subprojects.map((s) => ({ key: s.id, name: s.name, tasks: filtered.filter((x) => x.subprojectId === s.id) }));
    out.push({ key: 'none', name: 'Ohne Teilprojekt', tasks: filtered.filter((x) => !x.subprojectId) });
    return out.filter((g) => g.tasks.length > 0 || !filterSp);
  }, [tasks, lanes, filterSp, detail.subprojects]);

  const drop = async (task: Task, columnId: string) => {
    if (task.columnId === columnId) return;
    await api.patch(`/tasks/${task.id}`, { columnId });
    await reloadTasks();
  };

  return (
    <div className="content">
      <div className="row mb">
        <label className="check"><input type="checkbox" checked={lanes} onChange={(e) => setLanes(e.target.checked)} /> Teilprojekte als Swimlanes</label>
        <select value={filterSp} onChange={(e) => setFilterSp(e.target.value)} style={{ width: 240 }}>
          <option value="">Alle Teilprojekte</option>
          {detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value="none">Ohne Teilprojekt</option>
        </select>
        <span className="muted small">{tasks.filter((x) => !x.done).length} offen · {tasks.filter((x) => x.conflicts.length).length} mit Konflikt</span>
        {canEdit && <button className="btn primary right" onClick={() => setCreate({ columnId: detail.columns[0].id, subprojectId: null })}>Neue Aufgabe</button>}
      </div>
      {groups.map((g) => (
        <div key={g.key} className="swimlane">
          {g.name && <h2>{g.name} <span className="badge">{g.tasks.length}</span>{g.key !== 'none' && <SubprojectResp id={g.key} />}</h2>}
          <div className="board">
            {detail.columns.map((c) => {
              const inCol = g.tasks.filter((x) => x.columnId === c.id).sort((a, b) => a.position - b.position);
              const key = `${g.key}:${c.id}`;
              return (
                <div key={c.id} className={`column ${over === key ? 'over' : ''}`}
                  onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(key); } }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/task'); const task = tasks.find((x) => x.id === id); if (task) void drop(task, c.id); }}>
                  <h3><span>{c.name}</span><span>{inCol.length}</span></h3>
                  {inCol.map((x) => (
                    <div key={x.id} className={`task-card ${x.dueDate && x.dueDate < t && !x.done ? 'overdue' : ''}`} draggable={canEdit}
                      onDragStart={(e) => e.dataTransfer.setData('text/task', x.id)} onClick={() => openTask(x.id)}>
                      <div className="title">{x.title}</div>
                      <div className="meta">
                        {x.priority !== 'normal' && <span className={`badge prio-${x.priority}`}>{prioLabel[x.priority]}</span>}
                        {x.dueDate && <span className="due">bis {fmtDate(x.dueDate)}</span>}
                        {x.conflicts.length > 0 && <span className="conflict" title={x.conflicts.join('\n')}>⚠ Konflikt</span>}
                        {x.checklist && x.checklist.length > 0 && <span>{x.checklist.filter((i) => i.done).length}/{x.checklist.length}</span>}
                        <span className="right" title={x.responsible.inherited ? `geerbt vom ${x.responsible.inheritedFrom === 'subproject' ? 'Teilprojekt' : 'Projekt'}` : 'ausdrücklich gesetzt'}>
                          {x.responsible.userId ? <Initials name={x.responsible.name} /> : <span className="badge">{x.responsible.email ? 'extern' : '–'}</span>}
                        </span>
                      </div>
                    </div>
                  ))}
                  {canEdit && <button className="btn sm link" onClick={() => setCreate({ columnId: c.id, subprojectId: g.key === 'none' || g.key === 'all' ? null : g.key })}>+ Aufgabe</button>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {create && <CreateTask columnId={create.columnId} subprojectId={create.subprojectId} onClose={() => setCreate(null)} />}
    </div>
  );
}

function SubprojectResp({ id }: { id: string }) {
  const { detail } = useProject();
  const s = detail.subprojects.find((x) => x.id === id);
  if (!s) return null;
  return <span className="muted small" style={{ fontWeight: 400 }}>· verantwortlich {s.responsible.name ?? '–'}{s.responsible.inherited ? ' (geerbt vom PL)' : ''}{s.startDate && ` · ${fmtDate(s.startDate)} – ${fmtDate(s.endDate)}`}</span>;
}

function CreateTask({ columnId, subprojectId, onClose }: { columnId: string; subprojectId: string | null; onClose: () => void }) {
  const { detail, reloadTasks, openTask, users } = useProject();
  const [f, setF] = useState({ title: '', description: '', subprojectId: subprojectId ?? '', columnId, priority: 'normal', startDate: '', dueDate: '', responsibleUserId: '', responsibleEmail: '' });
  const { busy, error, run } = useAsync();
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const members = users.filter((u) => detail.members.some((m) => m.userId === u.id));
  return (
    <Modal title="Neue Aufgabe" onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Titel</span><input type="text" value={f.title} onChange={(e) => set('title', e.target.value)} autoFocus /></label>
        <label className="field full"><span>Beschreibung</span><textarea value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
        <label className="field"><span>Teilprojekt</span>
          <select value={f.subprojectId} onChange={(e) => set('subprojectId', e.target.value)}><option value="">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>Spalte</span>
          <select value={f.columnId} onChange={(e) => set('columnId', e.target.value)}>{detail.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>Priorität</span>
          <select value={f.priority} onChange={(e) => set('priority', e.target.value)}>{Object.entries(prioLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <div />
        <label className="field"><span>Start (optional)</span><input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></label>
        <label className="field"><span>Deadline</span><input type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></label>
        <label className="field"><span>Zuständig (intern)</span>
          <select value={f.responsibleUserId} onChange={(e) => set('responsibleUserId', e.target.value)}><option value="">– geerbt –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field"><span>oder externe Mail-Adresse</span><input type="email" value={f.responsibleEmail} onChange={(e) => set('responsibleEmail', e.target.value)} placeholder="extern@firma.de" /></label>
        {error && <div className="error full">{error}</div>}
        <div className="row full">
          <button className="btn primary" disabled={busy || !f.title.trim()} onClick={() => void run(async () => {
            const r = await api.post<{ task: { id: string } }>(`/projects/${detail.project.id}/tasks`, {
              title: f.title, description: f.description || null, subprojectId: f.subprojectId || null, columnId: f.columnId, priority: f.priority,
              startDate: f.startDate || null, dueDate: f.dueDate || null, responsibleUserId: f.responsibleUserId || null, responsibleEmail: f.responsibleEmail || null
            });
            await reloadTasks();
            onClose();
            openTask(r.task.id);
          })}>Anlegen</button>
        </div>
      </div>
    </Modal>
  );
}

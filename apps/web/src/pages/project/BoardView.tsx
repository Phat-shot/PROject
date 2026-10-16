import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@projekttool/shared';
import { api, fmtDate, today } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Initials, Modal, prioLabel, useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';

interface Filter { q: string; member: string; label: string; mine: boolean; overdue: boolean; conflicts: boolean; prio: string; archived: boolean; escalated: boolean }
const EMPTY: Filter = { q: '', member: '', label: '', mine: false, overdue: false, conflicts: false, prio: '', archived: false, escalated: false };

export function BoardView() {
  const { detail, tasks, reloadTasks, openTask } = useProject();
  const { user } = useAuth();
  const [lanes, setLanes] = useState(true);
  const [f, setF] = useState<Filter>(EMPTY);
  const [archived, setArchived] = useState<Task[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [create, setCreate] = useState<{ columnId: string; subprojectId: string | null } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ col: string; lane: string; index: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const canEdit = detail.project.myMembership.role !== 'reader';
  const t = today();
  const soon = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const active = f.q || f.member || f.label || f.mine || f.overdue || f.conflicts || f.prio || f.escalated;

  useEffect(() => {
    if (f.archived && !archived) api.get<{ tasks: Task[] }>(`/projects/${detail.project.id}/tasks?archived=1`).then((r) => setArchived(r.tasks));
    if (!f.archived) setArchived(null);
  }, [f.archived]);

  // Tastaturkürzel wie in Trello: f Filter, q nur meine, n neue Aufgabe, x Filter löschen
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey) return;
      if (e.key === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'q') setF((x) => ({ ...x, mine: !x.mine }));
      if (e.key === 'x') setF(EMPTY);
      if (e.key === 'n' && canEdit) setCreate({ columnId: detail.columns[0].id, subprojectId: null });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [canEdit, detail.columns]);

  const source = f.archived ? archived ?? [] : tasks;
  const filtered = useMemo(() => source.filter((x) => {
    if (f.q && !(x.title + ' ' + (x.description ?? '')).toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.member === 'none' ? x.responsible.userId : f.member && x.responsible.userId !== f.member) return false;
    if (f.label && !x.labelIds.includes(f.label)) return false;
    if (f.mine && x.responsible.userId !== user?.id) return false;
    if (f.overdue && !(x.dueDate && x.dueDate < t && !x.done)) return false;
    if (f.conflicts && x.conflicts.length === 0) return false;
    if (f.escalated && !x.blocked && x.escalationLevel === 0) return false;
    if (f.prio && x.priority !== f.prio) return false;
    return true;
  }), [source, f, t, user?.id]);

  const groups = useMemo(() => {
    if (!lanes) return [{ key: 'all', name: null as string | null, tasks: filtered }];
    const out = detail.subprojects.map((s) => ({ key: s.id, name: s.name, tasks: filtered.filter((x) => x.subprojectId === s.id) }));
    out.push({ key: 'none', name: 'Ohne Teilprojekt', tasks: filtered.filter((x) => !x.subprojectId) });
    return out.filter((g) => g.tasks.length > 0 || !active);
  }, [filtered, lanes, detail.subprojects, active]);

  const columnCount = (colId: string) => tasks.filter((x) => x.columnId === colId).length;

  const onDrop = async (laneKey: string, colId: string) => {
    if (!drag) return;
    const task = tasks.find((x) => x.id === drag);
    setDrag(null); setDrop(null);
    if (!task) return;
    // Zielindex innerhalb der Spalte bestimmen (Swimlane → Position im Gesamt der Spalte)
    const colTasks = tasks.filter((x) => x.columnId === colId && x.id !== task.id).sort((a, b) => a.position - b.position);
    const laneTasks = colTasks.filter((x) => laneKey === 'all' ? true : laneKey === 'none' ? !x.subprojectId : x.subprojectId === laneKey);
    const idxInLane = drop && drop.col === colId && drop.lane === laneKey ? drop.index : laneTasks.length;
    const anchor = laneTasks[idxInLane];
    const index = anchor ? colTasks.indexOf(anchor) : colTasks.length;
    const body: Record<string, unknown> = { columnId: colId, index };
    await api.post(`/tasks/${task.id}/move`, body);
    if (laneKey !== 'all' && (task.subprojectId ?? 'none') !== laneKey) await api.patch(`/tasks/${task.id}`, { subprojectId: laneKey === 'none' ? null : laneKey });
    await reloadTasks();
  };

  return (
    <div className="content">
      <div className="filterbar">
        <input ref={searchRef} type="text" placeholder="Filtern … (f)" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.member} onChange={(e) => setF({ ...f, member: e.target.value })}>
          <option value="">Alle Personen</option>
          {detail.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          <option value="none">Extern / ohne Person</option>
        </select>
        <select value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })}>
          <option value="">Alle Labels</option>
          {detail.labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={f.prio} onChange={(e) => setF({ ...f, prio: e.target.value })}>
          <option value="">Jede Priorität</option>
          {Object.entries(prioLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className={`chip ${f.mine ? 'on' : ''}`} onClick={() => setF({ ...f, mine: !f.mine })}>Nur meine<kbd>q</kbd></button>
        <button className={`chip ${f.overdue ? 'on' : ''}`} onClick={() => setF({ ...f, overdue: !f.overdue })}>Überfällig</button>
        <button className={`chip ${f.conflicts ? 'on' : ''}`} onClick={() => setF({ ...f, conflicts: !f.conflicts })}>Konflikte</button>
        <button className={`chip ${f.escalated ? 'on' : ''}`} onClick={() => setF({ ...f, escalated: !f.escalated })}>Blockiert / eskaliert</button>
        <button className={`chip ${f.archived ? 'on' : ''}`} onClick={() => setF({ ...f, archived: !f.archived })}>Archiv</button>
        {active && <button className="chip" onClick={() => setF(EMPTY)}>Filter löschen<kbd>x</kbd></button>}
        <label className="check small right"><input type="checkbox" checked={lanes} onChange={(e) => setLanes(e.target.checked)} /> Swimlanes</label>
        <span className="muted small">{filtered.length}/{source.length}</span>
        {canEdit && <button className="btn primary" onClick={() => setCreate({ columnId: detail.columns[0].id, subprojectId: null })}>Neue Aufgabe<kbd style={{ marginLeft: 6, opacity: 0.8 }}>n</kbd></button>}
      </div>
      {f.archived && <div className="notice mb small">Archiv: erledigte und archivierte Aufgaben. Wiederherstellen über die Aufgabe.</div>}
      {groups.map((g) => (
        <div key={g.key} className="swimlane">
          {g.name && <h2><span className="lane-name">{g.name}</span><span className="badge">{g.tasks.length}</span>{g.key !== 'none' && <SubprojectResp id={g.key} />}</h2>}
          <div className="board">
            {detail.columns.map((c) => {
              const inCol = g.tasks.filter((x) => x.columnId === c.id).sort((a, b) => a.position - b.position);
              const total = columnCount(c.id);
              const over = c.wipLimit != null && total > c.wipLimit;
              const isCollapsed = collapsed.has(c.id);
              const laneKey = g.key;
              return (
                <div key={c.id} className={`column ${over ? 'wip-over' : ''} ${isCollapsed ? 'collapsed' : ''} ${drop?.col === c.id && drop.lane === laneKey ? 'over' : ''}`}
                  onDragOver={(e) => { if (canEdit && drag) { e.preventDefault(); if (!drop || drop.col !== c.id || drop.lane !== laneKey) setDrop({ col: c.id, lane: laneKey, index: inCol.length }); } }}
                  onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrop(null); }}
                  onDrop={(e) => { e.preventDefault(); void onDrop(laneKey, c.id); }}>
                  <h3>
                    <span>{c.name}{!isCollapsed && c.wipLimit != null && <span className="count" title="WIP-Limit"> · {total}/{c.wipLimit}</span>}</span>
                    {!isCollapsed && <span className="tools">
                      <span>{inCol.length}</span>
                      {canEdit && c.isDone && inCol.length > 0 && <button title="Alle erledigten archivieren" onClick={() => { if (confirm(`${total} erledigte Aufgaben archivieren?`)) void api.post(`/projects/${detail.project.id}/columns/${c.id}/archive-done`).then(reloadTasks); }}>⌫</button>}
                      <button title="Einklappen" onClick={() => setCollapsed(new Set([...collapsed, c.id]))}>«</button>
                    </span>}
                    {isCollapsed && <button className="btn sm link" onClick={() => { const n = new Set(collapsed); n.delete(c.id); setCollapsed(n); }}>{total}</button>}
                  </h3>
                  {!isCollapsed && inCol.map((x, i) => (
                    <TaskCard key={x.id} task={x} t={t} soon={soon} canEdit={canEdit}
                      dragging={drag === x.id}
                      dropMarker={drop && drop.col === c.id && drop.lane === laneKey ? (drop.index === i ? 'before' : drop.index === i + 1 && i === inCol.length - 1 ? 'after' : null) : null}
                      onDragStart={() => setDrag(x.id)}
                      onDragEnd={() => { setDrag(null); setDrop(null); }}
                      onDragOverCard={(e) => { if (!drag || drag === x.id) return; e.preventDefault(); e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const before = e.clientY < r.top + r.height / 2; setDrop({ col: c.id, lane: laneKey, index: before ? i : i + 1 }); }}
                      onClick={() => openTask(x.id)} />
                  ))}
                  {!isCollapsed && inCol.length === 0 && <div className="col-empty">{drag ? 'Hier ablegen' : 'leer'}</div>}
                  {!isCollapsed && canEdit && !f.archived && <QuickAdd columnId={c.id} subprojectId={laneKey === 'none' || laneKey === 'all' ? null : laneKey} onMore={() => setCreate({ columnId: c.id, subprojectId: laneKey === 'none' || laneKey === 'all' ? null : laneKey })} />}
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

function TaskCard({ task: x, t, soon, canEdit, dragging, dropMarker, onDragStart, onDragEnd, onDragOverCard, onClick }: {
  task: Task; t: string; soon: string; canEdit: boolean; dragging: boolean; dropMarker: 'before' | 'after' | null;
  onDragStart: () => void; onDragEnd: () => void; onDragOverCard: (e: React.DragEvent) => void; onClick: () => void;
}) {
  const { detail } = useProject();
  const dueClass = x.done ? 'done' : x.dueDate && x.dueDate < t ? 'overdue' : x.dueDate && x.dueDate <= soon ? 'soon' : '';
  const labels = x.labelIds.map((id) => detail.labels.find((l) => l.id === id)).filter(Boolean);
  return (
    <div className={`task-card prio-${x.priority} ${x.done ? 'is-done' : ''} ${dragging ? 'dragging' : ''} ${dropMarker ? `drop-${dropMarker}` : ''} ${x.recurrence ? 'recurring' : ''} ${x.blocked ? 'blocked' : ''}`} draggable={canEdit}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }} onDragEnd={onDragEnd} onDragOver={onDragOverCard} onClick={onClick}>
      {labels.length > 0 && <div className="labels">{labels.map((l) => <span key={l!.id} className={`lbl full ${l!.color}`}>{l!.name}</span>)}</div>}
      <div className="title">{x.title}</div>
      <div className="badges">
        {x.blocked && <span className="badge blocked" title={x.blockedReason ?? 'blockiert'}>Blockiert</span>}
        {x.escalationLevel > 0 && <span className={`badge esc${x.escalationLevel}`} title="Eskalationsstufe">Esk. {x.escalationLevel}</span>}
        {x.priority !== 'normal' && <span className={`badge prio-${x.priority}`}>{prioLabel[x.priority]}</span>}
        {x.dueDate && <span className={`due ${dueClass}`} title={x.done ? 'erledigt' : dueClass === 'overdue' ? 'überfällig' : dueClass === 'soon' ? 'in den nächsten 3 Tagen fällig' : 'Deadline'}>{x.done ? '✓ ' : '⏰ '}{fmtDate(x.dueDate)}</span>}
        {x.conflicts.length > 0 && <span className="conflict" title={x.conflicts.join('\n')}>⚠</span>}
        {x.hasDescription && <span title="Beschreibung vorhanden">≡</span>}
        {x.commentCount > 0 && <span title="Kommentare">💬 {x.commentCount}</span>}
        {x.attachmentCount > 0 && <span title="Anhänge">📎 {x.attachmentCount}</span>}
        {x.mailCount > 0 && <span title="Verknüpfte Mails">✉ {x.mailCount}</span>}
        {x.checklistTotal > 0 && <span title="Checkliste" className={x.checklistDone === x.checklistTotal ? 'ok' : ''}>☑ {x.checklistDone}/{x.checklistTotal}</span>}
        <span className="right who" title={x.responsible.inherited ? `${x.responsible.name ?? ''} (geerbt vom ${x.responsible.inheritedFrom === 'subproject' ? 'Teilprojekt' : 'PL'})` : x.responsible.name ?? x.responsible.email ?? ''}>
          {x.responsible.userId ? <span className={x.responsible.inherited ? 'avatar-wrap inherited' : 'avatar-wrap'}><Initials name={x.responsible.name} /></span> : <span className="badge">{x.responsible.email ? 'extern' : '–'}</span>}
        </span>
      </div>
      {x.checklistTotal > 0 && <div className={`progress ${x.checklistDone === x.checklistTotal ? 'complete' : ''}`}><div style={{ width: `${Math.round((x.checklistDone / x.checklistTotal) * 100)}%` }} /></div>}
    </div>
  );
}

function QuickAdd({ columnId, subprojectId, onMore }: { columnId: string; subprojectId: string | null; onMore: () => void }) {
  const { detail, reloadTasks } = useProject();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const { busy, run } = useAsync();
  const submit = () => {
    if (!title.trim()) return;
    void run(async () => { await api.post(`/projects/${detail.project.id}/tasks`, { title: title.trim(), columnId, subprojectId }); setTitle(''); await reloadTasks(); });
  };
  if (!open) return <button className="btn sm link" onClick={() => setOpen(true)}>+ Aufgabe</button>;
  return (
    <div className="quick-add">
      <textarea autoFocus placeholder="Titel eingeben, Enter zum Anlegen" value={title} onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') { setOpen(false); setTitle(''); } }} />
      <div className="row"><button className="btn sm primary" disabled={busy} onClick={submit}>Anlegen</button><button className="btn sm" onClick={() => { setOpen(false); setTitle(''); }}>✕</button><button className="btn sm link right" onClick={onMore}>mehr Felder …</button></div>
    </div>
  );
}

function SubprojectResp({ id }: { id: string }) {
  const { detail } = useProject();
  const s = detail.subprojects.find((x) => x.id === id);
  if (!s) return null;
  return <span className="muted small" style={{ fontWeight: 400 }}>{s.restricted && <span title="Eingeschränkt sichtbar">🔒 </span>}verantwortlich {s.responsible.name ?? '–'}{s.responsible.inherited ? ' (geerbt vom PL)' : ''}{s.startDate && ` · ${fmtDate(s.startDate)} – ${fmtDate(s.endDate)}`}</span>;
}

function CreateTask({ columnId, subprojectId, onClose }: { columnId: string; subprojectId: string | null; onClose: () => void }) {
  const { detail, reloadTasks, openTask, users } = useProject();
  const [f, setF] = useState({ title: '', description: '', subprojectId: subprojectId ?? '', columnId, priority: 'normal', startDate: '', dueDate: '', responsibleUserId: '', responsibleEmail: '', labelIds: [] as string[] });
  const { busy, error, run } = useAsync();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
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
        <div className="field"><span>Labels</span><LabelPicker value={f.labelIds} onChange={(v) => set('labelIds', v)} /></div>
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
              startDate: f.startDate || null, dueDate: f.dueDate || null, responsibleUserId: f.responsibleUserId || null, responsibleEmail: f.responsibleEmail || null, labelIds: f.labelIds
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

export function LabelPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { detail, reload } = useProject();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('blue');
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="row" style={{ gap: 4 }}>
      {detail.labels.map((l) => <button key={l.id} type="button" className={`lbl full ${l.color}`} style={{ opacity: value.includes(l.id) ? 1 : 0.35, border: 0, cursor: 'pointer', lineHeight: '20px' }} onClick={() => toggle(l.id)}>{l.name}</button>)}
      {!adding ? <button type="button" className="btn sm link" onClick={() => setAdding(true)}>+ Label</button> : (
        <span className="row" style={{ gap: 4 }}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={{ width: 110 }} />
          <select value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 'auto' }}>{['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'teal'].map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <button type="button" className="btn sm" onClick={() => void api.post<{ label: { id: string } }>(`/projects/${detail.project.id}/labels`, { name, color }).then(async (r) => { await reload(); onChange([...value, r.label.id]); setAdding(false); setName(''); })}>OK</button>
        </span>
      )}
    </div>
  );
}

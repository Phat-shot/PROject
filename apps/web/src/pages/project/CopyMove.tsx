import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project, Subproject, Task } from '@projekttool/shared';
import { api } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync } from '../../components/ui';
import type { ProjectDetail } from '../ProjectPage';

/** Bestandteile beim Kopieren/Verschieben; der Dialog löst „Alles / Alles außer / Nichts außer“ in eine Liste auf. */
const TASK_PARTS: { key: string; label: string; hint?: string }[] = [
  { key: 'checklist', label: 'Tasks (Checkliste)', hint: 'beim Kopieren offen' },
  { key: 'comments', label: 'Log und Kommentare' },
  { key: 'attachments', label: 'Anhänge' },
  { key: 'mails', label: 'Verknüpfte Mails' },
  { key: 'labels', label: 'Labels', hint: 'im Zielprojekt gleichnamig angelegt' },
  { key: 'dependencies', label: 'Abhängigkeiten', hint: 'nur innerhalb der mitgenommenen Arbeitspakete' },
  { key: 'responsible', label: 'Zuständigkeiten', hint: 'nur wer im Ziel Mitglied ist' },
  { key: 'dates', label: 'Termine' },
  { key: 'time', label: 'Zeitbuchungen', hint: 'nur beim Verschieben' }
];
const SUB_PARTS: { key: string; label: string; hint?: string }[] = [
  { key: 'tasks', label: 'Arbeitspakete', hint: 'unten einzeln abwählbar' },
  { key: 'milestones', label: 'Meilensteine' },
  { key: 'access', label: 'Sichtbarkeit und Zugriff' },
  ...TASK_PARTS
];
type Mode = 'all' | 'all_except' | 'only';

export interface CopyMoveProps {
  kind: 'task' | 'subproject';
  op: 'copy' | 'move';
  detail: ProjectDetail;
  task?: Task;
  subproject?: Subproject;
  tasks?: Task[];
  onClose: () => void;
  onDone: (r: { projectId: string; taskId?: string }) => void | Promise<void>;
}

/** Dialog: Ziel (Projekt, Teilprojekt, Spalte), Umfang („Alles“, „Alles außer …“, „Nichts außer …“), bei Teilprojekten zusätzlich die Arbeitspakete. */
export function CopyMoveDialog({ kind, op, detail, task, subproject, tasks = [], onClose, onDone }: CopyMoveProps) {
  const source = detail.project;
  const projects = useData<{ projects: Project[] }>('/projects');
  const [targetId, setTargetId] = useState(op === 'move' ? '' : source.id);
  const target = useData<ProjectDetail>(targetId && targetId !== source.id ? `/projects/${targetId}` : null, [targetId]);
  const targetDetail = targetId === source.id ? detail : target.data;
  const [subId, setSubId] = useState<string>(kind === 'task' ? task?.subprojectId ?? '' : '');
  const [columnId, setColumnId] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Mode>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [taskIds, setTaskIds] = useState<Set<string>>(new Set(tasks.map((x) => x.id)));
  const { busy, error, run } = useAsync();
  const nav = useNavigate();
  const partList = kind === 'task' ? TASK_PARTS : SUB_PARTS;
  const allKeys = partList.map((p) => p.key).filter((k) => op === 'move' || k !== 'time');
  useEffect(() => { setSubId(''); setColumnId(''); }, [targetId]);
  const parts = useMemo(() => mode === 'all' ? allKeys : mode === 'all_except' ? allKeys.filter((k) => !picked.has(k)) : allKeys.filter((k) => picked.has(k)), [mode, picked, allKeys]);
  const candidates = (projects.data?.projects ?? []).filter((p) => p.status === 'active' && (op === 'copy' || p.id !== source.id) && (p.id === source.id || p.myRole !== 'reader'));
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleTask = (id: string) => setTaskIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const title = `${kind === 'task' ? 'Arbeitspaket' : 'Teilprojekt'} ${op === 'copy' ? 'kopieren' : 'in anderes Projekt verschieben'}`;
  const submit = () => run(async () => {
    if (!targetId) throw new Error('Zielprojekt wählen');
    const body: Record<string, unknown> = { targetProjectId: targetId, parts, name: name || null, title: name || null, subprojectId: subId || null, columnId: columnId || null };
    if (kind === 'subproject' && parts.includes('tasks')) body.taskIds = [...taskIds];
    if (kind === 'task') {
      if (op === 'move' && !subId) delete body.subprojectId;
      const r = await api.post<{ task: Task; projectId: string }>(`/tasks/${task!.id}/${op === 'copy' ? 'copy' : 'move-to-project'}`, body);
      await onDone({ projectId: r.projectId, taskId: r.task.id });
      if (r.projectId !== source.id) nav(`/projekte/${r.projectId}/board?task=${r.task.id}`);
    } else {
      const r = await api.post<{ projectId: string }>(`/projects/${source.id}/subprojects/${subproject!.id}/${op === 'copy' ? 'copy' : 'move-to-project'}`, body);
      await onDone({ projectId: r.projectId });
      if (r.projectId !== source.id) nav(`/projekte/${r.projectId}/plan`);
    }
    onClose();
  });
  return (
    <Modal title={title} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Zielprojekt</span>
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {op === 'move' && <option value="">– wählen –</option>}
            {candidates.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}{p.id === source.id ? ' (dieses Projekt)' : ''}</option>)}
          </select>
          {op === 'move' && <span className="muted small">Im Zielprojekt brauchst du das Recht „Projektplan ändern“ oder die PL-Rolle.</span>}
        </label>
        {kind === 'task' && targetDetail && (
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label className="field"><span>Teilprojekt im Ziel</span>
              <select value={subId} onChange={(e) => setSubId(e.target.value)}><option value="">– keins –</option>{targetDetail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label className="field"><span>Spalte im Ziel</span>
              <select value={columnId} onChange={(e) => setColumnId(e.target.value)}><option value="">{targetId === source.id ? 'erste Spalte' : 'gleichnamige, sonst erste Spalte'}</option>{targetDetail.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          </div>
        )}
        {op === 'copy' && <label className="field"><span>{kind === 'task' ? 'Titel der Kopie' : 'Name der Kopie'}</span><input type="text" value={name} placeholder={kind === 'task' ? `${task?.title} (Kopie)` : `${subproject?.name} (Kopie)`} onChange={(e) => setName(e.target.value)} /></label>}
        <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px' }}>
          <legend className="small">Was mitgenommen wird</legend>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label className="check"><input type="radio" name="cm-mode" checked={mode === 'all'} onChange={() => setMode('all')} /> Alles</label>
            <label className="check"><input type="radio" name="cm-mode" checked={mode === 'all_except'} onChange={() => setMode('all_except')} /> Alles außer …</label>
            <label className="check"><input type="radio" name="cm-mode" checked={mode === 'only'} onChange={() => setMode('only')} /> Nichts außer …</label>
          </div>
          {mode !== 'all' && (
            <div className="mt" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 4 }}>
              {partList.filter((p) => allKeys.includes(p.key)).map((p) => (
                <label key={p.key} className="check" title={p.hint}><input type="checkbox" checked={picked.has(p.key)} onChange={() => toggle(p.key)} /> {p.label}{p.hint && <span className="muted small"> ({p.hint})</span>}</label>
              ))}
            </div>
          )}
          {mode === 'all' && <p className="muted small" style={{ margin: '6px 0 0' }}>{partList.filter((p) => allKeys.includes(p.key)).map((p) => p.label).join(', ')}</p>}
        </fieldset>
        {kind === 'subproject' && parts.includes('tasks') && tasks.length > 0 && (
          <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px' }}>
            <legend className="small">Arbeitspakete ({taskIds.size} von {tasks.length})<button type="button" className="btn sm link" onClick={() => setTaskIds(new Set(tasks.map((x) => x.id)))}>alle</button><button type="button" className="btn sm link" onClick={() => setTaskIds(new Set())}>keins</button></legend>
            <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 2 }}>
              {tasks.map((x) => <label key={x.id} className="check"><input type="checkbox" checked={taskIds.has(x.id)} onChange={() => toggleTask(x.id)} /> <span className="badge tkey-badge">{source.key}-{x.number}</span> {x.title}{x.done && <span className="muted small"> (erledigt)</span>}</label>)}
            </div>
            {op === 'move' && <p className="muted small" style={{ margin: '6px 0 0' }}>Abgewählte Arbeitspakete bleiben hier ohne Teilprojekt.</p>}
          </fieldset>
        )}
        {op === 'move' && <p className="muted small">Verschobene Arbeitspakete bekommen im Ziel eine neue Nummer; Links auf das Arbeitspaket bleiben gültig. Besprechungsbezüge entfallen.</p>}
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || !targetId} onClick={() => void submit()}>{op === 'copy' ? 'Kopieren' : 'Verschieben'}</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

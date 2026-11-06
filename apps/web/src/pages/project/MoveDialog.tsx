import { useMemo, useState } from 'react';
import type { ChecklistItem, Task } from '@projekttool/shared';
import { api } from '../../lib/api';
import { Modal, useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';

/**
 * Struktur ändern: Aufgabe in ein anderes Arbeitspaket (POST /tasks/:id/reparent), Aufgabe zum Arbeitspaket machen (parentId null,
 * Teilprojekt wählbar), Arbeitspaket einem Teilprojekt zuordnen, Checklistenpunkt in eine andere Aufgabe verschieben
 * (POST /tasks/:id/checklist/:itemId/move; Checklisten gehören zu Aufgaben) oder zur Aufgabe machen (…/promote), Aufgabe zum
 * Checklistenpunkt einer anderen Aufgabe desselben Arbeitspakets machen (POST /tasks/:id/demote {toTaskId}). Das Ziel wird über
 * Kennung oder Titel gesucht; alles bleibt im selben Projekt (Projektwechsel: CopyMove).
 */
export const SUBTASK_DRAG = 'application/x-projekttool-subtask';

/** Ziel-Arbeitspaket (oder -Aufgabe) suchen: Kennung oder Titel, ohne das ausgeschlossene; onlySubtasks: nur Aufgaben. */
export function TargetPicker({ value, onChange, exclude = [], withSubtasks = false, onlySubtasks = false, label = 'Ziel-Arbeitspaket' }: { value: string; onChange: (id: string) => void; exclude?: string[]; withSubtasks?: boolean; onlySubtasks?: boolean; label?: string }) {
  const { detail, tasks } = useProject();
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tasks
      .filter((x) => !x.archivedAt && !x.deletedAt && (onlySubtasks ? x.parentId != null : withSubtasks || !x.parentId) && !exclude.includes(x.id))
      .filter((x) => !needle || `${detail.project.key}-${x.number}`.toLowerCase().includes(needle) || x.title.toLowerCase().includes(needle))
      .sort((a, b) => Number(a.done) - Number(b.done) || Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)) || a.number - b.number)
      .slice(0, 40);
  }, [tasks, q, exclude.join(','), withSubtasks, onlySubtasks]);
  const spName = (id: string | null) => (id ? detail.subprojects.find((s) => s.id === id)?.name ?? null : null);
  return (
    <div className="field">
      <span>{label}</span>
      <input type="text" placeholder="Kennung oder Titel …" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`${label} suchen`} autoFocus />
      <div className="picker-list" role="listbox" aria-label={label}>
        {list.map((x) => (
          <label key={x.id} className={`check small ${value === x.id ? 'on' : ''}`}>
            <input type="radio" name="move-target" checked={value === x.id} onChange={() => onChange(x.id)} />
            <span className="tkey">{detail.project.key}-{x.number}</span> {x.parentId && !onlySubtasks ? <span className="muted">Aufgabe · </span> : null}{x.title}{onlySubtasks && x.parentId && <span className="muted"> · in {tasks.find((p) => p.id === x.parentId)?.title ?? 'Arbeitspaket'}</span>}{x.done && <span className="muted"> · erledigt</span>}{spName(x.subprojectId) && <span className="muted"> · {spName(x.subprojectId)}</span>}
          </label>
        ))}
        {list.length === 0 && <span className="muted small">Kein Treffer.</span>}
      </div>
    </div>
  );
}

export type MoveMode = 'reparent' | 'promote' | 'subproject';

/** Aufgabe verschieben (anderes AP), zum Arbeitspaket machen (Teilprojekt wählbar) oder Arbeitspaket einem Teilprojekt zuordnen. */
export function MoveTaskDialog({ task, mode, onClose, onDone }: { task: Task; mode: MoveMode; onClose: () => void; onDone: () => Promise<void> | void }) {
  const { detail } = useProject();
  const [target, setTarget] = useState('');
  const [sp, setSp] = useState<string>(task.parent ? '' : task.subprojectId ?? '');
  const { busy, error, run } = useAsync();
  const title = mode === 'reparent' ? 'Aufgabe verschieben' : mode === 'promote' ? 'Zum Arbeitspaket machen' : 'Teilprojekt ändern';
  const submit = () => run(async () => {
    if (mode === 'reparent') await api.post(`/tasks/${task.id}/reparent`, { parentId: target });
    else await api.post(`/tasks/${task.id}/reparent`, { parentId: null, subprojectId: sp || null });
    await onDone(); onClose();
  });
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        {mode === 'reparent' && <>
          <p className="muted small m-0">„{task.title}“ hängt danach unter dem gewählten Arbeitspaket desselben Projekts und nimmt Checkliste, Anhänge, Log und Zeiten mit; das Teilprojekt folgt dem Ziel. Die Zuständigen werden informiert.</p>
          <TargetPicker value={target} onChange={setTarget} exclude={[task.id, task.parentId ?? '']} />
        </>}
        {mode !== 'reparent' && <>
          <p className="muted small m-0">{mode === 'promote' ? `„${task.title}“ wird ein eigenes Arbeitspaket auf dem Board (Spalte des bisherigen Arbeitspakets).` : 'Aufgaben des Arbeitspakets folgen in das Teilprojekt.'}</p>
          <label className="field"><span>Ziel-Teilprojekt</span>
            <select value={sp} onChange={(e) => setSp(e.target.value)}><option value="">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}{s.restricted ? ' (eingeschränkt sichtbar)' : ''}</option>)}</select>
          </label>
        </>}
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || (mode === 'reparent' && !target)} onClick={() => void submit()}>{mode === 'reparent' ? 'Verschieben' : mode === 'promote' ? 'Zum Arbeitspaket machen' : 'Zuordnen'}</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/** Checklistenpunkt in eine andere Aufgabe verschieben (Checklisten gehören zu Aufgaben; Arbeitspakete sind kein Ziel). */
export function MoveItemDialog({ task, item, onClose, onDone }: { task: Task; item: ChecklistItem; onClose: () => void; onDone: () => Promise<void> | void }) {
  const [target, setTarget] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <Modal title="Checklistenpunkt verschieben" onClose={onClose}>
      <div className="stack">
        <p className="muted small m-0">„{item.title}“ wandert ans Ende der Checkliste der gewählten Aufgabe; beide Seiten bekommen einen Log-Eintrag. Checklisten gehören zu Aufgaben, Arbeitspakete sind kein Ziel.</p>
        <TargetPicker value={target} onChange={setTarget} exclude={[task.id]} onlySubtasks label="Ziel-Aufgabe" />
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || !target} onClick={() => void run(async () => { await api.post(`/tasks/${task.id}/checklist/${item.id}/move`, { toTaskId: target }); await onDone(); onClose(); })}>Verschieben</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/** Checklistenpunkt wird Aufgabe (am Arbeitspaket): Titel, Termin, Zuständigkeit. */
export function PromoteItemDialog({ task, item, members, onClose, onDone }: { task: Task; item: ChecklistItem; members: { id: string; name: string }[]; onClose: () => void; onDone: (newTaskId: string) => Promise<void> | void }) {
  const [title, setTitle] = useState(item.title);
  const [due, setDue] = useState('');
  const [resp, setResp] = useState(item.responsibleUserId ?? '');
  const { busy, error, run } = useAsync();
  return (
    <Modal title="In Aufgabe umwandeln" onClose={onClose}>
      <div className="stack">
        <p className="muted small m-0">Der Punkt wird eine Aufgabe {task.parentId ? 'am Arbeitspaket darüber' : 'dieses Arbeitspakets'} mit eigenem Status, Termin und Log; der Checklistenpunkt entfällt.</p>
        <label className="field"><span>Titel</span><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="form cols-2">
          <label className="field"><span>Deadline der Aufgabe</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <label className="field"><span>Zuständig</span><select value={resp} onChange={(e) => setResp(e.target.value)}><option value="">geerbt</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || !title.trim()} onClick={() => void run(async () => { const r = await api.post<{ task: Task }>(`/tasks/${task.id}/checklist/${item.id}/promote`, { title: title.trim(), dueDate: due || null, responsibleUserId: resp || null }); await onDone(r.task.id); onClose(); })}>Aufgabe anlegen</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/**
 * Aufgabe wird Checklistenpunkt einer anderen Aufgabe desselben Arbeitspakets (POST /tasks/:id/demote {toTaskId}).
 * Gibt es genau eine andere Aufgabe, ist sie vorausgewählt; ohne andere Aufgabe geht es nicht.
 */
export function DemoteDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: (r: { task: Task; ap: Task; itemId: string }) => Promise<void> | void }) {
  const { detail, tasks } = useProject();
  const others = useMemo(() => tasks.filter((x) => x.parentId === task.parentId && x.id !== task.id && !x.archivedAt && !x.deletedAt)
    .sort((a, b) => Number(a.done) - Number(b.done) || a.position - b.position || a.number - b.number), [tasks, task.id, task.parentId]);
  const [target, setTarget] = useState(others.length === 1 ? others[0].id : '');
  const { busy, error, run } = useAsync();
  const sel = others.find((x) => x.id === target);
  return (
    <Modal title="Zu Checklistenpunkt machen" onClose={onClose}>
      <div className="stack">
        {others.length === 0
          ? <p className="m-0">Im Arbeitspaket „{task.parent?.title ?? ''}“ gibt es keine andere Aufgabe. Checklistenpunkte gehören zu Aufgaben: lege dort zuerst eine Aufgabe an.</p>
          : <>
            <div className="field"><span>Ziel-Aufgabe</span>
              <div className="picker-list" role="listbox" aria-label="Ziel-Aufgabe">
                {others.map((x) => (
                  <label key={x.id} className={`check small ${target === x.id ? 'on' : ''}`}>
                    <input type="radio" name="demote-target" checked={target === x.id} onChange={() => setTarget(x.id)} />
                    <span className="tkey">{detail.project.key}-{x.number}</span> {x.title}{x.done && <span className="muted"> · erledigt</span>}
                  </label>
                ))}
              </div>
            </div>
            <p className="muted small m-0">„{task.title}“ wird Checklistenpunkt der Aufgabe {sel ? `„${sel.title}“` : '…'}. Verloren gehen eigener Status, Termin, Beschreibung und Labels; Log und Kommentare werden als ein Eintrag an der Ziel-Aufgabe zusammengefasst, Anhänge und Checkliste wandern dorthin. Nicht möglich mit Zeitbuchungen, verknüpften Mails oder offenen Fragen.</p>
          </>}
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary danger" disabled={busy || !target} onClick={() => void run(async () => { const r = await api.post<{ task: Task; ap: Task; itemId: string }>(`/tasks/${task.id}/demote`, { toTaskId: target }); await onDone(r); onClose(); })}>Zu Checklistenpunkt machen</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

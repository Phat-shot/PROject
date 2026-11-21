/**
 * Bausteine, die Aufgaben und Checklistenpunkte überall gleich unterscheiden:
 * Aufgabe = runder Status-Knopf + Kennung (eigener Status, Termin, Zuständigkeit, Log),
 * Checklistenpunkt = kleine eckige Checkbox innerhalb der Aufgabe.
 */
import type { ReactNode } from 'react';
import { IconChecklist, IconCircle, IconCircleCheck, IconCircleDot, IconListTodo } from './icons';

export const HELP_TASKS = 'Aufgabe: eigener Status, Termin, Zuständigkeit und Log; runder Knopf = erledigt / wieder offen.';
export const HELP_CHECKLIST = 'Checklistenpunkt: wird innerhalb der Aufgabe abgehakt (eckige Checkbox); kein eigener Status oder Termin.';

/** Status einer Aufgabe: offen, in Arbeit (aktive Spalte oder Prüfung) oder erledigt. */
export type TaskState = 'open' | 'progress' | 'done';
export const taskState = (done: boolean, colKind: string | undefined): TaskState => (done ? 'done' : colKind === 'active' || colKind === 'review' ? 'progress' : 'open');
const STATE_LABEL: Record<TaskState, string> = { open: 'offen', progress: 'in Arbeit', done: 'erledigt' };

/** Rundes Status-Symbol einer Aufgabe (nur Anzeige). */
export function TaskStateIcon({ state, size = 16 }: { state: TaskState; size?: number }) {
  const C = state === 'done' ? IconCircleCheck : state === 'progress' ? IconCircleDot : IconCircle;
  return <C size={size} className={`task-state is-${state}`} />;
}

/** Runder Status-Knopf einer Aufgabe: Klick setzt auf erledigt bzw. wieder offen. */
export function TaskStatusButton({ title, state, disabled, onToggle, size = 16 }: { title: string; state: TaskState; disabled?: boolean; onToggle: () => void; size?: number }) {
  const label = state === 'done' ? `„${title}“ wieder öffnen` : `„${title}“ als erledigt markieren`;
  return (
    <button type="button" className={`task-status-btn is-${state}`} disabled={disabled} aria-label={label} title={`Aufgabe ${STATE_LABEL[state]} – ${state === 'done' ? 'Klick öffnet wieder' : 'Klick setzt auf erledigt'}`} onClick={onToggle}>
      <TaskStateIcon state={state} size={size} />
    </button>
  );
}

/** Kennung einer Aufgabe als kleines Badge (z. B. WEB-14). */
export function TaskKey({ projectKey, number }: { projectKey: string; number: number }) {
  return <span className="task-key" title="Kennung der Aufgabe, auch in der Suche">{projectKey}-{number}</span>;
}

/** Überschrift „Aufgaben“ bzw. „Checkliste“ mit Icon, Zähler und Hilfetext. */
export function ItemsHeading({ kind, done, total, level = 3, children }: { kind: 'tasks' | 'checklist'; done?: number; total?: number; level?: 3 | 4; children?: ReactNode }) {
  const H = level === 3 ? 'h3' : 'h4';
  const Icon = kind === 'tasks' ? IconListTodo : IconChecklist;
  const help = kind === 'tasks' ? HELP_TASKS : HELP_CHECKLIST;
  return (
    <H className={`items-head ${kind} ${level === 4 ? 'small' : 'mt'}`} title={help}>
      <Icon size={level === 3 ? 16 : 14} />{children ?? (kind === 'tasks' ? 'Aufgaben' : 'Checkliste')}
      {total != null && total > 0 && <span className="badge">{done ?? 0}/{total}</span>}
      <span className="sr-only">. {help}</span>
    </H>
  );
}

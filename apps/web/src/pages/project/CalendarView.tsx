import { useMemo } from 'react';
import { Calendar, type CalItem } from '../../components/Calendar';
import { useProject } from '../ProjectPage';

/** Projektkalender: Deadlines, Starts und Meilensteine des Projekts. */
export function CalendarView() {
  const { detail, tasks, openTask } = useProject();
  const items = useMemo<CalItem[]>(() => [
    ...tasks.filter((x) => x.dueDate).map((x) => ({ id: x.id, kind: 'task' as const, title: x.title, start: x.startDate, date: x.dueDate!, done: x.done, onOpen: () => openTask(x.id) })),
    ...detail.milestones.map((m) => ({ id: m.id, kind: 'ms' as const, title: m.name, start: null, date: m.date }))
  ], [tasks, detail.milestones]);
  return (
    <div className="content">
      <Calendar items={items} hint="Deadlines, Starts (▶) und Meilensteine (◆). Kalender-Anbindung (M365, Google, CalDAV) folgt." />
    </div>
  );
}

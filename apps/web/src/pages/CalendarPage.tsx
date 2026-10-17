import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { Calendar, type CalItem } from '../components/Calendar';

interface CalMilestone { id: string; name: string; date: string; projectId: string; projectKey: string }

/** Kalender über alle Projekte: offene Arbeitspakete mit Termin und alle Meilensteine. */
export function CalendarPage() {
  const nav = useNavigate();
  const tasks = useData<{ tasks: (Task & { projectKey: string })[] }>('/my/tasks?scope=all');
  const ms = useData<{ milestones: CalMilestone[] }>('/my/calendar');
  const items = useMemo<CalItem[]>(() => [
    ...(tasks.data?.tasks ?? []).filter((x) => x.dueDate).map((x) => ({ id: x.id, kind: 'task' as const, title: x.title, start: x.startDate, date: x.dueDate!, done: x.done, projectKey: x.projectKey, onOpen: () => nav(`/projekte/${x.projectId}/board?task=${x.id}`) })),
    ...(ms.data?.milestones ?? []).map((m) => ({ id: m.id, kind: 'ms' as const, title: m.name, start: null, date: m.date, projectKey: m.projectKey, onOpen: () => nav(`/projekte/${m.projectId}/plan`) }))
  ], [tasks.data, ms.data]);
  return (
    <>
      <TopBar title="Kalender" />
      <div className="content">
        {(tasks.error || ms.error) && <div className="error mb">{tasks.error ?? ms.error}</div>}
        <Calendar items={items} hint="Alle Projekte: offene Arbeitspakete mit Termin und Meilensteine." />
      </div>
    </>
  );
}

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { Calendar, type CalItem } from '../components/Calendar';

interface CalMilestone { id: string; name: string; date: string; projectId: string; projectKey: string }
interface CalMeeting { id: string; title: string; startsAt: string; endsAt: string; projectId: string; projectKey: string; tentative?: boolean }
const localDate = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Kalender über alle Projekte: offene Arbeitspakete mit Termin und alle Meilensteine. */
export function CalendarPage() {
  const nav = useNavigate();
  const tasks = useData<{ tasks: (Task & { projectKey: string })[] }>('/my/tasks?scope=all');
  const ms = useData<{ milestones: CalMilestone[]; meetings?: CalMeeting[] }>('/my/calendar');
  const items = useMemo<CalItem[]>(() => [
    ...(tasks.data?.tasks ?? []).filter((x) => x.dueDate).map((x) => ({ id: x.id, kind: 'task' as const, title: x.title, start: x.startDate, date: x.dueDate!, done: x.done, projectKey: x.projectKey, onOpen: () => nav(`/projekte/${x.projectId}/board?task=${x.id}`) })),
    ...(ms.data?.milestones ?? []).map((m) => ({ id: m.id, kind: 'ms' as const, title: m.name, start: null, date: m.date, projectKey: m.projectKey, onOpen: () => nav(`/projekte/${m.projectId}/plan`) })),
    ...(ms.data?.meetings ?? []).map((m) => ({ id: m.id, kind: 'meeting' as const, title: m.tentative ? `(vorläufig) ${m.title}` : m.title, start: null, date: localDate(m.startsAt), time: new Date(m.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), projectKey: m.projectKey, onOpen: () => nav(`/projekte/${m.projectId}/besprechungen`) }))
  ], [tasks.data, ms.data]);
  return (
    <>
      <TopBar title="Kalender" />
      <div className="content">
        {(tasks.error || ms.error) && <div className="error mb">{tasks.error ?? ms.error}</div>}
        <Calendar items={items} hint="Alle Projekte: offene Arbeitspakete mit Termin, Meilensteine und Besprechungen." />
      </div>
    </>
  );
}

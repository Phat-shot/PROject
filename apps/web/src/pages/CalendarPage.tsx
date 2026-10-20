import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Resource, ResourceBooking, Task } from '@projekttool/shared';
import { useAuth } from '../lib/auth';
import { Occupancy, bookingTitle } from '../components/Resources';
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
  const { user } = useAuth();
  const [params] = useSearchParams();
  const own = useData<{ bookings: ResourceBooking[] }>(user ? `/bookings?userId=${user.id}` : null, [user?.id]);
  const pool = useData<{ resources: Resource[] }>('/resources');
  const poolBookings = useData<{ bookings: ResourceBooking[] }>('/bookings?pool=1');
  const items = useMemo<CalItem[]>(() => [
    ...(tasks.data?.tasks ?? []).filter((x) => x.dueDate).map((x) => ({ id: x.id, kind: 'task' as const, title: x.title, start: x.startDate, date: x.dueDate!, done: x.done, projectKey: x.projectKey, onOpen: () => nav(`/projekte/${x.projectId}/board?task=${x.id}`) })),
    ...(ms.data?.milestones ?? []).map((m) => ({ id: m.id, kind: 'ms' as const, title: m.name, start: null, date: m.date, projectKey: m.projectKey, onOpen: () => nav(`/projekte/${m.projectId}/plan`) })),
    ...(ms.data?.meetings ?? []).map((m) => ({ id: m.id, kind: 'meeting' as const, title: m.tentative ? `(vorläufig) ${m.title}` : m.title, start: null, date: localDate(m.startsAt), time: new Date(m.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), projectKey: m.projectKey, onOpen: () => nav(`/projekte/${m.projectId}/besprechungen`) })),
    ...(own.data?.bookings ?? []).map((b) => ({ id: b.id, kind: 'booking' as const, title: `${b.tentative ? '(vorläufig) ' : ''}${bookingTitle(b)}`, start: b.allDay && localDate(b.startsAt) !== localDate(new Date(new Date(b.endsAt).getTime() - 1).toISOString()) ? localDate(b.startsAt) : null, date: localDate(new Date(new Date(b.endsAt).getTime() - (b.allDay ? 1 : 0)).toISOString()), time: b.allDay ? undefined : new Date(b.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), projectKey: b.projectKey ?? undefined, onOpen: b.projectId ? () => nav(`/projekte/${b.projectId}/kalender?ansicht=belegung&datum=${localDate(b.startsAt)}`) : undefined }))
  ], [tasks.data, ms.data, own.data]);
  const rows = [
    ...(user ? [{ key: `u:${user.id}`, label: `${user.name} (ich)`, kind: 'person', match: (b: ResourceBooking) => b.userId === user.id }] : []),
    ...(pool.data?.resources ?? []).filter((r) => r.active).map((r) => ({ key: `r:${r.id}`, label: r.name, kind: r.kind, match: (b: ResourceBooking) => b.resourceId === r.id }))
  ];
  const occupancy = <Occupancy bookings={[...(own.data?.bookings ?? []), ...(poolBookings.data?.bookings ?? [])]} rows={rows} start={params.get('datum')} onPick={(b) => { if (b.projectId) nav(`/projekte/${b.projectId}/kalender?ansicht=belegung&datum=${localDate(b.startsAt)}`); }} />;
  return (
    <>
      <TopBar title="Kalender" />
      <div className="content">
        {(tasks.error || ms.error) && <div className="error mb">{tasks.error ?? ms.error}</div>}
        <Calendar items={items} hint="Alle Projekte: offene Arbeitspakete mit Termin, Meilensteine, Besprechungen und eigene Belegungen (▭)." occupancy={occupancy} initialMode={params.get('ansicht') === 'belegung' ? 'occupancy' : null} />
      </div>
    </>
  );
}

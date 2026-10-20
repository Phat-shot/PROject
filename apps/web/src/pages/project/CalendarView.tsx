import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Meeting, Resource, ResourceBooking } from '@projekttool/shared';
import { useSearchParams } from 'react-router-dom';
import { BookingForm, Occupancy, bookingTitle, kindLabel } from '../../components/Resources';
import { useData } from '../../lib/useData';
import { api } from '../../lib/api';
import { Calendar, type CalItem } from '../../components/Calendar';
import { useProject } from '../ProjectPage';

/** Projektkalender: Deadlines, Starts und Meilensteine des Projekts. */
export function CalendarView() {
  const { detail, tasks, openTask } = useProject();
  const [msg, setMsg] = useState<string | null>(null);
  const meetings = useData<{ meetings: Meeting[] }>(`/projects/${detail.project.id}/meetings`);
  const [params] = useSearchParams();
  const bookings = useData<{ bookings: ResourceBooking[] }>(`/bookings?projectId=${detail.project.id}`);
  const resources = useData<{ resources: Resource[] }>(`/resources?projectId=${detail.project.id}`);
  const rights = useData<{ canForce: boolean; canBook: boolean }>(`/projects/${detail.project.id}/my-booking-rights`);
  const [book, setBook] = useState<{ resourceId?: string; userId?: string; name: string } | 'any' | null>(null);
  const persons = detail.members.filter((m) => m.kind !== 'agent').map((m) => ({ id: m.userId, name: m.name }));
  const canBook = rights.data?.canBook ?? detail.project.myMembership.role !== 'reader';
  const localDate = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const subscribe = async () => {
    const cur = await api.get<{ urls: { project: string } | null; token: string | null }>('/me/ics-token');
    const token = cur.token ?? (await api.post<{ token: string }>('/me/ics-token')).token;
    const url = `${window.location.origin}/api/ics/${token}/projekt/${detail.project.id}.ics`;
    try { await navigator.clipboard.writeText(url); setMsg('Abo-Adresse kopiert: in Outlook, Google oder Apple Kalender als Abonnement einfügen.'); } catch { setMsg(url); }
  };
  const items = useMemo<CalItem[]>(() => [
    ...tasks.filter((x) => x.dueDate).map((x) => ({ id: x.id, kind: 'task' as const, title: x.title, start: x.startDate, date: x.dueDate!, done: x.done, onOpen: () => openTask(x.id) })),
    ...detail.milestones.map((m) => ({ id: m.id, kind: 'ms' as const, title: m.name, start: null, date: m.date })),
    ...(meetings.data?.meetings ?? []).map((m) => ({ id: m.id, kind: 'meeting' as const, title: m.tentative ? `(vorläufig) ${m.title}` : m.title, start: null, date: localDate(m.startsAt), time: new Date(m.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) })),
    ...(bookings.data?.bookings ?? []).filter((b) => !b.meetingId).map((b) => ({ id: b.id, kind: 'booking' as const, title: `${b.tentative ? '(vorläufig) ' : ''}${b.resourceName ?? b.userName ?? ''}: ${bookingTitle(b)}`, start: b.allDay && localDate(b.startsAt) !== localDate(new Date(new Date(b.endsAt).getTime() - 1).toISOString()) ? localDate(b.startsAt) : null, date: localDate(new Date(new Date(b.endsAt).getTime() - (b.allDay ? 1 : 0)).toISOString()), time: b.allDay ? undefined : new Date(b.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), onOpen: b.taskId ? () => openTask(b.taskId!) : undefined }))
  ], [tasks, detail.milestones, meetings.data, bookings.data]);
  const rows = [
    ...(resources.data?.resources ?? []).filter((r) => r.active).map((r) => ({ key: `r:${r.id}`, label: `${r.name}${r.projectId ? '' : ' (Pool)'}`, kind: r.kind, match: (b: ResourceBooking) => b.resourceId === r.id })),
    ...persons.map((u) => ({ key: `u:${u.id}`, label: u.name, kind: 'person', match: (b: ResourceBooking) => b.userId === u.id }))
  ];
  const occupancy = <>
    <Occupancy bookings={bookings.data?.bookings ?? []} rows={rows} start={params.get('datum')} onPick={(b) => { if (b.taskId) openTask(b.taskId); }} onBook={canBook ? (r) => setBook(r.key.startsWith('r:') ? { resourceId: r.key.slice(2), name: r.label } : { userId: r.key.slice(2), name: r.label }) : undefined} />
    <div className="row mt small">{canBook && <button className="btn sm" onClick={() => setBook('any')}>Buchen …</button>}<Link className="btn sm" to={`/projekte/${detail.project.id}/einstellungen/planung`}>Ressourcen des Projekts</Link><span className="muted">{(resources.data?.resources ?? []).length} Ressourcen ({(resources.data?.resources ?? []).map((r) => kindLabel(r.kind)).filter((v, i, a) => a.indexOf(v) === i).join(', ') || '–'})</span></div>
  </>;
  return (
    <div className="content">
      <Calendar items={items} hint="Deadlines, Starts (▶), Meilensteine (◆), Besprechungen mit Uhrzeit und Belegungen (▭)." occupancy={occupancy} initialMode={params.get('ansicht') === 'belegung' ? 'occupancy' : null} />
      {book && <BookingForm projectId={detail.project.id} target={book === 'any' ? null : book.resourceId ? { resourceId: book.resourceId, name: book.name } : { userId: book.userId!, name: book.name }} resources={resources.data?.resources ?? []} persons={persons} canForce={rights.data?.canForce} onClose={() => setBook(null)} onSaved={async () => { setBook(null); await bookings.reload(); }} />}
      <div className="row mt small"><button className="btn sm" onClick={() => void subscribe()}>Als Kalender abonnieren (ICS)</button><Link className="btn sm" to={`/projekte/${detail.project.id}/besprechungen`}>Besprechungen</Link>{msg && <span className="muted">{msg}</span>}</div>
    </div>
  );
}

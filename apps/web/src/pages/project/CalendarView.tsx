import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Meeting } from '@projekttool/shared';
import { useData } from '../../lib/useData';
import { api } from '../../lib/api';
import { Calendar, type CalItem } from '../../components/Calendar';
import { useProject } from '../ProjectPage';

/** Projektkalender: Deadlines, Starts und Meilensteine des Projekts. */
export function CalendarView() {
  const { detail, tasks, openTask } = useProject();
  const [msg, setMsg] = useState<string | null>(null);
  const meetings = useData<{ meetings: Meeting[] }>(`/projects/${detail.project.id}/meetings`);
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
    ...(meetings.data?.meetings ?? []).map((m) => ({ id: m.id, kind: 'meeting' as const, title: m.tentative ? `(vorläufig) ${m.title}` : m.title, start: null, date: localDate(m.startsAt), time: new Date(m.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) }))
  ], [tasks, detail.milestones, meetings.data]);
  return (
    <div className="content">
      <Calendar items={items} hint="Deadlines, Starts (▶), Meilensteine (◆) und Besprechungen mit Uhrzeit." />
      <div className="row mt small"><button className="btn sm" onClick={() => void subscribe()}>Als Kalender abonnieren (ICS)</button><Link className="btn sm" to={`/projekte/${detail.project.id}/besprechungen`}>Besprechungen</Link>{msg && <span className="muted">{msg}</span>}</div>
    </div>
  );
}

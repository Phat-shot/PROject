import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { Calendar, type CalItem } from '../../components/Calendar';
import { useProject } from '../ProjectPage';

/** Projektkalender: Deadlines, Starts und Meilensteine des Projekts. */
export function CalendarView() {
  const { detail, tasks, openTask } = useProject();
  const [msg, setMsg] = useState<string | null>(null);
  const subscribe = async () => {
    const cur = await api.get<{ urls: { project: string } | null; token: string | null }>('/me/ics-token');
    const token = cur.token ?? (await api.post<{ token: string }>('/me/ics-token')).token;
    const url = `${window.location.origin}/api/ics/${token}/projekt/${detail.project.id}.ics`;
    try { await navigator.clipboard.writeText(url); setMsg('Abo-Adresse kopiert: in Outlook, Google oder Apple Kalender als Abonnement einfügen.'); } catch { setMsg(url); }
  };
  const items = useMemo<CalItem[]>(() => [
    ...tasks.filter((x) => x.dueDate).map((x) => ({ id: x.id, kind: 'task' as const, title: x.title, start: x.startDate, date: x.dueDate!, done: x.done, onOpen: () => openTask(x.id) })),
    ...detail.milestones.map((m) => ({ id: m.id, kind: 'ms' as const, title: m.name, start: null, date: m.date }))
  ], [tasks, detail.milestones]);
  return (
    <div className="content">
      <Calendar items={items} hint="Deadlines, Starts (▶) und Meilensteine (◆)." />
      <div className="row mt small"><button className="btn sm" onClick={() => void subscribe()}>Als Kalender abonnieren (ICS)</button>{msg && <span className="muted">{msg}</span>}</div>
    </div>
  );
}

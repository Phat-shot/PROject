import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { dispatch, dmChannel, notify, projectChannelId } from '../notify.js';
import { insertTask } from '../tasks/service.js';
import { queueAgentRun } from './agentEvents.js';

/**
 * Planen durch KI (Agent als Zuständiger oder stellvertretende PL, Projekt-KI aus dem Ordner „KI Bearbeiten“): Aufgaben und
 * Arbeitspakete anlegen, zuweisen, Termine setzen, Termine im Projektkalender. Die Rechteprüfung je Aktion macht der Aufrufer;
 * hier liegen Auflösung (Kennung, Person, Datum) und das Anlegen mit Log, Audit und Benachrichtigung.
 */
export interface PlanActor { id: string; name: string; orgId: string; role: string; label: string; isAgent: boolean }

/** Effektive Zuständigkeit wie mapTask: direkt → extern → Arbeitspaket → extern am AP → Teilprojekt (PL-Ende ausgelassen; Agenten sind nie verantwortliche PL). Aliase t, pt, s aus EFFECTIVE_JOINS. */
export const EFFECTIVE_RESPONSIBLE_SQL = `case when t.responsible_user_id is not null then t.responsible_user_id when t.responsible_email is not null then null when pt.responsible_user_id is not null then pt.responsible_user_id when pt.responsible_email is not null then null else s.responsible_user_id end`;
export const EFFECTIVE_JOINS = `left join tasks pt on pt.id = t.parent_id left join subprojects s on s.id = t.subproject_id`;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Heute und die nächsten 14 Tage in Europe/Berlin mit Wochentag und Kalenderwoche, damit Modelle Fristen wie „Ende der Woche“
 * oder „morgen“ nicht selbst ausrechnen: „Mi 21.10.2026 (KW 43). Kalender: Do 22.10., Fr 23.10. (Ende der Woche), Sa 24.10. …“
 */
export function calendarText(now: Date, days = 14): string {
  const tz = 'Europe/Berlin';
  const wd = (d: Date) => new Intl.DateTimeFormat('de-DE', { timeZone: tz, weekday: 'short' }).format(d).replace('.', '');
  const dm = (d: Date) => new Intl.DateTimeFormat('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(d);
  const ymdB = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const base = new Date(`${ymdB}T12:00:00Z`);
  const iso = new Date(base); const dayNr = (base.getUTCDay() + 6) % 7; iso.setUTCDate(base.getUTCDate() - dayNr + 3);
  const kw = 1 + Math.round(((iso.getTime() - Date.UTC(iso.getUTCFullYear(), 0, 4)) / 86400000 - 3 + ((new Date(Date.UTC(iso.getUTCFullYear(), 0, 4)).getUTCDay() + 6) % 7)) / 7);
  const list: string[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    const sameWeek = i <= 6 - dayNr;
    const note = sameWeek && d.getUTCDay() === 5 ? ' (Ende der Woche)' : sameWeek && (d.getUTCDay() === 6 || d.getUTCDay() === 0) ? ' (Wochenende)' : d.getUTCDay() === 1 && i <= 7 ? ' (nächste Woche)' : i === 1 ? ' (morgen)' : '';
    list.push(`${wd(d)} ${dm(d)}${i === 1 && note !== ' (morgen)' ? ' (morgen)' : ''}${note}`);
  }
  return `${wd(base)} ${dm(base)}${base.getUTCFullYear()} (KW ${kw}, Europe/Berlin). Kalender: ${list.join(', ')}`;
}

/** Titel aus Modellen: vorangestellte Kennungen („AGP-0: …“, „[WEB-12] …“) entfernen; die Kennung vergibt das System. */
export function cleanTitle(v: unknown, max = 200): string {
  return String(v ?? '').trim().replace(/^\[?[A-Z][A-Z0-9]{1,9}-\d+\]?\s*[:–—-]?\s*/, '').trim().slice(0, max);
}

/**
 * Datum als YYYY-MM-DD oder null; ungültige Werte liefern undefined (Aufrufer meldet den Fehler). Nimmt auch, was Modelle und
 * Menschen schreiben: ISO mit Uhrzeit, „8.11.2026“, „8.11.“ (dieses Jahr, liegt es mehr als zwei Monate zurück: nächstes) und
 * Spannen „6.–8.11.“ (pick: start = erster, end = letzter Tag).
 */
export function ymd(v: unknown, pick: 'start' | 'end' = 'end', now = new Date()): string | null | undefined {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const valid = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : undefined; };
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (iso) return valid(+iso[1], +iso[2], +iso[3]);
  // Spanne: zwei Datumsangaben mit Strich, Gedankenstrich oder „bis“; dem ersten Teil fehlende Monate und Jahre vom zweiten
  const parts = s.split(/\s*(?:–|—|-|bis)\s*/).filter(Boolean);
  const de = (x: string) => x.match(/^(\d{1,2})\.(?:(\d{1,2})\.?(?:(\d{2}|\d{4}))?)?$/);
  const last = de(parts[parts.length - 1] ?? '');
  const first = de(parts[0] ?? '');
  if (!last || !first || parts.length > 2) return undefined;
  const month = Number(last[2] ?? NaN);
  if (!month) return undefined;
  const yearOf = (y: string | undefined, m: number, d: number) => {
    if (y) return y.length === 2 ? 2000 + Number(y) : Number(y);
    const cur = now.getUTCFullYear();
    return new Date(Date.UTC(cur, m - 1, d)).getTime() < now.getTime() - 62 * 86400_000 ? cur + 1 : cur;
  };
  const use = pick === 'start' ? first : last;
  const m = Number(use[2] ?? month);
  const d = Number(use[1]);
  return valid(yearOf(use[3] ?? last[3], m, d), m, d);
}

/** Zuständige Person aus E-Mail oder Name: aktives Projektmitglied (Agenten nur durch die PL) oder externe Adresse; leer = keine. */
export async function resolvePerson(db: Db, projectId: string, actor: PlanActor, value: unknown): Promise<{ userId: string | null; email: string | null; name: string | null; kind: string | null } | { error: string }> {
  const v = String(value ?? '').trim();
  if (!v) return { userId: null, email: null, name: null, kind: null };
  const row = await db.maybeOne(`select u.id, u.kind, u.name from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.active and (lower(u.email) = lower($2) or lower(u.name) = lower($2)) limit 1`, [projectId, v]);
  if (row) {
    if (row.kind === 'agent' && actor.role !== 'pl') return { error: `${row.name} ist ein KI-Agent; Agenten weist nur die Projektleitung zu` };
    return { userId: row.id, email: null, name: row.name, kind: row.kind };
  }
  if (EMAIL.test(v)) return { userId: null, email: v.toLowerCase(), name: null, kind: 'external' };
  return { error: `„${v}“ ist kein Mitglied des Projekts` };
}

/** Arbeitspaket/Aufgabe über die Kennung (WEB-12 oder 12), sonst über den eindeutigen Titel; mit effektiver Zuständigkeit. */
export async function findTaskByRef(db: Db, projectId: string, ref: unknown): Promise<any | null> {
  const v = String(ref ?? '').trim();
  if (!v) return null;
  const sel = `select t.*, c.is_done, (${EFFECTIVE_RESPONSIBLE_SQL}) as eff_responsible from tasks t join board_columns c on c.id = t.column_id ${EFFECTIVE_JOINS} where t.project_id = $1 and t.deleted_at is null and t.archived_at is null`;
  const m = v.match(/^(?:[\p{L}\d]+-)?(\d+)$/u);
  if (m) return db.maybeOne(`${sel} and t.number = $2`, [projectId, Number(m[1])]);
  const rows = await db.query(`${sel} and lower(t.title) = lower($2) limit 2`, [projectId, v.replace(/^„|“$/g, '')]);
  return rows.rows.length === 1 ? rows.rows[0] : null;
}

/** Anlegen mit Tasks (Checkliste), Log am Arbeitspaket (bei Aufgaben) bzw. am auslösenden Arbeitspaket, Audit, Benachrichtigung der zuständigen Person. */
export async function createPlannedTask(db: Db, actor: PlanActor, p: { projectId: string; projectKey: string; title: string; description?: string | null; parentId?: string | null; subprojectId?: string | null; startDate?: string | null; dueDate?: string | null; responsibleUserId?: string | null; responsibleEmail?: string | null; responsibleKind?: string | null; items?: unknown; logTaskId?: string | null }): Promise<{ id: string; number: number; title: string }> {
  const title = p.title.trim().slice(0, 200);
  const t = await insertTask(db, { projectId: p.projectId, subprojectId: p.subprojectId ?? null, title, description: p.description?.trim() || null, startDate: p.startDate ?? null, dueDate: p.dueDate ?? null, responsibleUserId: p.responsibleUserId ?? null, responsibleEmail: p.responsibleEmail ?? null, createdBy: actor.id, parentId: p.parentId ?? null });
  const items = (Array.isArray(p.items) ? p.items : []).map((x) => String(x ?? '').trim().slice(0, 300)).filter(Boolean).slice(0, 15);
  for (const [i, it] of items.entries()) await db.query(`insert into checklist_items (task_id, title, position) values ($1,$2,$3)`, [t.id, it, i + 1]);
  const code = `${p.projectKey}-${t.number}`;
  const logOn = p.parentId ?? p.logTaskId ?? null;
  if (logOn) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [logOn, actor.id, `${p.parentId ? 'Aufgabe' : 'Arbeitspaket'} angelegt: ${code} „${title}“${p.dueDate ? `, Termin ${p.dueDate}` : ''}`]);
  await audit(db, { orgId: actor.orgId, projectId: p.projectId, userId: actor.id, action: 'task.create', objectType: 'task', objectId: t.id, details: { title, by: actor.label, ...(p.parentId ? { parentId: p.parentId } : {}) } });
  await afterAssign(db, actor, p.projectId, t.id, title, p.responsibleUserId ?? null, p.responsibleKind ?? null);
  return { id: t.id, number: t.number, title };
}

/** Zuweisung wirksam machen: Personen benachrichtigen (Klasse assigned, Empfänger nach Regel N), andere Agenten starten (eigene Arbeit nimmt der Worker beim nächsten Takt auf). */
export async function afterAssign(db: Db, actor: PlanActor, projectId: string, taskId: string, title: string, userId: string | null, kind: string | null) {
  if (!userId || userId === actor.id) return;
  if (kind === 'agent') { queueAgentRun(taskId, 'assigned'); return; }
  await dispatch(db, { event: 'assigned', projectId, taskId, type: 'task.assigned', title: `Dir zugewiesen: ${title}`, body: `von ${actor.label}`, link: `/projekte/${projectId}/board?task=${taskId}`, ref: { type: 'task', id: taskId }, actorId: actor.id });
}

/** Termin im Projektkalender (Besprechung ohne Einladung), vorläufig bis eine Person ihn bestätigt (confirmedBy: Person hat den Vorschlag angenommen); optional mit dem Arbeitspaket verknüpft. */
export async function createPlannedEvent(db: Db, actor: PlanActor, p: { projectId: string; title: string; startsAt: Date; endsAt: Date; location?: string | null; description?: string | null; taskId?: string | null; confirmedBy?: string | null; /** Teilnehmer (Ansprechpartner, genannte Adressen), damit der Termin als belegt zählt */ attendees?: { userId?: string | null; email: string; name?: string | null }[] }): Promise<{ id: string }> {
  const attendees = (p.attendees ?? []).filter((a, i, xs) => a.email && xs.findIndex((x) => x.email.toLowerCase() === a.email.toLowerCase()) === i);
  const r = await db.one(`insert into meetings (project_id, title, starts_at, ends_at, location, description, attendees, created_by, tentative, confirmed_by, confirmed_at) values ($1,$2,$3,$4,$5,$6,$9,$7,$8::uuid is null,$8,case when $8::uuid is null then null else now() end) returning id`,
    [p.projectId, p.title.trim().slice(0, 200), p.startsAt, p.endsAt, p.location?.trim().slice(0, 200) || null, p.description?.trim().slice(0, 4000) || null, actor.id, p.confirmedBy ?? null, JSON.stringify(attendees)]);
  if (p.taskId) await db.query(`insert into meeting_tasks (meeting_id, task_id) values ($1,$2) on conflict do nothing`, [r.id, p.taskId]);
  await audit(db, { orgId: actor.orgId, projectId: p.projectId, userId: actor.id, action: 'meeting.create', objectType: 'meeting', objectId: r.id, details: { title: p.title, startsAt: p.startsAt.toISOString(), by: actor.label } });
  return r;
}

export const fmtWhen = (d: Date) => d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

/**
 * Chat-Nachricht eines Agenten: Direktnachricht an eine Person (Kanal wird bei Bedarf angelegt) oder in den Projektkanal.
 * Die Person bekommt eine Benachrichtigung; Antworten im Chat beantwortet der Agent im Chat und hält sie im Log fest.
 */
export async function agentChatMessage(db: Db, agent: { id: string; name: string; org_id: string }, target: { userId: string } | { projectId: string }, body: string, projectId: string): Promise<string> {
  const channelId = 'userId' in target ? await dmChannel(db, agent.org_id, agent.id, target.userId) : await projectChannelId(db, agent.org_id, target.projectId);
  await db.query(`insert into chat_messages (channel_id, user_id, body) values ($1,$2,$3)`, [channelId, agent.id, body.slice(0, 8000)]);
  await db.query(`insert into chat_channel_members (channel_id, user_id, last_read_at) values ($1,$2,now()) on conflict (channel_id, user_id) do update set last_read_at = now()`, [channelId, agent.id]);
  if ('userId' in target) await notify(db, { userId: target.userId, projectId, type: 'chat.dm', title: `Nachricht von ${agent.name}`, body: body.length > 160 ? body.slice(0, 160) + ' …' : body, link: `/chat/${channelId}`, ref: { type: 'chat_channel', id: channelId }, actorId: agent.id, chatted: true, dedupeKey: null });
  return channelId;
}

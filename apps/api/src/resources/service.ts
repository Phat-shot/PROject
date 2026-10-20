import type { Db } from '../db.js';
import type { Availability, BookingKind, Resource, ResourceBooking, ResourceKind } from '@projekttool/shared';
import { audit } from '../audit.js';
import { dispatch, notify } from '../notify.js';
import { canSeeSubproject, getMembership, groupRecipients } from '../rights.js';
import { localParts, LOCAL_TZ } from '../localTime.js';
import { answerQuestion, type QuestionRow } from '../questions.js';
import { queueAgentRun } from '../ai/agentEvents.js';
import { dateStr } from '../tasks/service.js';

/**
 * Ressourcen und Personen im Kalender (Konzept 10): Ressourcen sind alles Buchbare, das kein Benutzer ist (Pool des Mandanten oder je
 * Projekt). Eine Belegung gilt genau einer Ressource oder einer internen Person und hängt an einer Besprechung, einem AP bzw. einer
 * Aufgabe oder steht frei im Projekt; ohne Projekt ist sie Sperrzeit (Ressource) oder Abwesenheit (Person). Konflikte prüft der Code
 * (vorläufige Überschneidungen bleiben erlaubt), Maskierung zeigt Fremden nur „belegt“ bzw. „abwesend“.
 */
export const RESOURCE_KIND_LABEL: Record<ResourceKind, string> = { room: 'Raum', equipment: 'Gerät', scaffold: 'Gerüst', vehicle: 'Fahrzeug', person: 'Person', other: 'Sonstiges' };
export interface Actor { id: string; name: string; orgId: string; kind: 'person' | 'agent'; globalRole?: string; orgRights?: string[] }
export class BookingConflict extends Error { constructor(public conflicts: ResourceBooking[]) { super(`belegt am ${conflicts.map((c) => fmtSpan(c.startsAt, c.endsAt)).join(', ')}, anderen Zeitraum wählen`); } }

const fmtDate = (d: Date | string) => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: LOCAL_TZ });
const fmtTime = (d: Date | string) => new Date(d).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: LOCAL_TZ });
/** „03.11.2026 09:00–11:00“ bzw. „03.11.2026–21.11.2026“ bei ganztägigen Belegungen (Ende zählt nicht mit). */
export function fmtSpan(starts: Date | string, ends: Date | string, allDay?: boolean): string {
  const s = new Date(starts); const e = new Date(ends);
  const whole = allDay ?? (localParts(s).time === '00:00' && localParts(e).time === '00:00');
  if (whole) { const last = new Date(e.getTime() - 1); return fmtDate(s) === fmtDate(last) ? fmtDate(s) : `${fmtDate(s)}–${fmtDate(last)}`; }
  return fmtDate(s) === fmtDate(e) ? `${fmtDate(s)} ${fmtTime(s)}–${fmtTime(e)}` : `${fmtDate(s)} ${fmtTime(s)}–${fmtDate(e)} ${fmtTime(e)}`;
}

/** Mitternacht Europe/Berlin eines Datums YYYY-MM-DD als Zeitpunkt. */
export function localMidnight(ymd: string): Date {
  const guess = new Date(`${ymd}T00:00:00Z`);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: LOCAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(guess);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}
/** Ganztägig von Mitternacht des ersten bis Mitternacht nach dem letzten Tag (Ende exklusiv). */
export function dayRange(startDate: string, endDate: string): { starts: Date; ends: Date } {
  const a = startDate <= endDate ? startDate : endDate; const b = startDate <= endDate ? endDate : startDate;
  return { starts: localMidnight(a), ends: localMidnight(nextDay(b)) };
}
const nextDay = (ymd: string) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

export const BOOKING_SELECT = `select b.*, r.name as resource_name, r.kind as resource_kind, r.project_id as resource_project_id, r.approval_group_id, u.name as user_name, cu.name as created_by_name, p.key as project_key, p.personal as project_personal,
    t.number as task_number, t.title as task_title, t.subproject_id as task_subproject_id, (select q.id from questions q where q.booking_id = b.id and q.status = 'open' limit 1) as question_id
  from resource_bookings b left join resources r on r.id = b.resource_id left join users u on u.id = b.user_id left join users cu on cu.id = b.created_by left join projects p on p.id = b.project_id left join tasks t on t.id = b.task_id`;

export function mapResource(r: any): Resource {
  return { id: r.id, projectId: r.project_id ?? null, projectKey: r.project_key ?? null, kind: r.kind, name: r.name, description: r.description ?? null, location: r.location ?? null, email: r.email ?? null, phone: r.phone ?? null, organization: r.organization ?? null, trade: r.trade ?? null, approvalGroupId: r.approval_group_id ?? null, approvalGroupName: r.approval_group_name ?? null, active: Boolean(r.active), createdBy: r.created_by ?? null, createdAt: r.created_at, futureBookings: r.future_bookings === undefined ? undefined : Number(r.future_bookings) };
}
const bookingKind = (r: any): BookingKind => (r.project_id ? 'booking' : r.user_id ? 'absence' : 'block');

/** Abbildung mit Maskierung: ohne Sicht auf das Projekt nur Zeitraum, Zustand und „belegt“ bzw. „abwesend“. */
export function mapBooking(r: any, opts: { masked: boolean; conflict?: boolean }): ResourceBooking {
  const kind = bookingKind(r);
  const base = { id: r.id, kind, resourceId: r.resource_id ?? null, resourceName: r.resource_name ?? null, resourceKind: r.resource_kind ?? null, userId: r.user_id ?? null, userName: r.user_name ?? null, followTask: Boolean(r.follow_task), startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), allDay: Boolean(r.all_day), tentative: Boolean(r.tentative), confirmedAt: r.confirmed_at ?? null, createdAt: r.created_at, conflict: opts.conflict, masked: opts.masked };
  if (opts.masked) return { ...base, projectId: null, projectKey: null, meetingId: null, taskId: null, title: kind === 'absence' ? 'abwesend' : r.tentative ? 'vorläufig belegt' : 'belegt', note: null, createdBy: null, createdByName: null, questionId: null };
  return { ...base, projectId: r.project_id ?? null, projectKey: r.project_key ?? null, meetingId: r.meeting_id ?? null, taskId: r.task_id ?? null, taskRef: r.task_number ? `${r.project_key}-${r.task_number}` : null, taskTitle: r.task_title ?? null, title: r.title ?? (kind === 'absence' ? 'Abwesenheit' : kind === 'block' ? 'Sperrzeit' : null), note: r.note ?? null, createdBy: r.created_by ?? null, createdByName: r.created_by_name ?? null, questionId: r.question_id ?? null };
}

/** Sieht die Person das Projekt (Mitglied, oder Org-Sichtbarkeit ohne persönliches Projekt) und das Teilprojekt des AP? Eigene Abwesenheiten sieht jede Person voll. */
export async function canSeeBooking(db: Db, viewer: { id: string } | null, r: any): Promise<boolean> {
  if (!viewer) return false;
  if (!r.project_id) return r.user_id === viewer.id || Boolean(r.resource_id);
  if (r.project_personal && !(await getMembership(db, r.project_id, viewer.id))) return false;
  const m = await getMembership(db, r.project_id, viewer.id);
  if (!m) { const p = await db.maybeOne(`select visibility from projects where id = $1`, [r.project_id]); if (p?.visibility !== 'org') return false; }
  if (r.task_subproject_id && !(await canSeeSubproject(db, viewer.id, r.task_subproject_id))) return false;
  return true;
}

export interface ConflictQuery { resourceId?: string | null; userId?: string | null; startsAt: Date; endsAt: Date; excludeBookingId?: string | null; excludeMeetingId?: string | null }
/** Überschneidungen: bestätigte (hard) und vorläufige (soft) Belegungen; bei Personen auch Besprechungen, die sie angelegt haben oder an denen sie teilnehmen. */
export async function findConflicts(db: Db, q: ConflictQuery): Promise<{ hard: any[]; soft: any[] }> {
  const rows = q.resourceId
    ? await db.query(`${BOOKING_SELECT} where b.resource_id = $1 and b.starts_at < $3 and b.ends_at > $2 and ($4::uuid is null or b.id <> $4) and ($5::uuid is null or b.meeting_id is distinct from $5) order by b.starts_at`, [q.resourceId, q.startsAt, q.endsAt, q.excludeBookingId ?? null, q.excludeMeetingId ?? null])
    : await db.query(`${BOOKING_SELECT} where b.user_id = $1 and b.starts_at < $3 and b.ends_at > $2 and ($4::uuid is null or b.id <> $4) and ($5::uuid is null or b.meeting_id is distinct from $5) order by b.starts_at`, [q.userId, q.startsAt, q.endsAt, q.excludeBookingId ?? null, q.excludeMeetingId ?? null]);
  const all = [...rows.rows];
  if (q.userId) {
    const ms = await db.query(`select m.id, m.project_id, m.title, m.starts_at, m.ends_at, m.tentative, m.created_by, p.key as project_key, p.personal as project_personal from meetings m join projects p on p.id = m.project_id where m.starts_at < $3 and m.ends_at > $2 and ($4::uuid is null or m.id <> $4) and (m.created_by = $1 or m.attendees @> jsonb_build_array(jsonb_build_object('userId', $1::text)))`, [q.userId, q.startsAt, q.endsAt, q.excludeMeetingId ?? null]);
    for (const m of ms.rows) all.push({ id: `meeting-${m.id}`, project_id: m.project_id, project_key: m.project_key, project_personal: m.project_personal, user_id: q.userId, meeting_id: m.id, title: m.title, starts_at: m.starts_at, ends_at: m.ends_at, tentative: m.tentative, all_day: false, created_by: m.created_by, created_at: m.starts_at, user_name: null });
  }
  return { hard: all.filter((x) => !x.tentative), soft: all.filter((x) => x.tentative) };
}

/** Liste mit Maskierung und berechnetem Konflikt. */
export async function mapBookings(db: Db, rows: any[], viewer: { id: string } | null): Promise<ResourceBooking[]> {
  const out: ResourceBooking[] = [];
  for (const r of rows) {
    const c = await findConflicts(db, { resourceId: r.resource_id, userId: r.user_id, startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at), excludeBookingId: r.id, excludeMeetingId: r.meeting_id });
    out.push(mapBooking(r, { masked: !(await canSeeBooking(db, viewer, r)), conflict: c.hard.length > 0 || c.soft.length > 0 }));
  }
  return out;
}

export async function availability(db: Db, q: ConflictQuery, viewer: { id: string } | null): Promise<Availability> {
  const c = await findConflicts(db, q);
  const conflicts = [...c.hard, ...c.soft];
  const mapped: ResourceBooking[] = [];
  for (const r of conflicts) mapped.push(mapBooking(r, { masked: !(await canSeeBooking(db, viewer, r)) }));
  return { status: c.hard.length ? 'busy' : c.soft.length ? 'tentative' : 'free', conflicts: mapped };
}

const isResourcesAdmin = (a: Actor) => a.globalRole === 'org_admin' || Boolean(a.orgRights?.includes('resources_admin'));
const inGroup = async (db: Db, groupId: string, userId: string) => Boolean(await db.maybeOne(`select 1 from group_members where group_id = $1 and user_id = $2`, [groupId, userId]));

export interface BookingInput {
  projectId: string | null; resourceId?: string | null; userId?: string | null; meetingId?: string | null; taskId?: string | null; followTask?: boolean;
  title?: string | null; note?: string | null; startsAt: Date; endsAt: Date; allDay?: boolean; tentative?: boolean; force?: boolean;
}
/**
 * Buchen mit Rechten und Konfliktprüfung: bestätigte Überschneidung → BookingConflict (409), außer force durch PL oder „Projektplan ändern“
 * (Audit booking.force, Meldung booking.conflict an die andere Seite). Pool-Ressource mit Freigabegruppe ohne Mitgliedschaft darin → vorläufig
 * und booking.request an die Gruppe. Agenten buchen immer vorläufig und nie mit force. Interne Person gebucht → booking.assigned.
 */
export async function createBooking(db: Db, actor: Actor, b: BookingInput, opts: { silent?: boolean } = {}): Promise<{ booking: any; warnings: ResourceBooking[]; requested: boolean }> {
  if (b.endsAt <= b.startsAt) throw new Error('Ende muss nach dem Beginn liegen');
  if (Boolean(b.resourceId) === Boolean(b.userId)) throw new Error('Genau eine Ressource oder eine Person angeben');
  let tentative = Boolean(b.tentative) || actor.kind === 'agent';
  let requested = false;
  let resource: any = null;
  if (b.resourceId) {
    resource = await db.maybeOne(`select * from resources where id = $1 and org_id = $2`, [b.resourceId, actor.orgId]);
    if (!resource || !resource.active) throw new Error('Ressource nicht gefunden oder deaktiviert');
    if (resource.project_id && resource.project_id !== b.projectId) throw new Error('Projektressourcen bucht nur das eigene Projekt');
    if (!b.projectId) {
      // Sperrzeit: Pool durch Org-Admin, resources_admin oder Freigabegruppe; Projektressource durch die PL
      const ok = resource.project_id ? (await getMembership(db, resource.project_id, actor.id))?.role === 'pl' : isResourcesAdmin(actor) || (resource.approval_group_id ? await inGroup(db, resource.approval_group_id, actor.id) : false);
      if (!ok || actor.kind === 'agent') throw new Error('Sperrzeiten setzen Org-Admin, Ressourcenverwaltung oder Freigabegruppe (Pool) bzw. die PL (Projektressource)');
    } else if (!resource.project_id && resource.approval_group_id && !(await inGroup(db, resource.approval_group_id, actor.id))) { tentative = true; requested = true; }
  } else {
    const u = await db.maybeOne(`select id, kind, active from users where id = $1 and org_id = $2`, [b.userId, actor.orgId]);
    if (!u || !u.active || u.kind !== 'person') throw new Error('Person nicht gefunden');
    if (!b.projectId && b.userId !== actor.id && actor.globalRole !== 'org_admin') throw new Error('Abwesenheiten trägt jede Person für sich ein, der Org-Admin für alle');
    if (!b.projectId && actor.kind === 'agent') throw new Error('Abwesenheiten tragen Personen ein');
  }
  const m = b.projectId ? await getMembership(db, b.projectId, actor.id) : null;
  if (b.projectId && (!m || m.role === 'reader')) throw new Error('Buchen dürfen Mitglieder des buchenden Projekts');
  const c = await findConflicts(db, { resourceId: b.resourceId, userId: b.userId, startsAt: b.startsAt, endsAt: b.endsAt, excludeMeetingId: b.meetingId ?? null });
  const mask = async (rows: any[]) => { const out: ResourceBooking[] = []; for (const r of rows) out.push(mapBooking(r, { masked: !(await canSeeBooking(db, actor, r)) })); return out; };
  if (c.hard.length && !tentative) {
    const mayForce = Boolean(b.force) && actor.kind === 'person' && Boolean(m && (m.role === 'pl' || m.canEditPlan));
    if (!mayForce) throw new BookingConflict(await mask(c.hard));
  }
  if (c.hard.length && tentative && actor.kind === 'agent') throw new BookingConflict(await mask(c.hard));
  const title = (b.title ?? '').trim().slice(0, 200) || null;
  const row = await db.one(`insert into resource_bookings (org_id, project_id, resource_id, user_id, meeting_id, task_id, follow_task, title, note, starts_at, ends_at, all_day, tentative, confirmed_by, confirmed_at, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,case when $14::uuid is null then null else now() end,$15) returning id`,
    [actor.orgId, b.projectId, b.resourceId ?? null, b.userId ?? null, b.meetingId ?? null, b.taskId ?? null, Boolean(b.followTask), title, (b.note ?? '').trim().slice(0, 2000) || null, b.startsAt, b.endsAt, Boolean(b.allDay), tentative, tentative ? null : actor.id, actor.id]);
  const booking = await db.one(`${BOOKING_SELECT} where b.id = $1`, [row.id]);
  const what = booking.resource_name ?? booking.user_name ?? '?';
  await audit(db, { orgId: actor.orgId, projectId: b.projectId ?? undefined, userId: actor.id, action: c.hard.length && !tentative ? 'booking.force' : 'booking.create', objectType: 'booking', objectId: row.id, details: { what, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), tentative, taskId: b.taskId ?? null, meetingId: b.meetingId ?? null, conflicts: c.hard.length } });
  if (!opts.silent && b.projectId) {
    if (c.hard.length && !tentative) await notifyConflict(db, actor, booking, c.hard, 'übersteuert');
    if (requested && resource?.approval_group_id) await dispatch(db, { event: 'booking', projectId: b.projectId, taskId: b.taskId ?? undefined, type: 'booking.request', title: `Buchungsanfrage: ${what} ${fmtSpan(b.startsAt, b.endsAt, b.allDay)}`, body: `${actor.name} fragt ${what} an (Freigabegruppe bestätigt)`, link: bookingLink(booking), ref: { type: 'booking', id: row.id }, actorId: actor.id, users: await groupRecipients(db, { groupId: resource.approval_group_id, projectId: b.projectId }) });
    if (b.userId && b.userId !== actor.id) await notify(db, { userId: b.userId, projectId: b.projectId, taskId: b.taskId ?? null, type: 'booking.assigned', title: `Eingeplant: ${title ?? booking.task_title ?? 'Belegung'} ${fmtSpan(b.startsAt, b.endsAt, b.allDay)}`, body: `${actor.name} hat dich ${tentative ? 'vorläufig ' : ''}eingeplant${booking.project_key ? ` (${booking.project_key})` : ''}`, link: bookingLink(booking), ref: { type: 'booking', id: row.id }, actorId: actor.id });
    if (b.taskId) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [b.taskId, actor.id, `${what} gebucht ${fmtSpan(b.startsAt, b.endsAt, b.allDay)}${tentative ? ' (vorläufig)' : ''}${c.hard.length && !tentative ? ' · Konflikt übersteuert' : ''}`]);
  }
  return { booking, warnings: await mask(c.soft), requested };
}

export const bookingLink = (b: any) => `/kalender?ansicht=belegung&datum=${new Date(b.starts_at).toISOString().slice(0, 10)}${b.resource_id ? `&ressource=${b.resource_id}` : b.user_id ? `&person=${b.user_id}` : ''}`;

/** Meldung booking.conflict an Ersteller der anderen Belegung, gebuchte Person und Freigabegruppe (nicht blockierend). */
async function notifyConflict(db: Db, actor: Actor, booking: any, others: any[], why: string) {
  if (!booking.project_id) return;
  const users = new Set<string>();
  for (const o of others) { if (o.created_by) users.add(o.created_by); if (o.user_id) users.add(o.user_id); }
  if (booking.user_id) users.add(booking.user_id);
  if (booking.approval_group_id) for (const u of await groupRecipients(db, { groupId: booking.approval_group_id, projectId: booking.project_id })) users.add(u);
  const what = booking.resource_name ?? booking.user_name ?? '?';
  await dispatch(db, { event: 'booking', projectId: booking.project_id, taskId: booking.task_id ?? undefined, type: 'booking.conflict', title: `Belegungskonflikt: ${what} ${fmtSpan(booking.starts_at, booking.ends_at, booking.all_day)}`, body: `${actor.name} hat die Belegung ${why}; sie überschneidet sich mit ${others.length} ${others.length === 1 ? 'Belegung' : 'Belegungen'}`, link: bookingLink(booking), ref: { type: 'booking', id: booking.id }, actorId: actor.id, users, dedupeKey: `booking.conflict:${booking.id}:${new Date(booking.starts_at).toISOString()}` });
}

/** Zeit oder Zustand einer Belegung ändern (Ersteller, PL, can_edit_plan; Freigabegruppe darf Pool-Buchungen ablehnen → löschen). Indirekte Verschiebungen melden Konflikte statt zu blockieren. */
export async function updateBooking(db: Db, actor: Actor, id: string, patch: { startsAt?: Date; endsAt?: Date; allDay?: boolean; title?: string | null; note?: string | null; followTask?: boolean; tentative?: boolean }): Promise<any> {
  const cur = await db.one(`${BOOKING_SELECT} where b.id = $1`, [id]);
  await requireBookingRight(db, actor, cur);
  const starts = patch.startsAt ?? new Date(cur.starts_at); const ends = patch.endsAt ?? new Date(cur.ends_at);
  if (ends <= starts) throw new Error('Ende muss nach dem Beginn liegen');
  const moved = starts.getTime() !== new Date(cur.starts_at).getTime() || ends.getTime() !== new Date(cur.ends_at).getTime();
  if (moved && !cur.tentative && !(patch.tentative ?? false)) {
    const c = await findConflicts(db, { resourceId: cur.resource_id, userId: cur.user_id, startsAt: starts, endsAt: ends, excludeBookingId: cur.id, excludeMeetingId: cur.meeting_id });
    if (c.hard.length) { const m = cur.project_id ? await getMembership(db, cur.project_id, actor.id) : null; if (!(m && (m.role === 'pl' || m.canEditPlan))) { const out: ResourceBooking[] = []; for (const r of c.hard) out.push(mapBooking(r, { masked: !(await canSeeBooking(db, actor, r)) })); throw new BookingConflict(out); } }
  }
  await db.query(`update resource_bookings set starts_at = $2, ends_at = $3, all_day = $4, title = $5, note = $6, follow_task = $7, tentative = $8, updated_at = now() where id = $1`,
    [cur.id, starts, ends, patch.allDay ?? cur.all_day, patch.title === undefined ? cur.title : (patch.title ?? '').trim().slice(0, 200) || null, patch.note === undefined ? cur.note : (patch.note ?? '').trim().slice(0, 2000) || null, patch.followTask ?? cur.follow_task, patch.tentative ?? cur.tentative]);
  await audit(db, { orgId: actor.orgId, projectId: cur.project_id ?? undefined, userId: actor.id, action: 'booking.update', objectType: 'booking', objectId: cur.id, details: { startsAt: starts.toISOString(), endsAt: ends.toISOString() } });
  return db.one(`${BOOKING_SELECT} where b.id = $1`, [id]);
}

export async function requireBookingRight(db: Db, actor: Actor, cur: any, forDelete = false): Promise<void> {
  if (!cur.project_id) {
    if (cur.user_id) { if (cur.user_id === actor.id || actor.globalRole === 'org_admin') return; throw new Error('Abwesenheiten ändert die Person selbst oder der Org-Admin'); }
    const ok = cur.resource_project_id ? (await getMembership(db, cur.resource_project_id, actor.id))?.role === 'pl' : isResourcesAdmin(actor) || (cur.approval_group_id ? await inGroup(db, cur.approval_group_id, actor.id) : false);
    if (!ok) throw new Error('Sperrzeiten ändern Org-Admin, Ressourcenverwaltung oder Freigabegruppe bzw. die PL');
    return;
  }
  const m = await getMembership(db, cur.project_id, actor.id);
  if (cur.created_by === actor.id || m?.role === 'pl' || (m?.canEditPlan && cur.resource_project_id)) return;
  if (forDelete && cur.approval_group_id && (await inGroup(db, cur.approval_group_id, actor.id))) return;
  throw new Error('Belegungen ändern Ersteller, PL oder wer „Projektplan ändern“ darf; die Freigabegruppe darf ablehnen');
}

export async function deleteBooking(db: Db, actor: Actor, id: string, reason = 'gelöscht'): Promise<void> {
  const cur = await db.one(`${BOOKING_SELECT} where b.id = $1`, [id]);
  await requireBookingRight(db, actor, cur, true);
  const q = await db.maybeOne<QuestionRow>(`select * from questions where booking_id = $1 and status = 'open'`, [cur.id]);
  if (q) await answerQuestion(db, q, { source: 'system', userId: actor.kind === 'person' ? actor.id : null, text: `Belegung ${reason}`, option: 'reject' });
  await db.query(`delete from resource_bookings where id = $1`, [cur.id]);
  if (cur.task_id) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [cur.task_id, actor.id, `Belegung ${cur.resource_name ?? cur.user_name ?? ''} ${fmtSpan(cur.starts_at, cur.ends_at, cur.all_day)} ${reason}`]);
  if (cur.created_by && cur.created_by !== actor.id && cur.project_id) await notify(db, { userId: cur.created_by, projectId: cur.project_id, taskId: cur.task_id ?? null, type: 'booking.declined', title: `Belegung ${reason}: ${cur.resource_name ?? cur.user_name ?? ''} ${fmtSpan(cur.starts_at, cur.ends_at, cur.all_day)}`, body: `von ${actor.name}`, link: bookingLink(cur), ref: { type: 'booking', id: cur.id }, actorId: actor.id });
  await audit(db, { orgId: actor.orgId, projectId: cur.project_id ?? undefined, userId: actor.id, action: 'booking.delete', objectType: 'booking', objectId: cur.id, details: { reason } });
}

/** Bestätigen (eine Person; bei Freigabegruppe nur deren Mitglieder; Projektressource ab Mitglied) oder ablehnen; offene Frage confirm wird beantwortet. */
export async function decideBooking(db: Db, actor: Actor, id: string, decision: 'confirm' | 'decline', text?: string | null): Promise<any> {
  const cur = await db.one(`${BOOKING_SELECT} where b.id = $1`, [id]);
  if (actor.kind !== 'person') throw new Error('Belegungen bestätigt eine Person');
  if (!cur.tentative) return cur;
  if (cur.approval_group_id && !cur.resource_project_id) { if (!(await inGroup(db, cur.approval_group_id, actor.id)) && actor.globalRole !== 'org_admin') throw new Error('Diese Pool-Ressource bestätigt ihre Freigabegruppe'); }
  else if (cur.project_id) { const m = await getMembership(db, cur.project_id, actor.id); if (!m || m.role === 'reader') throw new Error('Bestätigen dürfen Mitglieder des Projekts'); }
  if (decision === 'decline') { await deleteBooking(db, { ...actor }, id, `abgelehnt${text ? ` (${text})` : ''}`).catch(async () => { await db.query(`delete from resource_bookings where id = $1`, [id]); }); return null; }
  const c = await findConflicts(db, { resourceId: cur.resource_id, userId: cur.user_id, startsAt: new Date(cur.starts_at), endsAt: new Date(cur.ends_at), excludeBookingId: cur.id, excludeMeetingId: cur.meeting_id });
  if (c.hard.length) { const out: ResourceBooking[] = []; for (const r of c.hard) out.push(mapBooking(r, { masked: !(await canSeeBooking(db, actor, r)) })); throw new BookingConflict(out); }
  await db.query(`update resource_bookings set tentative = false, confirmed_by = $2, confirmed_at = now(), updated_at = now() where id = $1`, [cur.id, actor.id]);
  const q = await db.maybeOne<QuestionRow>(`select * from questions where booking_id = $1 and status = 'open'`, [cur.id]);
  if (q) await answerQuestion(db, q, { source: 'system', userId: actor.id, text: `Belegung bestätigt: ${cur.resource_name ?? cur.user_name ?? ''} ${fmtSpan(cur.starts_at, cur.ends_at, cur.all_day)}`, option: 'confirm' });
  if (cur.task_id) { await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [cur.task_id, actor.id, `Belegung bestätigt: ${cur.resource_name ?? cur.user_name ?? ''} ${fmtSpan(cur.starts_at, cur.ends_at, cur.all_day)}`]); if (!q) queueAgentRun(cur.task_id, 'task_changed'); }
  const creator = cur.created_by ? await db.maybeOne(`select id, kind from users where id = $1`, [cur.created_by]) : null;
  if (creator && creator.kind === 'person' && creator.id !== actor.id && cur.project_id) await notify(db, { userId: creator.id, projectId: cur.project_id, taskId: cur.task_id ?? null, type: 'booking.confirmed', title: `Belegung bestätigt: ${cur.resource_name ?? cur.user_name ?? ''} ${fmtSpan(cur.starts_at, cur.ends_at, cur.all_day)}`, body: `von ${actor.name}`, link: bookingLink(cur), ref: { type: 'booking', id: cur.id }, actorId: actor.id });
  await audit(db, { orgId: actor.orgId, projectId: cur.project_id ?? undefined, userId: actor.id, action: 'booking.confirm', objectType: 'booking', objectId: cur.id, details: {} });
  return db.one(`${BOOKING_SELECT} where b.id = $1`, [id]);
}

/** Antwort auf eine Frage confirm mit booking_id (Karte, Chat, Aufgabe): confirm bestätigt, reject löscht. */
export async function onBookingAnswered(db: Db, q: QuestionRow & { booking_id?: string | null }, a: { userId: string | null; option?: string | null; text: string }): Promise<boolean> {
  if (!q.booking_id || !a.userId) return false;
  const u = await db.maybeOne(`select id, name, org_id, kind, global_role, org_rights from users where id = $1`, [a.userId]);
  if (!u) return false;
  const actor: Actor = { id: u.id, name: u.name, orgId: u.org_id, kind: u.kind, globalRole: u.global_role, orgRights: u.org_rights ?? [] };
  const option = a.option ?? (/ablehn|nein|nicht/i.test(a.text) ? 'reject' : /bestätig|ja|ok|passt/i.test(a.text) ? 'confirm' : null);
  if (!option) return false;
  try { await decideBooking(db, actor, q.booking_id, option === 'reject' ? 'decline' : 'confirm', a.text); }
  catch (e: any) { if (q.task_id) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [q.task_id, a.userId, `Belegung nicht bestätigt: ${String(e?.message ?? e)}`]); }
  return false;
}

/** Belegungen einer Besprechung nachziehen: Ressourcen aus resourceIds (null = unverändert), Zeit und vorläufig wie die Besprechung; Konflikte melden, nicht blockieren. */
export async function syncMeetingBookings(db: Db, actor: Actor, meetingId: string, resourceIds: string[] | null): Promise<{ conflicts: number }> {
  const m = await db.maybeOne(`select m.*, p.org_id from meetings m join projects p on p.id = m.project_id where m.id = $1`, [meetingId]);
  if (!m) return { conflicts: 0 };
  const cur = await db.query(`select id, resource_id from resource_bookings where meeting_id = $1 and resource_id is not null`, [meetingId]);
  const want = resourceIds ?? cur.rows.map((r: any) => r.resource_id as string);
  for (const r of cur.rows) if (!want.includes(r.resource_id)) await db.query(`delete from resource_bookings where id = $1`, [r.id]);
  let conflicts = 0;
  for (const rid of new Set(want)) {
    const res = await db.maybeOne(`select * from resources where id = $1 and org_id = $2 and active and (project_id is null or project_id = $3)`, [rid, m.org_id, m.project_id]);
    if (!res) continue;
    const have = cur.rows.find((r: any) => r.resource_id === rid);
    const c = await findConflicts(db, { resourceId: rid, startsAt: new Date(m.starts_at), endsAt: new Date(m.ends_at), excludeMeetingId: meetingId });
    if (c.hard.length) conflicts++;
    if (have) await db.query(`update resource_bookings set starts_at = $2, ends_at = $3, title = $4, tentative = $5, updated_at = now() where id = $1`, [have.id, m.starts_at, m.ends_at, m.title, Boolean(m.tentative)]);
    else await db.query(`insert into resource_bookings (org_id, project_id, resource_id, meeting_id, title, starts_at, ends_at, tentative, confirmed_by, confirmed_at, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,case when $9::uuid is null then null else now() end,$10)`, [m.org_id, m.project_id, rid, meetingId, m.title, m.starts_at, m.ends_at, Boolean(m.tentative), m.tentative ? null : actor.id, actor.id]);
    if (c.hard.length) { const b = await db.one(`${BOOKING_SELECT} where b.meeting_id = $1 and b.resource_id = $2`, [meetingId, rid]); await notifyConflict(db, actor, b, c.hard, 'verschoben'); }
  }
  return { conflicts };
}

/** Besprechung bestätigt → ihre Belegungen auch. */
export async function confirmMeetingBookings(db: Db, actor: Actor, meetingId: string): Promise<void> {
  await db.query(`update resource_bookings set tentative = false, confirmed_by = $2, confirmed_at = now(), updated_at = now() where meeting_id = $1 and tentative`, [meetingId, actor.id]);
}

/** Belegungen mit follow_task folgen Start und Termin des AP (ganztägig); Konflikte werden gemeldet, nicht blockiert. */
export async function syncTaskBookings(db: Db, actor: Actor, taskId: string): Promise<number> {
  const t = await db.maybeOne(`select id, project_id, start_date, due_date from tasks where id = $1`, [taskId]);
  if (!t || (!t.start_date && !t.due_date)) return 0;
  const s = dateStr(t.start_date ?? t.due_date)!; const e = dateStr(t.due_date ?? t.start_date)!;
  const { starts, ends } = dayRange(s, e);
  const rows = await db.query(`${BOOKING_SELECT} where b.task_id = $1 and b.follow_task`, [taskId]);
  let n = 0;
  for (const b of rows.rows) {
    if (new Date(b.starts_at).getTime() === starts.getTime() && new Date(b.ends_at).getTime() === ends.getTime()) continue;
    await db.query(`update resource_bookings set starts_at = $2, ends_at = $3, all_day = true, updated_at = now() where id = $1`, [b.id, starts, ends]);
    n++;
    const c = await findConflicts(db, { resourceId: b.resource_id, userId: b.user_id, startsAt: starts, endsAt: ends, excludeBookingId: b.id });
    if (c.hard.length) await notifyConflict(db, actor, { ...b, starts_at: starts, ends_at: ends }, c.hard, 'mit dem Arbeitspaket verschoben');
  }
  if (n) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [taskId, actor.id, `${n} ${n === 1 ? 'Belegung folgt' : 'Belegungen folgen'} dem neuen Zeitraum ${fmtSpan(starts, ends, true)}`]);
  return n;
}

/** Täglich: vorläufige Belegungen, die in höchstens drei Tagen beginnen → Ersteller, sonst PL (booking.unconfirmed, einmal je Belegung). */
export async function runUnconfirmedBookings(db: Db, now = new Date()): Promise<number> {
  const rows = await db.query(`${BOOKING_SELECT} where b.tentative and b.project_id is not null and b.starts_at > $1 and b.starts_at < $1::timestamptz + interval '3 days'`, [now]);
  let n = 0;
  for (const b of rows.rows) {
    const key = `booking.unconfirmed:${b.id}`;
    if (await db.maybeOne(`select 1 from notifications where dedupe_key = $1 limit 1`, [key])) continue;
    const creator = b.created_by ? await db.maybeOne(`select id, kind from users where id = $1 and active`, [b.created_by]) : null;
    const users = creator && creator.kind === 'person' ? [creator.id] : (await db.query(`select user_id from project_members where project_id = $1 and role = 'pl'`, [b.project_id])).rows.map((r: any) => r.user_id);
    const sent = await dispatch(db, { event: 'booking', projectId: b.project_id, taskId: b.task_id ?? undefined, type: 'booking.unconfirmed', title: `Noch vorläufig: ${b.resource_name ?? b.user_name ?? ''} ${fmtSpan(b.starts_at, b.ends_at, b.all_day)}`, body: `Die Belegung beginnt bald und ist nicht bestätigt`, link: bookingLink(b), ref: { type: 'booking', id: b.id }, actorId: null, users, dedupeKey: key });
    if (sent.length) n++;
  }
  return n;
}

/** Belegt-Zeiten einer Person (Belegungen, Abwesenheiten, Besprechungen) ohne Details, für Agentenkontext und Verfügbarkeit. */
export async function busyOf(db: Db, userId: string, from: Date, to: Date, excludeProjectId: string | null = null): Promise<{ startsAt: Date; endsAt: Date; kind: 'booking' | 'absence' | 'meeting'; tentative: boolean }[]> {
  const b = await db.query(`select starts_at, ends_at, project_id, tentative from resource_bookings where user_id = $1 and starts_at < $3 and ends_at > $2 order by starts_at limit 40`, [userId, from, to]);
  const m = await db.query(`select m.starts_at, m.ends_at, m.tentative from meetings m where m.starts_at < $3 and m.ends_at > $2 and ($4::uuid is null or m.project_id <> $4) and (m.created_by = $1 or m.attendees @> jsonb_build_array(jsonb_build_object('userId', $1::text))) order by m.starts_at limit 40`, [userId, from, to, excludeProjectId]);
  return [...b.rows.map((x: any) => ({ startsAt: new Date(x.starts_at), endsAt: new Date(x.ends_at), kind: (x.project_id ? 'booking' : 'absence') as 'booking' | 'absence', tentative: Boolean(x.tentative) })), ...m.rows.map((x: any) => ({ startsAt: new Date(x.starts_at), endsAt: new Date(x.ends_at), kind: 'meeting' as const, tentative: Boolean(x.tentative) }))].sort((a, b2) => a.startsAt.getTime() - b2.startsAt.getTime());
}

/** Ressource nach Name im Projekt oder Pool (für Agenten und Formulare). */
export async function findResourceByName(db: Db, orgId: string, projectId: string, name: string): Promise<any | null> {
  const v = String(name ?? '').trim();
  if (!v) return null;
  const rows = await db.query(`select * from resources where org_id = $1 and active and (project_id = $2 or project_id is null) and lower(name) = lower($3) order by (project_id is not null) desc limit 2`, [orgId, projectId, v]);
  return rows.rows[0] ?? null;
}

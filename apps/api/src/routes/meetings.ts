import type { FastifyInstance } from 'fastify';
import type { Meeting, MeetingAttendee, User } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject, requireTaskRef, visibleSubprojectSql } from '../rights.js';
import { queueAgentRun } from '../ai/agentEvents.js';
import * as L from '../docs/layout.js';
import { htmlToMd, mdToHtml } from '../docs/html.js';
import { mapPage } from '../docs/service.js';
import { publicBase } from '../docs/share.js';
import { newMailCode, loadTask } from '../tasks/service.js';
import type { AccountRow } from '../mail/types.js';
import { seal, unseal } from '../secrets.js';
import { pushCaldav, pushGoogle, pushGraph, testCaldav, type PushEvent } from '../calendar/push.js';
import type { CalendarTarget } from '@projekttool/shared';
import { projectAccount } from '../mail/accounts.js';
import { answerQuestion, cancelQuestions, type QuestionRow } from '../questions.js';
import { confirmMeetingBookings, syncMeetingBookings, type Actor as BookingActor } from '../resources/service.js';

const fmtDe = (d: Date) => d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);

/** ICS-Einladung (METHOD:REQUEST) zu einer Besprechung; Organisator = Projektkonto oder Ersteller. */
export function meetingIcs(m: { id: string; title: string; starts_at: Date | string; ends_at: Date | string; location: string | null; description: string | null; attendees: MeetingAttendee[]; project_id: string; tentative?: boolean }, organizer: { email: string; name: string }, sequence = 0, rooms: { name: string; email: string | null; kind?: string }[] = []): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PROject//Besprechung//DE', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:meeting-${m.id}@project`, `DTSTAMP:${icsStamp(new Date())}`, `SEQUENCE:${sequence}`, `DTSTART:${icsStamp(new Date(m.starts_at))}`, `DTEND:${icsStamp(new Date(m.ends_at))}`,
    `SUMMARY:${icsEsc(m.title)}`, `ORGANIZER;CN=${icsEsc(organizer.name)}:mailto:${organizer.email}`, ...(m.tentative ? ['STATUS:TENTATIVE'] : [])];
  if (m.location) lines.push(`LOCATION:${icsEsc(m.location)}`);
  lines.push(`DESCRIPTION:${icsEsc(`${m.description ?? ''}\n${publicBase()}/projekte/${m.project_id}/besprechungen`.trim())}`);
  for (const a of m.attendees) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE${a.name ? `;CN=${icsEsc(a.name)}` : ''}:mailto:${a.email}`);
  // Räume und Geräte als Ressourcen-Teilnehmer (CUTYPE ROOM bzw. RESOURCE), Raumpostfach falls vorhanden
  for (const r of rooms) lines.push(`ATTENDEE;CUTYPE=${r.kind === 'room' ? 'ROOM' : 'RESOURCE'};ROLE=NON-PARTICIPANT;CN=${icsEsc(r.name)}:mailto:${r.email ?? `resource-${icsEsc(r.name).replace(/[^A-Za-z0-9]/g, '')}@project.invalid`}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function mapMeeting(r: any): Meeting {
  const res = Array.isArray(r.resources) ? r.resources : [];
  return { id: r.id, projectId: r.project_id, title: r.title, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), location: r.location, description: r.description, seriesPageId: r.series_page_id, seriesPageTitle: r.series_title ?? null, pageId: r.page_id, pageTitle: r.page_title ?? null, attendees: r.attendees ?? [], resourceIds: res.map((x: any) => x.id), resources: res, inviteSentAt: r.invite_sent_at, createdBy: r.created_by, tasks: r.tasks ?? [], createdAt: r.created_at, tentative: Boolean(r.tentative), confirmedAt: r.confirmed_at ?? null };
}

/**
 * Besprechungen: Termin mit Teilnehmern (Mitglieder und Kontakte), Protokollseite aus der Vorlage der Reihe,
 * Aktionspunkte als Arbeitspakete, Einladung per ICS über das Projektkonto. Erscheint im Kalender und im ICS-Abo.
 */
export async function meetingRoutes(app: FastifyInstance) {
  const db = app.db;
  // Aktionspunkte nur aus Teilprojekten, die die Person sieht; userParam = Platzhalternummer der Benutzer-ID
  const SELECT = (userParam: number) => `select m.*, sp.title as series_title, pg.title as page_title,
      coalesce((select json_agg(json_build_object('id', t.id, 'title', t.title, 'number', t.number, 'done', c.is_done) order by t.created_at) from meeting_tasks mt join tasks t on t.id = mt.task_id join board_columns c on c.id = t.column_id where mt.meeting_id = m.id and t.deleted_at is null and ${visibleSubprojectSql(userParam)}), '[]'::json) as tasks,
      coalesce((select json_agg(json_build_object('id', r.id, 'name', r.name, 'kind', r.kind) order by r.name) from resource_bookings b join resources r on r.id = b.resource_id where b.meeting_id = m.id), '[]'::json) as resources
      from meetings m left join doc_pages sp on sp.id = m.series_page_id left join doc_pages pg on pg.id = m.page_id`;
  const load = async (id: string, user: User) => db.maybeOne(`${SELECT(2)} where m.id = $1`, [id, user.id]);
  const parseAttendees = async (projectId: string, raw: any): Promise<MeetingAttendee[]> => {
    if (!Array.isArray(raw)) return [];
    const out: MeetingAttendee[] = [];
    for (const a of raw) {
      if (a?.userId) { const u = await db.maybeOne(`select id, email, name from users where id = $1`, [a.userId]); if (u) out.push({ userId: u.id, email: u.email, name: u.name }); continue; }
      const email = String(a?.email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
      // Adresse eines Benutzers im Mandanten → als internes Mitglied führen
      const u = await db.maybeOne(`select u.id, u.name from users u join projects p on p.org_id = u.org_id where p.id = $1 and lower(u.email) = $2 and u.active`, [projectId, email]);
      if (u) { out.push({ userId: u.id, email, name: u.name }); continue; }
      const c = await db.maybeOne(`select name from project_contacts where project_id = $1 and lower(email) = $2`, [projectId, email]).catch(() => null);
      out.push({ userId: null, email, name: a?.name?.trim() || c?.name || null });
    }
    return out.filter((a, i, xs) => xs.findIndex((x) => x.email === a.email) === i);
  };
  const bookingActor = (user: User): BookingActor => ({ id: user.id, name: user.name, orgId: user.orgId, kind: user.kind === 'agent' ? 'agent' : 'person', globalRole: user.globalRole, orgRights: user.orgRights ?? [] });
  /** Ressourcen der Besprechung (Konzept 10.4): ein Raum ohne location wird zur location; Person-Ressourcen mit Mailadresse werden Teilnehmer. */
  const resourceInfo = async (projectId: string, orgId: string, ids: unknown): Promise<{ ids: string[]; room: string | null; persons: MeetingAttendee[] }> => {
    if (!Array.isArray(ids)) return { ids: [], room: null, persons: [] };
    const rows = await db.query(`select id, name, kind, email from resources where org_id = $1 and active and (project_id is null or project_id = $2) and id = any($3::uuid[])`, [orgId, projectId, ids.map(String)]);
    return { ids: rows.rows.map((r: any) => r.id), room: rows.rows.find((r: any) => r.kind === 'room')?.name ?? null, persons: rows.rows.filter((r: any) => r.kind === 'person' && r.email).map((r: any) => ({ userId: null, email: String(r.email).toLowerCase(), name: r.name })) };
  };
  const times = (b: any, cur?: any) => {
    const starts = b.startsAt ? new Date(b.startsAt) : cur ? new Date(cur.starts_at) : null;
    if (!starts || isNaN(starts.getTime())) throw badRequest('Beginn erforderlich');
    const ends = b.endsAt ? new Date(b.endsAt) : b.durationMinutes ? new Date(starts.getTime() + Number(b.durationMinutes) * 60_000) : cur && !b.startsAt ? new Date(cur.ends_at) : new Date(starts.getTime() + 60 * 60_000);
    if (ends <= starts) throw badRequest('Ende muss nach dem Beginn liegen');
    return { starts, ends };
  };

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/projects/:id/meetings', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const rows = await db.query(`${SELECT(4)} where m.project_id = $1 and ($2::timestamptz is null or m.ends_at >= $2) and ($3::timestamptz is null or m.starts_at <= $3) order by m.starts_at desc limit 300`, [req.params.id, req.query.from ?? null, req.query.to ?? null, user.id]);
    return { meetings: rows.rows.map(mapMeeting) };
  });

  app.post<{ Params: { id: string }; Body: any }>('/projects/:id/meetings', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b: any = req.body ?? {};
    if (!b.title?.trim()) throw badRequest('Titel erforderlich');
    const { starts, ends } = times(b);
    if (b.seriesPageId) { const sp = await db.maybeOne(`select 1 from doc_pages where id = $1 and project_id = $2`, [b.seriesPageId, req.params.id]); if (!sp) throw badRequest('Besprechungsreihe gehört nicht zum Projekt'); }
    const ri = await resourceInfo(req.params.id, user.orgId, b.resourceIds);
    const attendees = (await parseAttendees(req.params.id, b.attendees)).concat(ri.persons).filter((a, i, xs) => xs.findIndex((x) => x.email === a.email) === i);
    const r = await db.one(`insert into meetings (project_id, title, starts_at, ends_at, location, description, series_page_id, attendees, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [req.params.id, b.title.trim(), starts, ends, b.location?.trim() || ri.room, b.description?.trim() || null, b.seriesPageId ?? null, JSON.stringify(attendees), user.id]);
    const sync = await syncMeetingBookings(db, bookingActor(user), r.id, ri.ids);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'meeting.create', objectType: 'meeting', objectId: r.id, details: { title: b.title, startsAt: starts.toISOString(), resources: ri.ids.length } });
    return { meeting: mapMeeting(await load(r.id, user)), bookingConflicts: sync.conflicts };
  });

  app.patch<{ Params: { id: string }; Body: any }>('/meetings/:id', async (req) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select * from meetings where id = $1`, [req.params.id]);
    if (!cur) throw notFound('Besprechung nicht gefunden');
    const m = await requireProject(db, user, cur.project_id, 'member');
    if (cur.created_by !== user.id && m.role !== 'pl') throw forbidden('Nur Ersteller oder PL ändern die Besprechung');
    const b: any = req.body ?? {};
    const { starts, ends } = times(b, cur);
    const ri = b.resourceIds !== undefined ? await resourceInfo(cur.project_id, user.orgId, b.resourceIds) : null;
    let attendees: MeetingAttendee[] = b.attendees !== undefined ? await parseAttendees(cur.project_id, b.attendees) : (cur.attendees ?? []);
    if (ri) attendees = attendees.concat(ri.persons).filter((a, i, xs) => xs.findIndex((x) => x.email === a.email) === i);
    await db.query(`update meetings set title = coalesce($2, title), starts_at = $3, ends_at = $4, location = coalesce($5, location), description = coalesce($6, description), series_page_id = case when $7::text = 'null' then null else coalesce($7::uuid, series_page_id) end, attendees = $8, updated_at = now() where id = $1`,
      [cur.id, b.title?.trim() || null, starts, ends, (b.location ?? null) || (ri && !cur.location ? ri.room : null), b.description ?? null, b.seriesPageId === null ? 'null' : b.seriesPageId ?? null, JSON.stringify(attendees)]);
    const sync = await syncMeetingBookings(db, bookingActor(user), cur.id, ri ? ri.ids : null);
    await audit(db, { orgId: user.orgId, projectId: cur.project_id, userId: user.id, action: 'meeting.update', objectType: 'meeting', objectId: cur.id, details: Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'attendees')) });
    return { meeting: mapMeeting(await load(cur.id, user)), bookingConflicts: sync.conflicts };
  });

  app.delete<{ Params: { id: string } }>('/meetings/:id', async (req) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select * from meetings where id = $1`, [req.params.id]);
    if (!cur) throw notFound('Besprechung nicht gefunden');
    const m = await requireProject(db, user, cur.project_id, 'member');
    if (cur.created_by !== user.id && m.role !== 'pl') throw forbidden('Nur Ersteller oder PL löschen die Besprechung');
    await cancelQuestions(db, { meetingId: cur.id }, `Termin „${cur.title}“ wurde gelöscht`, user.id);
    await db.query(`delete from meetings where id = $1`, [cur.id]);
    await audit(db, { orgId: user.orgId, projectId: cur.project_id, userId: user.id, action: 'meeting.delete', objectType: 'meeting', objectId: cur.id, details: { title: cur.title } });
    return { ok: true };
  });

  // Protokollseite: unter der Reihe (deren Vorlage) oder im Ordner „Protokolle“ mit der Vorlage „protokoll“; Termin und Teilnehmer vorangestellt
  app.post<{ Params: { id: string } }>('/meetings/:id/protocol', async (req) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select * from meetings where id = $1`, [req.params.id]);
    if (!cur) throw notFound('Besprechung nicht gefunden');
    await requireProject(db, user, cur.project_id, 'member');
    if (cur.page_id) { const p = await db.maybeOne(`select * from doc_pages where id = $1 and deleted_at is null`, [cur.page_id]); if (p) return { page: mapPage(p), existed: true }; }
    const templateKey = (cur.series_page_id ? await L.inheritedTemplate(db, cur.series_page_id) : null) ?? 'protokoll';
    const t = await L.loadTemplate(db, templateKey, user.orgId);
    const folder = cur.series_page_id ? (await db.one(`select folder_id from doc_pages where id = $1`, [cur.series_page_id])).folder_id : (await db.maybeOne(`select id from doc_folders where project_id = $1 and name = 'Protokolle'`, [cur.project_id]))?.id ?? null;
    const starts = new Date(cur.starts_at);
    const att = (cur.attendees as MeetingAttendee[]).map((a) => a.name ? `${a.name} (${a.email})` : a.email).join(', ');
    const head = `<p><strong>Termin:</strong> ${fmtDe(starts)}${cur.location ? ` · <strong>Ort:</strong> ${esc(cur.location)}` : ''}<br><strong>Teilnehmer:</strong> ${esc(att) || '–'}</p>`;
    const html = head + (t ? L.templateHtml(t) : '');
    const title = `${cur.title} ${starts.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}`;
    const page = await db.one(`insert into doc_pages (project_id, folder_id, parent_page_id, title, content_md, content_html, template_key, settings, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,'{}',$8,$8) returning *`,
      [cur.project_id, folder, cur.series_page_id, title, htmlToMd(html), html, templateKey, user.id]);
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,1,$2,$3,$4,'draft',$5)`, [page.id, title, page.content_md, page.content_html, user.id]);
    await db.query(`update meetings set page_id = $2, updated_at = now() where id = $1`, [cur.id, page.id]);
    await audit(db, { orgId: user.orgId, projectId: cur.project_id, userId: user.id, action: 'meeting.protocol', objectType: 'doc_page', objectId: page.id, details: { meetingId: cur.id } });
    return { page: mapPage(page), existed: false };
  });

  app.post<{ Params: { id: string }; Body: { taskId?: string; title?: string; responsibleUserId?: string | null; responsibleEmail?: string | null; dueDate?: string | null } }>('/meetings/:id/tasks', async (req) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select * from meetings where id = $1`, [req.params.id]);
    if (!cur) throw notFound('Besprechung nicht gefunden');
    await requireProject(db, user, cur.project_id, 'member');
    const b = req.body ?? {};
    let taskId = b.taskId ?? null;
    if (!taskId) {
      if (!b.title?.trim()) throw badRequest('Titel des Aktionspunkts erforderlich');
      const col = await db.one(`select id from board_columns where project_id = $1 order by position limit 1`, [cur.project_id]);
      const pos = await db.one(`select coalesce(max(position), 0) + 1 as p from tasks where column_id = $1`, [col.id]);
      const t = await db.one(`insert into tasks (project_id, column_id, title, description, priority, due_date, responsible_user_id, responsible_email, position, mail_code, created_by) values ($1,$2,$3,$4,'normal',$5,$6,$7,$8,$9,$10) returning id`,
        [cur.project_id, col.id, b.title.trim(), `Aktionspunkt aus Besprechung „${cur.title}“ (${fmtDe(new Date(cur.starts_at))}).`, b.dueDate || null, b.responsibleUserId || null, b.responsibleEmail?.trim() || null, pos.p, newMailCode(), user.id]);
      taskId = t.id;
      await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [taskId, user.id, `Aktionspunkt aus Besprechung „${cur.title}“ vom ${fmtDe(new Date(cur.starts_at))}.`]);
      await audit(db, { orgId: user.orgId, projectId: cur.project_id, userId: user.id, action: 'task.create', objectType: 'task', objectId: taskId, details: { title: b.title, meetingId: cur.id } });
    } else {
      // Vorhandenes Arbeitspaket: im Projekt und in einem sichtbaren Teilprojekt
      await requireTaskRef(db, user, cur.project_id, taskId);
    }
    await db.query(`insert into meeting_tasks (meeting_id, task_id) values ($1,$2) on conflict do nothing`, [cur.id, taskId]);
    return { meeting: mapMeeting(await load(cur.id, user)), task: await loadTask(db, taskId!) };
  });

  app.delete<{ Params: { id: string; taskId: string } }>('/meetings/:id/tasks/:taskId', async (req) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select * from meetings where id = $1`, [req.params.id]);
    if (!cur) throw notFound('Besprechung nicht gefunden');
    await requireProject(db, user, cur.project_id, 'member');
    await db.query(`delete from meeting_tasks where meeting_id = $1 and task_id = $2`, [cur.id, req.params.taskId]);
    return { meeting: mapMeeting(await load(cur.id, user)) };
  });

  // Vorläufigen Termin (von KI eingetragen) bestätigen: verbindlich, Log an den verknüpften Arbeitspaketen, deren Agent läuft
  app.post<{ Params: { id: string } }>('/meetings/:id/confirm', async (req) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select * from meetings where id = $1`, [req.params.id]);
    if (!cur) throw notFound('Besprechung nicht gefunden');
    await requireProject(db, user, cur.project_id, 'member');
    if (user.kind === 'agent') throw forbidden('Termine bestätigt eine Person');
    if (cur.tentative) {
      await db.query(`update meetings set tentative = false, confirmed_by = $2, confirmed_at = now(), updated_at = now() where id = $1`, [cur.id, user.id]);
      await confirmMeetingBookings(db, bookingActor(user), cur.id);
      const when = new Date(cur.starts_at).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
      // Offene Bestätigungsfragen zu diesem Termin sind damit beantwortet (Meldungen erledigt, Thread geschlossen, Agent läuft)
      for (const q of (await db.query<QuestionRow>(`select * from questions where meeting_id = $1 and status = 'open' and kind = 'confirm'`, [cur.id])).rows) await answerQuestion(db, q, { source: 'meeting', userId: user.id, text: `Termin „${cur.title}“ ${when} bestätigt`, option: 'confirm' });
      const linked = await db.query(`select task_id from meeting_tasks where meeting_id = $1`, [cur.id]);
      for (const l of linked.rows) {
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [l.task_id, user.id, `Termin bestätigt: „${cur.title}“ ${when}`]);
        queueAgentRun(l.task_id, 'task_changed');
      }
      await audit(db, { orgId: user.orgId, projectId: cur.project_id, userId: user.id, action: 'meeting.confirm', objectType: 'meeting', objectId: cur.id, details: { title: cur.title } });
    }
    return { meeting: mapMeeting(await load(cur.id, user)) };
  });

  // Einladung per Mail mit ICS (METHOD:REQUEST) über das Projektkonto an alle Teilnehmer
  app.post<{ Params: { id: string }; Body: { text?: string } }>('/meetings/:id/invite', async (req) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select * from meetings where id = $1`, [req.params.id]);
    if (!cur) throw notFound('Besprechung nicht gefunden');
    await requireProject(db, user, cur.project_id, 'member');
    if (cur.tentative) throw badRequest('Termin ist vorläufig: erst bestätigen, dann einladen');
    const attendees = cur.attendees as MeetingAttendee[];
    if (!attendees.length) throw badRequest('Keine Teilnehmer');
    const account = await projectAccount(db, cur.project_id);
    if (!account) throw badRequest('Kein Projektkonto: Einladungen gehen über das Projektkonto (Projekt › Einstellungen › Mail).');
    const project = await db.one(`select key, name from projects where id = $1`, [cur.project_id]);
    const seq = Number((cur.external ?? {}).sequence ?? 0);
    const rooms = await db.query(`select r.name, r.email, r.kind from resource_bookings b join resources r on r.id = b.resource_id where b.meeting_id = $1 and r.kind <> 'person' order by r.name`, [cur.id]);
    const ics = meetingIcs(cur, { email: account.address, name: `${project.key} ${project.name}` }, seq, rooms.rows);
    const starts = new Date(cur.starts_at);
    const text = `${req.body?.text?.trim() ? req.body.text.trim() + '\n\n' : ''}Einladung: ${cur.title}\nTermin: ${fmtDe(starts)} – ${new Date(cur.ends_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}${cur.location ? `\nOrt: ${cur.location}` : ''}${cur.description ? `\n\n${cur.description}` : ''}\n\nProjekt ${project.key} ${project.name}. Der Termin liegt als Kalendereintrag bei.`;
    const r = await app.mail.sendFromAccount(account, { to: attendees.map((a) => a.email), subject: `Einladung: ${cur.title} · ${fmtDe(starts)}`, text, userId: user.id, projectId: cur.project_id, attachments: [{ filename: 'einladung.ics', content: Buffer.from(ics, 'utf8'), contentType: 'text/calendar; charset=utf-8; method=REQUEST' }] });
    await db.query(`update meetings set invite_sent_at = now(), external = external || $2::jsonb, updated_at = now() where id = $1`, [cur.id, JSON.stringify({ sequence: seq + 1 })]);
    await audit(db, { orgId: user.orgId, projectId: cur.project_id, userId: user.id, action: 'meeting.invite', objectType: 'meeting', objectId: cur.id, details: { to: attendees.map((a) => a.email) } });
    return { ok: true, sent: attendees.length, mailId: (r as any)?.mailId ?? null, meeting: mapMeeting(await load(cur.id, user)) };
  });

  app.get<{ Params: { id: string } }>('/meetings/:id/ics', async (req, reply) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select * from meetings where id = $1`, [req.params.id]);
    if (!cur) throw notFound('Besprechung nicht gefunden');
    await requireProject(db, user, cur.project_id);
    const project = await db.one(`select key, name from projects where id = $1`, [cur.project_id]);
    reply.header('content-type', 'text/calendar; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="besprechung.ics"`);
    return reply.send(meetingIcs(cur, { email: user.email, name: `${project.key} ${project.name}` }));
  });

  // Kalenderziele der Person: persönliche OAuth-Konten (Microsoft im Graph-Modus, Google) und CalDAV
  const targetsOf = async (user: { id: string; orgId: string }): Promise<CalendarTarget[]> => {
    const out: CalendarTarget[] = [];
    const accs = await db.query(`select id, oauth_provider, provider from mail_accounts where managed_user_id = $1 and oauth_refresh_token is not null`, [user.id]);
    for (const a of accs.rows as any[]) {
      if (a.oauth_provider === 'microsoft' && a.provider === 'graph') out.push({ key: 'microsoft', label: 'Microsoft 365 Kalender', accountId: a.id });
      if (a.oauth_provider === 'google') out.push({ key: 'google', label: 'Google Kalender', accountId: a.id });
    }
    const u = await db.one(`select caldav_url from users where id = $1`, [user.id]);
    if (u.caldav_url) out.push({ key: 'caldav', label: 'CalDAV-Kalender', accountId: null });
    return out;
  };
  app.get('/me/calendar-targets', async (req) => { const user = requireUser(req); const u = await db.one(`select caldav_url, caldav_user from users where id = $1`, [user.id]); return { targets: await targetsOf(user), caldav: u.caldav_url ? { url: u.caldav_url, user: u.caldav_user } : null }; });

  app.put<{ Body: { url?: string; user?: string; password?: string } }>('/me/caldav', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    if (!b.url?.trim() || !/^https?:\/\//.test(b.url.trim())) throw badRequest('Kalender-Adresse (https://…) erforderlich');
    if (!b.user?.trim()) throw badRequest('Benutzername erforderlich');
    const cur = await db.one(`select caldav_password from users where id = $1`, [user.id]);
    const pw = b.password?.trim() ? seal(b.password.trim()) : cur.caldav_password;
    if (!pw) throw badRequest('Passwort (App-Passwort) erforderlich');
    await db.query(`update users set caldav_url = $2, caldav_user = $3, caldav_password = $4 where id = $1`, [user.id, b.url.trim(), b.user.trim(), pw]);
    const test = await testCaldav(app.fetchFn, { url: b.url.trim(), user: b.user.trim(), password: unseal(pw)! });
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'user.caldav', objectType: 'user', objectId: user.id, details: { url: b.url.trim(), ok: test.ok } });
    return { ok: test.ok, test };
  });
  app.delete('/me/caldav', async (req) => { const user = requireUser(req); await db.query(`update users set caldav_url = null, caldav_user = null, caldav_password = null where id = $1`, [user.id]); return { ok: true }; });

  // Termin in den eigenen Kalender schreiben (anlegen oder aktualisieren); Kennung je Person und Ziel in meetings.external
  app.post<{ Params: { id: string }; Body: { target: 'microsoft' | 'google' | 'caldav' } }>('/meetings/:id/push', async (req) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select * from meetings where id = $1`, [req.params.id]);
    if (!cur) throw notFound('Besprechung nicht gefunden');
    await requireProject(db, user, cur.project_id);
    if (cur.tentative) throw badRequest('Termin ist vorläufig: erst bestätigen, dann in den Kalender übernehmen');
    const target = req.body?.target;
    const t = (await targetsOf(user)).find((x) => x.key === target);
    if (!t) throw badRequest('Kalenderziel nicht eingerichtet (Meine Einstellungen › Kalender bzw. Mail › Mit Microsoft 365/Google verbinden)');
    const project = await db.one(`select key from projects where id = $1`, [cur.project_id]);
    const ev: PushEvent = { uid: `meeting-${cur.id}@project`, title: `${project.key} ${cur.title}`, startsAt: new Date(cur.starts_at), endsAt: new Date(cur.ends_at), location: cur.location, description: `${cur.description ?? ''}\n${publicBase()}/projekte/${cur.project_id}/besprechungen`.trim(), attendees: (cur.attendees as MeetingAttendee[]).map((a) => ({ email: a.email, name: a.name })) };
    const external = cur.external ?? {};
    const mine = external[user.id] ?? {};
    let id: string;
    if (target === 'caldav') {
      const u = await db.one(`select caldav_url, caldav_user, caldav_password from users where id = $1`, [user.id]);
      id = await pushCaldav(app.fetchFn, { url: u.caldav_url, user: u.caldav_user, password: unseal(u.caldav_password)! }, ev, Number(external.sequence ?? 0));
    } else {
      const account = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [t.accountId]);
      const token = await app.mail.accessToken(account);
      id = target === 'microsoft' ? await pushGraph(app.fetchFn, token, ev, mine.microsoft ?? null) : await pushGoogle(app.fetchFn, token, ev, mine.google ?? null);
    }
    await db.query(`update meetings set external = external || $2::jsonb where id = $1`, [cur.id, JSON.stringify({ [user.id]: { ...mine, [target]: id } })]);
    await audit(db, { orgId: user.orgId, projectId: cur.project_id, userId: user.id, action: 'meeting.push', objectType: 'meeting', objectId: cur.id, details: { target, updated: Boolean(mine[target]) } });
    return { ok: true, target, updated: Boolean(mine[target]) };
  });

  function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!); }
}

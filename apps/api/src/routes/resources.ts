import type { FastifyInstance } from 'fastify';
import type { ResourceKind } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { getMembership, hasOrgRight, requireProject, requireTask } from '../rights.js';
import { dateStr } from '../tasks/service.js';
import { BOOKING_SELECT, BookingConflict, availability, createBooking, dayRange, decideBooking, deleteBooking, mapBookings, mapResource, updateBooking, type Actor } from '../resources/service.js';

const KINDS: ResourceKind[] = ['room', 'equipment', 'scaffold', 'vehicle', 'person', 'other'];
const RESOURCE_SELECT = `select r.*, p.key as project_key, g.name as approval_group_name, (select count(*)::int from resource_bookings b where b.resource_id = r.id and b.ends_at > now()) as future_bookings from resources r left join projects p on p.id = r.project_id left join groups g on g.id = r.approval_group_id`;

/**
 * Ressourcen (Pool des Mandanten oder je Projekt) und Belegungen (Konzept 10): Pool pflegen Org-Admin und Ressourcenverwaltung,
 * Projektressourcen Mitglieder; buchen ab Mitglied, Konflikte 409 mit conflicts (force nur PL oder „Projektplan ändern“),
 * vorläufige Überschneidungen als warnings; Abwesenheiten jede Person für sich; Verfügbarkeit frei / vorläufig / belegt.
 */
export async function resourceRoutes(app: FastifyInstance) {
  const db = app.db;
  const actorOf = (user: any): Actor => ({ id: user.id, name: user.name, orgId: user.orgId, kind: user.kind === 'agent' ? 'agent' : 'person', globalRole: user.globalRole, orgRights: user.orgRights ?? [] });
  const poolAdmin = (user: any) => hasOrgRight(user, 'resources_admin');
  const parseTimes = async (b: any) => {
    if (b.allDay || (b.startDate && b.dueDate)) { const s = String(b.startDate ?? b.startsAt ?? '').slice(0, 10); const e = String(b.dueDate ?? b.endDate ?? b.endsAt ?? s).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) throw badRequest('Datum als YYYY-MM-DD'); const r = dayRange(s, e); return { startsAt: r.starts, endsAt: r.ends, allDay: true }; }
    const s = new Date(b.startsAt); const e = b.endsAt ? new Date(b.endsAt) : new Date(s.getTime() + 3600_000);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) throw badRequest('Beginn und Ende als Zeitpunkt angeben');
    return { startsAt: s, endsAt: e, allDay: false };
  };
  const conflictReply = (reply: any, e: any) => { if (e instanceof BookingConflict) { reply.status(409); return { error: e.message, conflicts: e.conflicts }; } if (/dürfen|nur |setzen |tragen |bestätigt|Freigabegruppe|Person selbst|Org-Admin/.test(String(e?.message))) throw forbidden(e.message); throw badRequest(String(e?.message ?? e)); };

  // Ressourcen: Pool (alle Personen des Mandanten) und, mit projectId, die des Projekts (Leser)
  app.get<{ Querystring: { projectId?: string; all?: string } }>('/resources', async (req) => {
    const user = requireUser(req);
    if (req.query.projectId) await requireProject(db, user, req.query.projectId, 'reader');
    const rows = await db.query(`${RESOURCE_SELECT} where r.org_id = $1 and (r.project_id is null or r.project_id = $2) and ($3 or r.active) order by (r.project_id is not null) desc, r.kind, lower(r.name)`, [user.orgId, req.query.projectId ?? null, req.query.all === '1']);
    return { resources: rows.rows.map(mapResource) };
  });

  app.post<{ Body: any }>('/resources', async (req) => {
    const user = requireUser(req);
    const b: any = req.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name erforderlich');
    if (!KINDS.includes(b.kind)) throw badRequest('Art: room, equipment, scaffold, vehicle, person oder other');
    if (b.projectId) await requireProject(db, user, b.projectId, 'member'); else if (!poolAdmin(user)) throw forbidden('Pool-Ressourcen legen Org-Admin oder Ressourcenverwaltung an');
    if (b.approvalGroupId && !(await db.maybeOne(`select 1 from groups where id = $1 and org_id = $2`, [b.approvalGroupId, user.orgId]))) throw badRequest('Freigabegruppe nicht gefunden');
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email).trim())) throw badRequest('Mailadresse ungültig');
    if (await db.maybeOne(`select 1 from resources where org_id = $1 and project_id is not distinct from $2 and lower(name) = lower($3)`, [user.orgId, b.projectId ?? null, b.name.trim()])) throw badRequest('Eine Ressource mit diesem Namen gibt es schon');
    const r = await db.one(`insert into resources (org_id, project_id, kind, name, description, location, email, phone, organization, trade, approval_group_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [user.orgId, b.projectId ?? null, b.kind, b.name.trim().slice(0, 200), b.description?.trim() || null, b.location?.trim() || null, b.email?.trim().toLowerCase() || null, b.phone?.trim() || null, b.organization?.trim() || null, b.trade?.trim() || null, b.projectId ? null : b.approvalGroupId ?? null, user.id]);
    await audit(db, { orgId: user.orgId, projectId: b.projectId ?? undefined, userId: user.id, action: 'resource.create', objectType: 'resource', objectId: r.id, details: { name: b.name, kind: b.kind } });
    return { resource: mapResource(await db.one(`${RESOURCE_SELECT} where r.id = $1`, [r.id])) };
  });

  const manage = async (user: any, id: string, forDelete = false) => {
    const cur = await db.maybeOne(`${RESOURCE_SELECT} where r.id = $1 and r.org_id = $2`, [id, user.orgId]);
    if (!cur) throw notFound('Ressource nicht gefunden');
    if (cur.project_id) { const m = await requireProject(db, user, cur.project_id, 'member'); if (forDelete && m.role !== 'pl') throw forbidden('Projektressourcen deaktiviert oder löscht die PL'); }
    else if (!poolAdmin(user)) throw forbidden('Pool-Ressourcen pflegen Org-Admin oder Ressourcenverwaltung');
    return cur;
  };
  app.patch<{ Params: { id: string }; Body: any }>('/resources/:id', async (req) => {
    const user = requireUser(req);
    const b: any = req.body ?? {};
    const cur = await manage(user, req.params.id, b.active === false);
    if (b.kind !== undefined && !KINDS.includes(b.kind)) throw badRequest('Art ungültig');
    if (b.approvalGroupId && !(await db.maybeOne(`select 1 from groups where id = $1 and org_id = $2`, [b.approvalGroupId, user.orgId]))) throw badRequest('Freigabegruppe nicht gefunden');
    await db.query(`update resources set kind = coalesce($2, kind), name = coalesce($3, name), description = case when $4 then $5 else description end, location = case when $6 then $7 else location end, email = case when $8 then $9 else email end, phone = case when $10 then $11 else phone end, organization = case when $12 then $13 else organization end, trade = case when $14 then $15 else trade end, approval_group_id = case when $16 then $17::uuid else approval_group_id end, active = coalesce($18, active), updated_at = now() where id = $1`,
      [cur.id, b.kind ?? null, b.name?.trim().slice(0, 200) || null, 'description' in b, b.description?.trim() || null, 'location' in b, b.location?.trim() || null, 'email' in b, b.email?.trim().toLowerCase() || null, 'phone' in b, b.phone?.trim() || null, 'organization' in b, b.organization?.trim() || null, 'trade' in b, b.trade?.trim() || null, 'approvalGroupId' in b && !cur.project_id, b.approvalGroupId ?? null, typeof b.active === 'boolean' ? b.active : null]);
    await audit(db, { orgId: user.orgId, projectId: cur.project_id ?? undefined, userId: user.id, action: 'resource.update', objectType: 'resource', objectId: cur.id, details: Object.fromEntries(Object.keys(b).map((k) => [k, true])) });
    return { resource: mapResource(await db.one(`${RESOURCE_SELECT} where r.id = $1`, [cur.id])) };
  });
  // Löschen nur ohne künftige Belegungen, sonst deaktivieren
  app.delete<{ Params: { id: string } }>('/resources/:id', async (req) => {
    const user = requireUser(req);
    const cur = await manage(user, req.params.id, true);
    if (Number(cur.future_bookings) > 0) { await db.query(`update resources set active = false, updated_at = now() where id = $1`, [cur.id]); await audit(db, { orgId: user.orgId, projectId: cur.project_id ?? undefined, userId: user.id, action: 'resource.deactivate', objectType: 'resource', objectId: cur.id, details: { futureBookings: cur.future_bookings } }); return { ok: true, deactivated: true }; }
    await db.query(`delete from resources where id = $1`, [cur.id]);
    await audit(db, { orgId: user.orgId, projectId: cur.project_id ?? undefined, userId: user.id, action: 'resource.delete', objectType: 'resource', objectId: cur.id, details: { name: cur.name } });
    return { ok: true, deactivated: false };
  });

  // Belegungen: je Projekt (Leser), je Ressource (maskiert), je Person (eigene voll, fremde maskiert), Zeitraum from/to
  app.get<{ Querystring: { projectId?: string; resourceId?: string; userId?: string; taskId?: string; from?: string; to?: string; pool?: string } }>('/bookings', async (req) => {
    const user = requireUser(req);
    const q = req.query;
    if (q.projectId) await requireProject(db, user, q.projectId, 'reader');
    if (q.taskId) await requireTask(db, user, q.taskId);
    if (q.resourceId) { const r = await db.maybeOne(`select project_id from resources where id = $1 and org_id = $2`, [q.resourceId, user.orgId]); if (!r) throw notFound('Ressource nicht gefunden'); if (r.project_id) await requireProject(db, user, r.project_id, 'reader'); }
    if (!q.projectId && !q.resourceId && !q.userId && !q.taskId && q.pool !== '1') throw badRequest('projectId, resourceId, userId, taskId oder pool angeben');
    const rows = await db.query(`${BOOKING_SELECT} where b.org_id = $1 and ($2::uuid is null or b.project_id = $2) and ($3::uuid is null or b.resource_id = $3) and ($4::uuid is null or b.user_id = $4) and ($5::uuid is null or b.task_id = $5) and ($6::timestamptz is null or b.ends_at >= $6) and ($7::timestamptz is null or b.starts_at <= $7) and (not $8 or (b.resource_id is not null and r.project_id is null)) order by b.starts_at limit 500`,
      [user.orgId, q.projectId ?? null, q.resourceId ?? null, q.userId ?? null, q.taskId ?? null, q.from ?? null, q.to ?? null, q.pool === '1']);
    return { bookings: await mapBookings(db, rows.rows, user) };
  });

  app.get<{ Querystring: { resourceId?: string; userId?: string; startsAt: string; endsAt: string; excludeBookingId?: string; excludeMeetingId?: string } }>('/availability', async (req) => {
    const user = requireUser(req);
    const q = req.query;
    const s = new Date(q.startsAt); const e = new Date(q.endsAt);
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) throw badRequest('Zeitraum ungültig');
    if (!q.resourceId && !q.userId) throw badRequest('resourceId oder userId angeben');
    return availability(db, { resourceId: q.resourceId ?? null, userId: q.userId ?? null, startsAt: s, endsAt: e, excludeBookingId: q.excludeBookingId ?? null, excludeMeetingId: q.excludeMeetingId ?? null }, user);
  });

  // Buchen im Projekt (Ressource oder interne Person; frei, am AP oder an einer Besprechung)
  app.post<{ Params: { id: string }; Body: any }>('/projects/:id/bookings', async (req, reply) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b: any = req.body ?? {};
    if (b.taskId) { const { task } = await requireTask(db, user, b.taskId); if (task.project_id !== req.params.id) throw badRequest('Arbeitspaket gehört nicht zum Projekt'); }
    let t: { startsAt: Date; endsAt: Date; allDay: boolean };
    if (b.taskId && !b.startsAt && !b.startDate) {
      const task = await db.one(`select start_date, due_date from tasks where id = $1`, [b.taskId]);
      if (!task.start_date && !task.due_date) throw badRequest('Das Arbeitspaket hat keinen Zeitraum; Zeitraum angeben');
      const r = dayRange(dateStr(task.start_date ?? task.due_date)!, dateStr(task.due_date ?? task.start_date)!); t = { startsAt: r.starts, endsAt: r.ends, allDay: true };
    } else t = await parseTimes(b);
    try {
      const r = await createBooking(db, actorOf(user), { projectId: req.params.id, resourceId: b.resourceId ?? null, userId: b.userId ?? null, taskId: b.taskId ?? null, meetingId: b.meetingId ?? null, followTask: Boolean(b.followTask) && Boolean(b.taskId), title: b.title, note: b.note, ...t, tentative: Boolean(b.tentative), force: Boolean(b.force) });
      const [booking] = await mapBookings(db, [r.booking], user);
      return { booking, warnings: r.warnings, requested: r.requested };
    } catch (e: any) { return conflictReply(reply, e); }
  });

  // Abwesenheit (eigene; Org-Admin für alle) und Sperrzeit einer Ressource (Pool: Org-Admin, Ressourcenverwaltung, Freigabegruppe; Projekt: PL)
  app.post<{ Body: any }>('/absences', async (req, reply) => {
    const user = requireUser(req);
    const b: any = req.body ?? {};
    const t = await parseTimes({ ...b, allDay: b.allDay !== false });
    try { const r = await createBooking(db, actorOf(user), { projectId: null, userId: b.userId ?? user.id, title: b.title ?? 'Abwesenheit', note: b.note, ...t }); return { booking: (await mapBookings(db, [r.booking], user))[0] }; } catch (e: any) { return conflictReply(reply, e); }
  });
  app.post<{ Params: { id: string }; Body: any }>('/resources/:id/blocks', async (req, reply) => {
    const user = requireUser(req);
    const b: any = req.body ?? {};
    const t = await parseTimes(b);
    try { const r = await createBooking(db, actorOf(user), { projectId: null, resourceId: req.params.id, title: b.title ?? 'Sperrzeit', note: b.note, ...t }); return { booking: (await mapBookings(db, [r.booking], user))[0] }; } catch (e: any) { return conflictReply(reply, e); }
  });
  app.get('/me/absences', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(`${BOOKING_SELECT} where b.user_id = $1 and b.project_id is null and b.ends_at > now() - interval '30 days' order by b.starts_at`, [user.id]);
    return { absences: await mapBookings(db, rows.rows, user) };
  });

  app.patch<{ Params: { id: string }; Body: any }>('/bookings/:id', async (req, reply) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select id from resource_bookings where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!cur) throw notFound('Belegung nicht gefunden');
    const b: any = req.body ?? {};
    const t = b.startsAt || b.startDate ? await parseTimes(b) : {};
    try { const r = await updateBooking(db, actorOf(user), cur.id, { ...t, title: b.title, note: b.note, followTask: b.followTask, tentative: b.tentative }); return { booking: (await mapBookings(db, [r], user))[0] }; } catch (e: any) { return conflictReply(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/bookings/:id', async (req, reply) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select id from resource_bookings where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!cur) throw notFound('Belegung nicht gefunden');
    try { await deleteBooking(db, actorOf(user), cur.id); return { ok: true }; } catch (e: any) { return conflictReply(reply, e); }
  });
  app.post<{ Params: { id: string }; Body: { decision?: 'confirm' | 'decline'; text?: string } }>('/bookings/:id/decide', async (req, reply) => {
    const user = requireUser(req);
    const cur = await db.maybeOne(`select id from resource_bookings where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!cur) throw notFound('Belegung nicht gefunden');
    const d = req.body?.decision === 'decline' ? 'decline' : 'confirm';
    try { const r = await decideBooking(db, actorOf(user), cur.id, d, req.body?.text ?? null); return { booking: r ? (await mapBookings(db, [r], user))[0] : null }; } catch (e: any) { return conflictReply(reply, e); }
  });
  // Hilfsgröße für Formulare: Mitgliedschaft (Rolle) der anfragenden Person
  app.get<{ Params: { id: string } }>('/projects/:id/my-booking-rights', async (req) => { const user = requireUser(req); const m = await getMembership(db, req.params.id, user.id); return { canForce: Boolean(m && (m.role === 'pl' || m.canEditPlan)), canBook: Boolean(m && m.role !== 'reader') }; });
}

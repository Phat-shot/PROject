import type { FastifyInstance } from 'fastify';
import type { RaidItem, ProjectContact } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { requireProject } from '../rights.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { dateStr } from '../tasks/service.js';

const KINDS = ['risk', 'assumption', 'issue', 'decision'];
const STATUS = ['open', 'mitigated', 'closed'];

export function mapRaid(r: any): RaidItem {
  return {
    id: r.id, projectId: r.project_id, number: r.number, kind: r.kind, title: r.title, description: r.description ?? null,
    probability: r.probability ?? null, impact: r.impact ?? null, score: r.probability && r.impact ? r.probability * r.impact : null,
    status: r.status, ownerUserId: r.owner_user_id ?? null, ownerName: r.owner_name ?? null, dueDate: dateStr(r.due_date), mitigation: r.mitigation ?? null,
    decidedOn: dateStr(r.decided_on), taskId: r.task_id ?? null, pageId: r.page_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at
  };
}
const mapContact = (r: any): ProjectContact => ({ id: r.id, projectId: r.project_id, email: r.email, name: r.name ?? null, role: r.role ?? null, organization: r.organization ?? null, phone: r.phone ?? null, notes: r.notes ?? null });

/** RAID-Register und Kontakte je Projekt. Lesen: jedes Mitglied; schreiben: Mitglied; löschen: PL. */
export async function raidRoutes(app: FastifyInstance) {
  const db = app.db;
  const SELECT = `select r.*, u.name as owner_name from raid_items r left join users u on u.id = r.owner_user_id`;

  app.get<{ Params: { id: string } }>('/projects/:id/raid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const rows = await db.query(`${SELECT} where r.project_id = $1 order by r.status = 'closed', coalesce(r.probability * r.impact, 0) desc, r.number`, [req.params.id]);
    return { items: rows.rows.map(mapRaid) };
  });

  const validate = (b: any) => {
    if (b.kind !== undefined && !KINDS.includes(b.kind)) throw badRequest('Art: risk, assumption, issue oder decision');
    if (b.status !== undefined && !STATUS.includes(b.status)) throw badRequest('Status: open, mitigated oder closed');
    for (const k of ['probability', 'impact']) if (b[k] != null && !(Number.isInteger(b[k]) && b[k] >= 1 && b[k] <= 5)) throw badRequest(`${k}: 1 bis 5`);
  };

  app.post<{ Params: { id: string }; Body: Partial<RaidItem> }>('/projects/:id/raid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? {};
    if (!b.title?.trim()) throw badRequest('Titel erforderlich');
    validate(b);
    const n = await db.one(`select coalesce(max(number), 0) + 1 as n from raid_items where project_id = $1`, [req.params.id]);
    const r = await db.one(
      `insert into raid_items (project_id, number, kind, title, description, probability, impact, status, owner_user_id, due_date, mitigation, decided_on, task_id, page_id, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [req.params.id, n.n, b.kind ?? 'risk', b.title.trim(), b.description ?? null, b.probability ?? null, b.impact ?? null, b.status ?? 'open', b.ownerUserId ?? null, b.dueDate ?? null, b.mitigation ?? null, b.decidedOn ?? null, b.taskId ?? null, b.pageId ?? null, user.id]
    );
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'raid.create', objectType: 'raid_item', objectId: r.id, details: { kind: r.kind, title: r.title } });
    return { item: mapRaid((await db.one(`${SELECT} where r.id = $1`, [r.id]))) };
  });

  app.patch<{ Params: { id: string; rid: string }; Body: Partial<RaidItem> }>('/projects/:id/raid/:rid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? {};
    validate(b);
    const cur = await db.maybeOne(`select * from raid_items where id = $1 and project_id = $2`, [req.params.rid, req.params.id]);
    if (!cur) throw notFound('Eintrag nicht gefunden');
    const v = (k: string, col: string) => (k in b ? (b as any)[k] : cur[col]);
    const r = await db.one(
      `update raid_items set kind = $3, title = $4, description = $5, probability = $6, impact = $7, status = $8, owner_user_id = $9, due_date = $10, mitigation = $11, decided_on = $12, task_id = $13, page_id = $14, updated_at = now() where id = $1 and project_id = $2 returning *`,
      [cur.id, req.params.id, v('kind', 'kind'), (b.title ?? cur.title).trim() || cur.title, v('description', 'description'), v('probability', 'probability'), v('impact', 'impact'), v('status', 'status'), v('ownerUserId', 'owner_user_id'), v('dueDate', 'due_date'), v('mitigation', 'mitigation'), v('decidedOn', 'decided_on'), v('taskId', 'task_id'), v('pageId', 'page_id')]
    );
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'raid.update', objectType: 'raid_item', objectId: r.id, details: b as any });
    return { item: mapRaid((await db.one(`${SELECT} where r.id = $1`, [r.id]))) };
  });

  app.delete<{ Params: { id: string; rid: string } }>('/projects/:id/raid/:rid', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    if (m.role !== 'pl') throw forbidden('Nur der PL löscht Einträge; sonst auf „geschlossen“ setzen');
    await db.query(`delete from raid_items where id = $1 and project_id = $2`, [req.params.rid, req.params.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'raid.delete', objectType: 'raid_item', objectId: req.params.rid });
    return { ok: true };
  });

  // ---- Kontakte (Stakeholder, Externe)
  app.get<{ Params: { id: string } }>('/projects/:id/contacts', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const rows = await db.query(`select * from project_contacts where project_id = $1 order by coalesce(name, email)`, [req.params.id]);
    return { contacts: rows.rows.map(mapContact) };
  });
  app.post<{ Params: { id: string }; Body: Partial<ProjectContact> }>('/projects/:id/contacts', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? {};
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Gültige E-Mail erforderlich');
    const r = await db.one(
      `insert into project_contacts (project_id, email, name, role, organization, phone, notes) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (project_id, email) do update set name = coalesce(excluded.name, project_contacts.name), role = coalesce(excluded.role, project_contacts.role), organization = coalesce(excluded.organization, project_contacts.organization), phone = coalesce(excluded.phone, project_contacts.phone), notes = coalesce(excluded.notes, project_contacts.notes) returning *`,
      [req.params.id, email, b.name?.trim() || null, b.role?.trim() || null, b.organization?.trim() || null, b.phone?.trim() || null, b.notes?.trim() || null]
    );
    return { contact: mapContact(r) };
  });
  app.patch<{ Params: { id: string; cid: string }; Body: Partial<ProjectContact> }>('/projects/:id/contacts/:cid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? {};
    const r = await db.maybeOne(
      `update project_contacts set name = coalesce($3, name), role = coalesce($4, role), organization = coalesce($5, organization), phone = coalesce($6, phone), notes = coalesce($7, notes) where id = $1 and project_id = $2 returning *`,
      [req.params.cid, req.params.id, b.name ?? null, b.role ?? null, b.organization ?? null, b.phone ?? null, b.notes ?? null]
    );
    if (!r) throw notFound('Kontakt nicht gefunden');
    return { contact: mapContact(r) };
  });
  app.delete<{ Params: { id: string; cid: string } }>('/projects/:id/contacts/:cid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    await db.query(`delete from project_contacts where id = $1 and project_id = $2`, [req.params.cid, req.params.id]);
    return { ok: true };
  });
}

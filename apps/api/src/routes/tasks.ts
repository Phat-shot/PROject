import type { FastifyInstance } from 'fastify';
import type { TaskPriority } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { queueAgentRun } from '../ai/agentEvents.js';
import { onWorkflowTaskDone } from '../workflows/engine.js';

import { canSeeSubproject, requireProject, visibleSubprojectSql } from '../rights.js';
import { assertResponsible, createRecurrenceInstance, dateStr, loadTask, loadTasks, mapSubproject, moveTask, newMailCode, resolveProjectLead, touchTask } from '../tasks/service.js';
import { mailAccess } from '../mail/access.js';
import { LEVEL_LABEL } from '../tasks/escalation.js';
import { nextDueDate, type Recurrence } from '../tasks/recurrence.js';
import { notify, notifyMany } from '../notify.js';
import { extractMentions } from '../tasks/mentions.js';

const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'critical'];

interface TaskBody {
  title?: string;
  description?: string | null;
  subprojectId?: string | null;
  columnId?: string;
  priority?: TaskPriority;
  startDate?: string | null;
  dueDate?: string | null;
  responsibleUserId?: string | null;
  responsibleEmail?: string | null;
  position?: number;
  predecessorIds?: string[];
  sourceMailId?: string | null;
  note?: string | null;
  labelIds?: string[];
  recurrence?: Recurrence | null;
  estimateMinutes?: number | null;
  blocked?: boolean;
  blockedReason?: string | null;
  /** Aufgabe zu diesem Arbeitspaket anlegen (nur beim Anlegen) */
  parentId?: string | null;
}

export async function taskRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get<{ Params: { id: string }; Querystring: { archived?: string } }>('/projects/:id/tasks', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const lead = await resolveProjectLead(db, req.params.id);
    const archived = req.query.archived === '1';
    const tasks = await loadTasks(db, `t.project_id = $1 and t.deleted_at is null and t.archived_at is ${archived ? 'not' : ''} null and ${visibleSubprojectSql(2)}`, [req.params.id, user.id], lead);
    return { tasks };
  });

  // Labels je Projekt
  app.post<{ Params: { id: string }; Body: { name: string; color?: string } }>('/projects/:id/labels', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    if (!req.body?.name?.trim()) throw badRequest('Name erforderlich');
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from labels where project_id = $1`, [req.params.id]);
    const r = await db.one(`insert into labels (project_id, name, color, position) values ($1,$2,$3,$4) returning *`, [req.params.id, req.body.name.trim(), req.body.color ?? 'gray', pos.p]);
    return { label: mapLabel(r) };
  });
  app.patch<{ Params: { id: string; lid: string }; Body: { name?: string; color?: string } }>('/projects/:id/labels/:lid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const r = await db.maybeOne(`update labels set name = coalesce($3, name), color = coalesce($4, color) where id = $1 and project_id = $2 returning *`, [req.params.lid, req.params.id, req.body?.name ?? null, req.body?.color ?? null]);
    if (!r) throw notFound('Label nicht gefunden');
    return { label: mapLabel(r) };
  });
  app.delete<{ Params: { id: string; lid: string } }>('/projects/:id/labels/:lid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    await db.query(`delete from labels where id = $1 and project_id = $2`, [req.params.lid, req.params.id]);
    return { ok: true };
  });

  // Sortieren / Verschieben per Drag & Drop
  app.post<{ Params: { id: string }; Body: { columnId: string; index?: number | null } }>('/tasks/:id/move', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, existing.project_id, 'member');
    const col = await db.maybeOne(`select * from board_columns where id = $1 and project_id = $2`, [req.body?.columnId, existing.project_id]);
    if (!col) throw badRequest('Spalte gehört nicht zum Projekt');
    const prevCol = await db.one(`select * from board_columns where id = $1`, [existing.column_id]);
    await moveTask(db, existing.id, col.id, req.body?.index ?? null);
    await touchTask(db, existing.id);
    if (col.id !== existing.column_id) {
      await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.move', objectType: 'task', objectId: existing.id, details: { from: prevCol.name, to: col.name } });
      if (col.is_done && !prevCol.is_done) await onTaskDone(existing, user);
    }
    return { task: await loadTask(db, existing.id) };
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/archive', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, existing.project_id, 'member');
    await db.query(`update tasks set archived_at = now(), updated_at = now() where id = $1 or (parent_id = $1 and archived_at is null)`, [existing.id]);
    await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.archive', objectType: 'task', objectId: existing.id, details: { title: existing.title } });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/tasks/:id/unarchive', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, existing.project_id, 'member');
    await db.query(`update tasks set archived_at = null, updated_at = now() where id = $1 or (parent_id = $1 and deleted_at is null)`, [existing.id]);
    return { task: await loadTask(db, existing.id) };
  });
  // Alle erledigten Arbeitspakete einer Spalte archivieren
  app.post<{ Params: { id: string; cid: string } }>('/projects/:id/columns/:cid/archive-done', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const r = await db.query(`update tasks set archived_at = now() where project_id = $1 and column_id = $2 and archived_at is null and parent_id is null returning id`, [req.params.id, req.params.cid]);
    if (r.rows.length) await db.query(`update tasks set archived_at = now() where parent_id = any($1::uuid[]) and archived_at is null`, [r.rows.map((x: any) => x.id)]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'task.archive_column', objectType: 'board_column', objectId: req.params.cid, details: { count: r.rows.length } });
    return { archived: r.rows.length };
  });

  // Querschnitt: Meine Arbeitspakete über alle Projekte (ausdrücklich oder geerbt zuständig)
  // Arbeitspakete über alle aktiven Projekte: scope=mine (Standard, nur eigene offene) oder scope=all (alle offenen, auch org-sichtbare Projekte)
  app.get<{ Querystring: { scope?: string; done?: string } }>('/my/tasks', async (req) => {
    const user = requireUser(req);
    const all = req.query.scope === 'all';
    const tasks = await loadTasks(
      db,
      `t.archived_at is null and exists (select 1 from projects p where p.id = t.project_id and p.status = 'active' and p.org_id = $2
         and (exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $1) ${all ? "or p.visibility = 'org'" : ''})) and ${visibleSubprojectSql(1)}`,
      [user.id, user.orgId]
    );
    const keys = await db.query(`select id, key from projects where org_id = $1`, [user.orgId]);
    const keyOf = new Map(keys.rows.map((r: any) => [r.id, r.key]));
    const list = tasks.filter((t) => (all || t.responsible.userId === user.id) && (req.query.done === '1' || !t.done)).map((t) => ({ ...t, projectKey: keyOf.get(t.projectId) ?? '' }));
    return { tasks: list };
  });

  // Kalender über alle Projekte: Meilensteine der Projekte, in denen ich Mitglied bin oder die für alle sichtbar sind
  app.get('/my/calendar', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select m.id, m.name, m.date, m.project_id, p.key from milestones m join projects p on p.id = m.project_id
       where p.org_id = $2 and p.status = 'active' and (exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $1) or p.visibility = 'org') order by m.date`,
      [user.id, user.orgId]
    );
    const meetings = await db.query(
      `select m.id, m.title, m.starts_at, m.ends_at, m.project_id, p.key from meetings m join projects p on p.id = m.project_id
       where p.org_id = $2 and p.status = 'active' and exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $1) order by m.starts_at`,
      [user.id, user.orgId]).catch(() => ({ rows: [] as any[] }));
    return {
      milestones: rows.rows.map((r: any) => ({ id: r.id, name: r.name, date: dateStr(r.date), projectId: r.project_id, projectKey: r.key })),
      meetings: meetings.rows.map((r: any) => ({ id: r.id, title: r.title, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), projectId: r.project_id, projectKey: r.key }))
    };
  });

  // Wartet auf dich über alle Projekte: Mail-Entwürfe zur Freigabe (PL), Seiten in Prüfung (PL oder „Final setzen“), blockierte und eskalierte Arbeitspakete (eigene oder als PL)
  app.get('/my/waiting', async (req) => {
    const user = requireUser(req);
    const ms = await db.query(`select m.*, p.key, p.name from project_members m join projects p on p.id = m.project_id where m.user_id = $1 and p.status = 'active'`, [user.id]);
    const drafts: any[] = []; const pages: any[] = []; const tasksOut: any[] = [];
    for (const m of ms.rows) {
      if (m.role === 'pl') {
        const c = await db.one(`select count(*)::int as c from mail_drafts where project_id = $1 and status = 'pending_approval'`, [m.project_id]);
        if (c.c > 0) drafts.push({ projectId: m.project_id, projectKey: m.key, count: c.c });
      }
      if (m.role === 'pl' || m.can_finalize) {
        const r = await db.query(`select id, title, updated_at from doc_pages where project_id = $1 and status = 'review' and deleted_at is null order by updated_at desc limit 5`, [m.project_id]);
        for (const p of r.rows) pages.push({ id: p.id, title: p.title, projectId: m.project_id, projectKey: m.key, updatedAt: p.updated_at });
      }
      const esc = await loadTasks(db, `t.project_id = $1 and t.archived_at is null and (t.blocked or t.escalation_level > 0)`, [m.project_id]);
      for (const t of esc) if (!t.done && (m.role === 'pl' || t.responsible.userId === user.id)) tasksOut.push({ id: t.id, number: t.number, title: t.title, projectId: t.projectId, projectKey: m.key, blocked: t.blocked, escalationLevel: t.escalationLevel });
    }
    return { drafts, pagesInReview: pages, tasks: tasksOut };
  });

  // Meine Arbeit: Projekte, Teilprojekte, Arbeitspakete und Tasks, geklammert nach Hierarchie; nur eigene bzw. geerbte Zuständigkeit (Filter im Client)
  app.get('/my/work', async (req) => {
    const user = requireUser(req);
    const projects = await db.query(
      `select p.id, p.key, p.name, m.role as my_role from projects p join project_members m on m.project_id = p.id and m.user_id = $1 where p.status = 'active' and p.kind = 'project' and p.org_id = $2 order by p.name`,
      [user.id, user.orgId]
    );
    const out: any[] = [];
    for (const p of projects.rows) {
      const lead = await resolveProjectLead(db, p.id);
      const subs = await db.query(
        `select s.*, u.name as responsible_name, u.email as responsible_email from subprojects s left join users u on u.id = s.responsible_user_id where s.project_id = $1
           and (not s.restricted or s.responsible_user_id = $2 or $3 or exists (select 1 from subproject_access a where a.subproject_id = s.id and (a.user_id = $2 or a.group_id in (select group_id from group_members gm where gm.user_id = $2))))
         order by s.position, s.created_at`,
        [p.id, user.id, p.my_role === 'pl']
      );
      const tasks = await loadTasks(db, `t.project_id = $1 and t.archived_at is null and ${visibleSubprojectSql(2)}`, [p.id, user.id], lead);
      const items = tasks.length ? (await db.query(`select * from checklist_items where task_id = any($1::uuid[]) order by position, title`, [tasks.map((t) => t.id)])).rows : [];
      out.push({
        id: p.id, key: p.key, name: p.name, myRole: p.my_role, lead,
        subprojects: subs.rows.map((r: any) => mapSubproject(r, lead)),
        tasks,
        checklist: items.map((c: any) => ({ id: c.id, taskId: c.task_id, title: c.title, done: c.done, responsibleUserId: c.responsible_user_id, responsibleEmail: c.responsible_email ?? null, position: c.position }))
      });
    }
    return { projects: out };
  });

  app.post<{ Params: { id: string }; Body: TaskBody }>('/projects/:id/tasks', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? {};
    if (!b.title?.trim()) throw badRequest('Titel erforderlich');
    await assertResponsible(db, req.params.id, m, b.responsibleUserId);
    let columnId = b.columnId;
    if (!columnId) {
      const c = await db.one(`select id from board_columns where project_id = $1 order by position limit 1`, [req.params.id]);
      columnId = c.id;
    } else {
      const c = await db.maybeOne(`select id from board_columns where id = $1 and project_id = $2`, [columnId, req.params.id]);
      if (!c) throw badRequest('Spalte gehört nicht zum Projekt');
    }
    if (b.priority && !PRIORITIES.includes(b.priority)) throw badRequest('Ungültige Priorität');
    if (b.subprojectId) {
      const s = await db.maybeOne(`select id from subprojects where id = $1 and project_id = $2`, [b.subprojectId, req.params.id]);
      if (!s) throw badRequest('Teilprojekt gehört nicht zum Projekt');
    }
    // Aufgabe: hängt an einem Arbeitspaket desselben Projekts (eine Ebene), Teilprojekt folgt dem Arbeitspaket
    let subprojectId = b.subprojectId ?? null;
    if (b.parentId) {
      const parent = await db.maybeOne(`select id, parent_id, subproject_id from tasks where id = $1 and project_id = $2 and deleted_at is null`, [b.parentId, req.params.id]);
      if (!parent) throw badRequest('Arbeitspaket gehört nicht zum Projekt');
      if (parent.parent_id) throw badRequest('Aufgaben haben keine eigenen Aufgaben');
      if (!(await canSeeSubproject(db, user.id, parent.subproject_id))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
      subprojectId = parent.subproject_id;
    }
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1 and parent_id is not distinct from $2`, [columnId, b.parentId ?? null]);
    const r = await db.one(
      `insert into tasks (project_id, subproject_id, column_id, title, description, priority, start_date, due_date, responsible_user_id, responsible_email, position, mail_code, created_by, parent_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [req.params.id, subprojectId, columnId, b.title.trim(), b.description ?? null, b.priority ?? 'normal', b.startDate ?? null, b.dueDate ?? null,
        b.responsibleUserId ?? null, b.responsibleEmail?.trim() || null, pos.p, newMailCode(), user.id, b.parentId ?? null]
    );
    if (b.responsibleEmail) await rememberContact(req.params.id, b.responsibleEmail);
    if (b.predecessorIds) await setPredecessors(r.id, req.params.id, b.predecessorIds);
    if (b.responsibleUserId) queueAgentRun(r.id, 'assigned');
    if (b.labelIds) await setLabels(r.id, req.params.id, b.labelIds);
    if (b.recurrence) await db.query(`update tasks set recurrence = $2 where id = $1`, [r.id, JSON.stringify(b.recurrence)]);
    if (b.estimateMinutes) await db.query(`update tasks set estimate_minutes = $2 where id = $1`, [r.id, Math.round(b.estimateMinutes)]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'task.create', objectType: 'task', objectId: r.id, details: { title: b.title, ...(b.parentId ? { parentId: b.parentId } : {}) } });
    if (b.parentId) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [b.parentId, user.id, `Aufgabe angelegt: ${b.title.trim()}`]);
    if (b.responsibleUserId) await notify(db, { userId: b.responsibleUserId, projectId: req.params.id, type: 'task.assigned', title: `Dir zugewiesen: ${b.title.trim()}`, body: `von ${user.name}`, link: `/projekte/${req.params.id}/board?task=${r.id}`, dedupeKey: null });
    return { task: await loadTask(db, r.id) };
  });

  app.get<{ Params: { id: string } }>('/tasks/:id', async (req) => {
    const user = requireUser(req);
    const task = await loadTask(db, req.params.id);
    if (!task) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, task.projectId);
    if (!(await canSeeSubproject(db, user.id, task.subprojectId))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    const comments = await db.query(
      `select c.*, u.name as user_name from task_comments c join users u on u.id = c.user_id where c.task_id = $1 order by c.created_at`,
      [task.id]
    );
    const mails = await db.query(
      `select m.id, m.subject, m.from_addr, m.from_name, m.date, m.snippet, m.outgoing, m.to_json, l.copied, l.checklist_item_id, m.account_id from mail_task_links l join mails m on m.id = l.mail_id where l.task_id = $1 order by m.date desc`,
      [task.id]
    );
    const attachments = await db.query(`select * from attachments where task_id = $1 order by created_at`, [task.id]);
    const meetings = await db.query(`select m.id, m.title, m.starts_at, m.page_id from meeting_tasks mt join meetings m on m.id = mt.meeting_id where mt.task_id = $1 order by m.starts_at desc`, [task.id]);
    const subtasks = task.parentId ? [] : await loadTasks(db, `t.parent_id = $1 and t.deleted_at is null`, [task.id]);
    return {
      task,
      subtasks,
      meetings: meetings.rows.map((m: any) => ({ id: m.id, title: m.title, startsAt: new Date(m.starts_at).toISOString(), pageId: m.page_id })),
      comments: comments.rows.map((c: any) => ({ id: c.id, taskId: c.task_id, userId: c.user_id, userName: c.user_name, body: c.body, source: c.source, mailId: c.mail_id, mentions: c.mentions ?? [], createdAt: c.created_at })),
      mails: mails.rows.map((m: any) => ({ id: m.id, subject: m.subject, fromAddr: m.from_addr, fromName: m.from_name, to: m.to_json ?? [], date: m.date, snippet: m.snippet, outgoing: Boolean(m.outgoing), copied: m.copied, checklistItemId: m.checklist_item_id ?? null, accountId: m.account_id })),
      attachments: attachments.rows.map(mapAttachment)
    };
  });

  app.patch<{ Params: { id: string }; Body: TaskBody }>('/tasks/:id', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Arbeitspaket nicht gefunden');
    const m = await requireProject(db, user, existing.project_id, 'member');
    if (!(await canSeeSubproject(db, user.id, existing.subproject_id))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    const b = req.body ?? {};
    if (existing.parent_id) delete b.subprojectId;
    if ('responsibleUserId' in b) await assertResponsible(db, existing.project_id, m, b.responsibleUserId);
    // Mail als Beleg: nur eine Mail, die man selbst lesen darf
    if (b.sourceMailId && !(await mailAccess(db, user, b.sourceMailId)).ok) throw forbidden('Kein Leserecht an dieser Mail');
    if (b.priority && !PRIORITIES.includes(b.priority)) throw badRequest('Ungültige Priorität');
    if (b.subprojectId && !(await canSeeSubproject(db, user.id, b.subprojectId))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    if (b.columnId) {
      const c = await db.maybeOne(`select id from board_columns where id = $1 and project_id = $2`, [b.columnId, existing.project_id]);
      if (!c) throw badRequest('Spalte gehört nicht zum Projekt');
    }
    if (b.subprojectId) {
      const s = await db.maybeOne(`select id from subprojects where id = $1 and project_id = $2`, [b.subprojectId, existing.project_id]);
      if (!s) throw badRequest('Teilprojekt gehört nicht zum Projekt');
    }
    const planChange = ('startDate' in b && b.startDate !== dateStr(existing.start_date)) || ('dueDate' in b && b.dueDate !== dateStr(existing.due_date)) || 'predecessorIds' in b;
    if (planChange && m.role !== 'pl' && !m.canEditPlan && existing.responsible_user_id !== user.id) {
      // Mitglieder ohne Planrecht dürfen Termine nur an eigenen Arbeitspaketen ändern.
      throw forbidden('Termine ändern erfordert das Recht „Projektplan ändern“ oder die Zuständigkeit für die Arbeitspaket');
    }
    await db.query(
      `update tasks set
         title = coalesce($2, title),
         description = case when $3 then $4 else description end,
         subproject_id = case when $5 then $6::uuid else subproject_id end,
         column_id = coalesce($7::uuid, column_id),
         priority = coalesce($8, priority),
         start_date = case when $9 then $10::date else start_date end,
         due_date = case when $11 then $12::date else due_date end,
         responsible_user_id = case when $13 then $14::uuid else responsible_user_id end,
         responsible_email = case when $15 then $16 else responsible_email end,
         position = coalesce($17, position),
         updated_at = now()
       where id = $1`,
      [req.params.id, b.title?.trim() || null, 'description' in b, b.description ?? null, 'subprojectId' in b, b.subprojectId ?? null, b.columnId ?? null, b.priority ?? null,
        'startDate' in b, b.startDate ?? null, 'dueDate' in b, b.dueDate ?? null, 'responsibleUserId' in b, b.responsibleUserId ?? null,
        'responsibleEmail' in b, b.responsibleEmail?.trim() || null, b.position ?? null]
    );
    if (b.responsibleEmail) await rememberContact(existing.project_id, b.responsibleEmail);
    if ('subprojectId' in b) await db.query(`update tasks set subproject_id = $2 where parent_id = $1`, [req.params.id, b.subprojectId ?? null]);
    if (b.predecessorIds) await setPredecessors(req.params.id, existing.project_id, b.predecessorIds);
    if (b.labelIds) await setLabels(req.params.id, existing.project_id, b.labelIds);
    if ('recurrence' in b) await db.query(`update tasks set recurrence = $2 where id = $1`, [req.params.id, b.recurrence ? JSON.stringify(b.recurrence) : null]);
    if ('estimateMinutes' in b) await db.query(`update tasks set estimate_minutes = $2 where id = $1`, [req.params.id, b.estimateMinutes && b.estimateMinutes > 0 ? Math.round(b.estimateMinutes) : null]);
    if ('blocked' in b && Boolean(b.blocked) !== existing.blocked) {
      await db.query(`update tasks set blocked = $2, blocked_reason = $3, blocked_at = case when $2 then now() else null end where id = $1`, [req.params.id, Boolean(b.blocked), b.blocked ? b.blockedReason?.trim() || null : null]);
      await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [req.params.id, user.id, b.blocked ? `Blockiert gemeldet${b.blockedReason ? `: ${b.blockedReason}` : ''}. Teilprojekt-Verantwortung wird informiert.` : 'Blockade aufgehoben.']);
      if (b.blocked) {
        const sub = await db.maybeOne(`select s.responsible_user_id from tasks t join subprojects s on s.id = t.subproject_id where t.id = $1`, [req.params.id]);
        const lead = await resolveProjectLead(db, existing.project_id);
        const tgt = sub?.responsible_user_id ?? lead.userId;
        if (tgt) await notify(db, { userId: tgt, projectId: existing.project_id, type: 'escalation', title: `Blockiert: ${existing.title}`, body: `${user.name}: ${b.blockedReason ?? 'kein Grund angegeben'}`, link: `/projekte/${existing.project_id}/board?task=${existing.id}` });
      }
    } else if ('blockedReason' in b && existing.blocked) {
      await db.query(`update tasks set blocked_reason = $2 where id = $1`, [req.params.id, b.blockedReason?.trim() || null]);
    }
    await touchTask(db, req.params.id);
    if (b.responsibleUserId && b.responsibleUserId !== existing.responsible_user_id && b.responsibleUserId !== user.id) {
      await notify(db, { userId: b.responsibleUserId, projectId: existing.project_id, type: 'task.assigned', title: `Dir zugewiesen: ${existing.title}`, body: `von ${user.name}`, link: `/projekte/${existing.project_id}/board?task=${existing.id}` });
    }
    if (b.columnId && b.columnId !== existing.column_id) {
      const newCol = await db.one(`select is_done from board_columns where id = $1`, [b.columnId]);
      const oldCol = await db.one(`select is_done from board_columns where id = $1`, [existing.column_id]);
      if (newCol.is_done && !oldCol.is_done) await onTaskDone(existing, user);
    }
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(b)) if (k !== 'sourceMailId' && k !== 'note') changed[k] = (b as any)[k];
    if (b.sourceMailId) {
      // Arbeitspaket anpassen mit Mail als Beleg: verknüpfen und Änderung im Log festhalten.
      const mail = await db.maybeOne(`select id, subject, from_addr, date from mails where id = $1`, [b.sourceMailId]);
      if (mail) {
        await db.query(`insert into mail_task_links (mail_id, task_id, copied, linked_by) values ($1,$2,false,$3) on conflict do nothing`, [mail.id, req.params.id, user.id]);
        const parts = Object.entries(changed).map(([k, v]) => `${k}: ${v ?? '–'}`).join(', ');
        await db.query(`insert into task_comments (task_id, user_id, body, source, mail_id) values ($1,$2,$3,'mail',$4)`,
          [req.params.id, user.id, `${b.note?.trim() ? b.note.trim() + '\n\n' : ''}Angepasst auf Grundlage der Mail „${mail.subject}“ von ${mail.from_addr} (${new Date(mail.date).toLocaleDateString('de-DE')}): ${parts}`, mail.id]);
        changed.sourceMailId = mail.id;
      }
    }
    await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.update', objectType: 'task', objectId: req.params.id, details: changed });
    if (b.responsibleUserId && b.responsibleUserId !== existing.responsible_user_id) queueAgentRun(req.params.id, 'assigned');
    else if (user.kind !== 'agent' && ['title', 'description', 'dueDate', 'startDate', 'columnId', 'blocked'].some((k) => k in b)) queueAgentRun(req.params.id, 'task_changed');
    return { task: await loadTask(db, req.params.id) };
  });

  // Löschen = Papierkorb (archived_at wird mitgesetzt, damit nichts mehr zählt); ?permanent=1 löscht endgültig
  app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>('/tasks/:id', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, existing.project_id, 'pl');
    if (req.query.permanent === '1') {
      await db.query(`delete from tasks where id = $1`, [req.params.id]);
      await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.delete', objectType: 'task', objectId: req.params.id, details: { title: existing.title, permanent: true } });
      return { ok: true };
    }
    if (!existing.deleted_at) {
      await db.query(`update tasks set deleted_at = now(), deleted_was_archived = archived_at is not null, archived_at = coalesce(archived_at, now()), updated_at = now() where id = $1 or (parent_id = $1 and deleted_at is null)`, [existing.id]);
      await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.trash', objectType: 'task', objectId: req.params.id, details: { title: existing.title } });
    }
    return { ok: true, trashed: true };
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/restore', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, existing.project_id, 'member');
    if (existing.deleted_at) {
      // Aufgaben, die mit dem Arbeitspaket in den Papierkorb gingen, kommen mit zurück
      await db.query(`update tasks set deleted_at = null, archived_at = case when deleted_was_archived then archived_at else null end, deleted_was_archived = false, updated_at = now() where id = $1 or (parent_id = $1 and deleted_at = $2)`, [existing.id, existing.deleted_at]);
      await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.restore', objectType: 'task', objectId: existing.id, details: { title: existing.title } });
    }
    return { task: await loadTask(db, existing.id) };
  });

  // Papierkorb des Projekts: Arbeitspakete und Seiten, endgültig gelöscht nach 30 Tagen
  app.get<{ Params: { id: string } }>('/projects/:id/trash', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const lead = await resolveProjectLead(db, req.params.id);
    // Aufgaben, deren Arbeitspaket selbst im Papierkorb liegt, kommen mit diesem zurück und stehen nicht einzeln da
    const tasks = await loadTasks(db, `t.project_id = $1 and t.deleted_at is not null and (pt.id is null or pt.deleted_at is null) and ${visibleSubprojectSql(2)}`, [req.params.id, user.id], lead);
    const pages = await db.query(`select id, title, status, deleted_at, folder_id from doc_pages where project_id = $1 and deleted_at is not null order by deleted_at desc`, [req.params.id]);
    return { tasks, pages: pages.rows.map((p: any) => ({ id: p.id, title: p.title, status: p.status, deletedAt: p.deleted_at, folderId: p.folder_id })), purgeAfterDays: 30 };
  });

  // W7: Nachfolger verschieben – Vorschau und Ausführung
  app.post<{ Params: { id: string }; Body: { apply?: boolean } }>('/tasks/:id/shift-successors', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Arbeitspaket nicht gefunden');
    const m = await requireProject(db, user, existing.project_id, 'member');
    if (m.role !== 'pl' && !m.canEditPlan) throw forbidden('Erfordert das Recht „Projektplan ändern“');
    const changes: { id: string; title: string; from: string | null; to: string; dueFrom: string | null; dueTo: string | null }[] = [];
    const visited = new Set<string>();
    const walk = async (predId: string, predDue: string) => {
      const succ = await db.query(`select t.* from task_dependencies d join tasks t on t.id = d.successor_id where d.predecessor_id = $1`, [predId]);
      for (const s of succ.rows) {
        if (visited.has(s.id)) continue;
        visited.add(s.id);
        const start = dateStr(s.start_date);
        const due = dateStr(s.due_date);
        const ref = start ?? due;
        if (!ref || ref >= predDue) continue;
        const shiftDays = daysBetween(ref, predDue);
        const newStart = start ? addDays(start, shiftDays) : null;
        const newDue = due ? addDays(due, shiftDays) : null;
        changes.push({ id: s.id, title: s.title, from: start, to: newStart ?? newDue!, dueFrom: due, dueTo: newDue });
        if (newDue) await walk(s.id, newDue);
      }
    };
    const predDue = dateStr(existing.due_date);
    if (predDue) await walk(existing.id, predDue);
    if (req.body?.apply) {
      for (const c of changes) {
        await db.query(`update tasks set start_date = $2, due_date = $3, updated_at = now() where id = $1`, [c.id, c.from ? c.to : null, c.dueTo]);
      }
      await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'plan.shift', objectType: 'task', objectId: existing.id, details: { changes } });
      // Betroffene informieren (Zuständige der verschobenen Arbeitspakete)
      for (const c of changes) {
        const t = (await loadTask(db, c.id))!;
        if (t.responsible.userId) await notify(db, { userId: t.responsible.userId, projectId: existing.project_id, type: 'plan.shifted', title: `Termin verschoben: ${t.title}`, body: `Neue Deadline ${c.dueTo ?? '–'} (vorher ${c.dueFrom ?? '–'}), ausgelöst durch „${existing.title}“ von ${user.name}`, link: `/projekte/${existing.project_id}/board?task=${t.id}` });
      }
    }
    return { changes, applied: Boolean(req.body?.apply) };
  });

  // Eskalation von Hand (Zuständiger, Teilprojekt-Verantwortlicher, PL) oder zurücksetzen (PL)
  app.post<{ Params: { id: string }; Body: { level: number; note?: string } }>('/tasks/:id/escalate', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select t.*, s.responsible_user_id as sub_resp from tasks t left join subprojects s on s.id = t.subproject_id where t.id = $1`, [req.params.id]);
    if (!existing) throw notFound('Arbeitspaket nicht gefunden');
    const m = await requireProject(db, user, existing.project_id, 'member');
    const level = Number(req.body?.level);
    if (![1, 2, 3].includes(level)) throw badRequest('Stufe 1 bis 3');
    const allowed = m.role === 'pl' || existing.responsible_user_id === user.id || existing.sub_resp === user.id;
    if (!allowed) throw forbidden('Eskalieren dürfen Zuständige, Teilprojekt-Verantwortliche und PL');
    const policy = (await db.one(`select escalation from projects where id = $1`, [existing.project_id])).escalation ?? {};
    const lead = await resolveProjectLead(db, existing.project_id);
    const targets = new Set<string>();
    if (level >= 1) targets.add(existing.sub_resp ?? lead.userId ?? '');
    if (level >= 2) (await db.query(`select user_id from project_members where project_id = $1 and role = 'pl'`, [existing.project_id])).rows.forEach((r: any) => targets.add(r.user_id));
    if (level >= 3 && policy.contactUserId) targets.add(policy.contactUserId);
    targets.delete('');
    const body = `${user.name} eskaliert von Hand${req.body?.note ? `: ${req.body.note}` : ''}`;
    await notifyMany(db, targets, { projectId: existing.project_id, type: 'escalation', title: `Eskalation ${LEVEL_LABEL[level]}: ${existing.title}`, body, link: `/projekte/${existing.project_id}/board?task=${existing.id}` }, user.id);
    await db.query(`update tasks set escalation_level = greatest(escalation_level, $2), escalated_at = now() where id = $1`, [existing.id, level]);
    await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [existing.id, user.id, `Eskalation ${LEVEL_LABEL[level]} (manuell). ${body}`]);
    await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'escalation.manual', objectType: 'task', objectId: existing.id, details: { level, note: req.body?.note ?? null } });
    return { task: await loadTask(db, existing.id) };
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/escalation/reset', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, existing.project_id, 'pl');
    await db.query(`update tasks set escalation_level = 0, escalated_at = null, last_activity_at = now() where id = $1`, [existing.id]);
    await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,'Eskalation durch PL zurückgesetzt.','system')`, [existing.id, user.id]);
    await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'escalation.reset', objectType: 'task', objectId: existing.id });
    return { task: await loadTask(db, existing.id) };
  });

  // Checkliste (Tasks)
  app.post<{ Params: { id: string }; Body: { title: string; responsibleUserId?: string | null; responsibleEmail?: string | null } }>('/tasks/:id/checklist', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select project_id from tasks where id = $1`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id, 'member');
    if (!req.body?.title?.trim()) throw badRequest('Titel erforderlich');
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from checklist_items where task_id = $1`, [req.params.id]);
    await db.query(`insert into checklist_items (task_id, title, responsible_user_id, responsible_email, position) values ($1,$2,$3,$4,$5)`, [req.params.id, req.body.title.trim(), req.body.responsibleUserId ?? null, req.body.responsibleEmail?.trim().toLowerCase() || null, pos.p]);
    if (user.kind !== 'agent') queueAgentRun(req.params.id, 'task_changed');
    return { task: await loadTask(db, req.params.id) };
  });

  app.patch<{ Params: { id: string; itemId: string }; Body: { title?: string; done?: boolean; responsibleUserId?: string | null; responsibleEmail?: string | null } }>('/tasks/:id/checklist/:itemId', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select project_id from tasks where id = $1`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id, 'member');
    const b = req.body ?? {};
    await db.query(
      `update checklist_items set title = coalesce($3, title), done = coalesce($4, done),
         responsible_user_id = case when $5 then $6::uuid else responsible_user_id end,
         responsible_email = case when $7 then $8 else responsible_email end
       where id = $1 and task_id = $2`,
      [req.params.itemId, req.params.id, b.title ?? null, b.done ?? null, 'responsibleUserId' in b, b.responsibleUserId ?? null, 'responsibleEmail' in b, b.responsibleEmail?.trim().toLowerCase() || null]
    );
    await touchTask(db, req.params.id);
    if (user.kind !== 'agent' && (b.title !== undefined || b.done !== undefined)) queueAgentRun(req.params.id, 'task_changed');
    return { task: await loadTask(db, req.params.id) };
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/tasks/:id/checklist/:itemId', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select project_id from tasks where id = $1`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id, 'member');
    await db.query(`delete from checklist_items where id = $1 and task_id = $2`, [req.params.itemId, req.params.id]);
    return { task: await loadTask(db, req.params.id) };
  });

  // Kommentare
  app.post<{ Params: { id: string }; Body: { body: string } }>('/tasks/:id/comments', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select project_id from tasks where id = $1`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id, 'member');
    if (!req.body?.body?.trim()) throw badRequest('Kommentar leer');
    const members = await db.query(`select m.user_id, u.name from project_members m join users u on u.id = m.user_id where m.project_id = $1`, [t.project_id]);
    const mentions = extractMentions(req.body.body, members.rows.map((r: any) => ({ userId: r.user_id, name: r.name })));
    const c = await db.one(`insert into task_comments (task_id, user_id, body, mentions) values ($1,$2,$3,$4) returning *`, [req.params.id, user.id, req.body.body.trim(), JSON.stringify(mentions)]);
    await touchTask(db, req.params.id);
    if (user.kind !== 'agent') queueAgentRun(req.params.id, 'comment');
    const task = (await loadTask(db, req.params.id))!;
    const link = `/projekte/${t.project_id}/board?task=${task.id}`;
    // Erwähnte zuerst (eigener Typ), danach Zuständige und bisherige Kommentatoren
    await notifyMany(db, mentions, { projectId: t.project_id, type: 'mention', title: `${user.name} hat dich erwähnt: „${task.title}“`, body: req.body.body.trim().slice(0, 160), link }, user.id);
    const others = await db.query(`select distinct user_id from task_comments where task_id = $1`, [req.params.id]);
    const targets = new Set<string>(others.rows.map((r: any) => r.user_id));
    if (task.responsible.userId) targets.add(task.responsible.userId);
    for (const m of mentions) targets.delete(m);
    await notifyMany(db, targets, { projectId: t.project_id, type: 'task.comment', title: `Kommentar zu „${task.title}“`, body: `${user.name}: ${req.body.body.trim().slice(0, 140)}`, link }, user.id);
    return { comment: { id: c.id, taskId: c.task_id, userId: c.user_id, userName: user.name, body: c.body, mentions, createdAt: c.created_at } };
  });

  async function rememberContact(projectId: string, email: string) {
    await db.query(`insert into project_contacts (project_id, email) values ($1, lower($2)) on conflict do nothing`, [projectId, email.trim()]);
  }

  async function setLabels(taskId: string, projectId: string, ids: string[]) {
    await db.query(`delete from task_labels where task_id = $1`, [taskId]);
    for (const l of ids) {
      await db.query(`insert into task_labels (task_id, label_id) select $1, id from labels where id = $2 and project_id = $3 on conflict do nothing`, [taskId, l, projectId]);
    }
  }

  /** W6: Wiederholung „nach Erledigung“ erzeugt die nächste Instanz. */
  async function onTaskDone(existing: any, user: { id: string; orgId: string }) {
    if (existing.workflow_run_id) await onWorkflowTaskDone(db, app.mail, existing.id);
    const r: Recurrence | null = existing.recurrence ?? null;
    if (!r || r.mode !== 'after_done' || !existing.due_date) return;
    const next = nextDueDate(dateStr(existing.due_date)!, r);
    const id = await createRecurrenceInstance(db, existing, next, true);
    await db.query(`update tasks set recurrence = null where id = $1`, [existing.id]);
    await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: null, action: 'task.recurrence_created', objectType: 'task', objectId: id, details: { from: existing.id, due: next, trigger: 'after_done' } });
  }

  async function setPredecessors(taskId: string, projectId: string, ids: string[]) {
    await db.query(`delete from task_dependencies where successor_id = $1`, [taskId]);
    for (const p of ids) {
      if (p === taskId) continue;
      const ok = await db.maybeOne(`select id from tasks where id = $1 and project_id = $2`, [p, projectId]);
      if (ok) await db.query(`insert into task_dependencies (predecessor_id, successor_id) values ($1,$2) on conflict do nothing`, [p, taskId]);
    }
  }
}

export function mapLabel(r: any) {
  return { id: r.id, projectId: r.project_id, name: r.name, color: r.color, position: r.position };
}

export function mapAttachment(a: any) {
  return { id: a.id, projectId: a.project_id, taskId: a.task_id, pageId: a.page_id, filename: a.filename, mime: a.mime, size: a.size, createdAt: a.created_at };
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
}
function addDays(d: string, n: number): string {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

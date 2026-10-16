import type { FastifyInstance } from 'fastify';
import type { TaskPriority } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { dateStr, loadTask, loadTasks, newMailCode, resolveProjectLead } from '../tasks/service.js';

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
}

export async function taskRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get<{ Params: { id: string } }>('/projects/:id/tasks', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const lead = await resolveProjectLead(db, req.params.id);
    const tasks = await loadTasks(db, 't.project_id = $1', [req.params.id], lead);
    return { tasks };
  });

  // Querschnitt: Meine Aufgaben über alle Projekte (ausdrücklich oder geerbt zuständig)
  app.get('/my/tasks', async (req) => {
    const user = requireUser(req);
    const tasks = await loadTasks(
      db,
      `t.project_id in (select project_id from project_members where user_id = $1)
       and exists (select 1 from projects p where p.id = t.project_id and p.status = 'active')`,
      [user.id]
    );
    const mine = tasks.filter((t) => t.responsible.userId === user.id && !t.done);
    return { tasks: mine };
  });

  app.post<{ Params: { id: string }; Body: TaskBody }>('/projects/:id/tasks', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? {};
    if (!b.title?.trim()) throw badRequest('Titel erforderlich');
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
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1`, [columnId]);
    const r = await db.one(
      `insert into tasks (project_id, subproject_id, column_id, title, description, priority, start_date, due_date, responsible_user_id, responsible_email, position, mail_code, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [req.params.id, b.subprojectId ?? null, columnId, b.title.trim(), b.description ?? null, b.priority ?? 'normal', b.startDate ?? null, b.dueDate ?? null,
        b.responsibleUserId ?? null, b.responsibleEmail?.trim() || null, pos.p, newMailCode(), user.id]
    );
    if (b.responsibleEmail) await rememberContact(req.params.id, b.responsibleEmail);
    if (b.predecessorIds) await setPredecessors(r.id, req.params.id, b.predecessorIds);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'task.create', objectType: 'task', objectId: r.id, details: { title: b.title } });
    return { task: await loadTask(db, r.id) };
  });

  app.get<{ Params: { id: string } }>('/tasks/:id', async (req) => {
    const user = requireUser(req);
    const task = await loadTask(db, req.params.id);
    if (!task) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, task.projectId);
    const comments = await db.query(
      `select c.*, u.name as user_name from task_comments c join users u on u.id = c.user_id where c.task_id = $1 order by c.created_at`,
      [task.id]
    );
    const mails = await db.query(
      `select m.id, m.subject, m.from_addr, m.date, l.copied, m.account_id from mail_task_links l join mails m on m.id = l.mail_id where l.task_id = $1 order by m.date desc`,
      [task.id]
    );
    const attachments = await db.query(`select * from attachments where task_id = $1 order by created_at`, [task.id]);
    return {
      task,
      comments: comments.rows.map((c: any) => ({ id: c.id, taskId: c.task_id, userId: c.user_id, userName: c.user_name, body: c.body, createdAt: c.created_at })),
      mails: mails.rows.map((m: any) => ({ id: m.id, subject: m.subject, fromAddr: m.from_addr, date: m.date, copied: m.copied, accountId: m.account_id })),
      attachments: attachments.rows.map(mapAttachment)
    };
  });

  app.patch<{ Params: { id: string }; Body: TaskBody }>('/tasks/:id', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Aufgabe nicht gefunden');
    const m = await requireProject(db, user, existing.project_id, 'member');
    const b = req.body ?? {};
    if (b.priority && !PRIORITIES.includes(b.priority)) throw badRequest('Ungültige Priorität');
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
      // Mitglieder ohne Planrecht dürfen Termine nur an eigenen Aufgaben ändern.
      throw forbidden('Termine ändern erfordert das Recht „Projektplan ändern“ oder die Zuständigkeit für die Aufgabe');
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
    if (b.predecessorIds) await setPredecessors(req.params.id, existing.project_id, b.predecessorIds);
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(b)) changed[k] = (b as any)[k];
    await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.update', objectType: 'task', objectId: req.params.id, details: changed });
    return { task: await loadTask(db, req.params.id) };
  });

  app.delete<{ Params: { id: string } }>('/tasks/:id', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, existing.project_id, 'pl');
    await db.query(`delete from tasks where id = $1`, [req.params.id]);
    await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.delete', objectType: 'task', objectId: req.params.id, details: { title: existing.title } });
    return { ok: true };
  });

  // W7: Nachfolger verschieben – Vorschau und Ausführung
  app.post<{ Params: { id: string }; Body: { apply?: boolean } }>('/tasks/:id/shift-successors', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Aufgabe nicht gefunden');
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
    }
    return { changes, applied: Boolean(req.body?.apply) };
  });

  // Checkliste (Tasks)
  app.post<{ Params: { id: string }; Body: { title: string; responsibleUserId?: string | null } }>('/tasks/:id/checklist', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select project_id from tasks where id = $1`, [req.params.id]);
    if (!t) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, t.project_id, 'member');
    if (!req.body?.title?.trim()) throw badRequest('Titel erforderlich');
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from checklist_items where task_id = $1`, [req.params.id]);
    await db.query(`insert into checklist_items (task_id, title, responsible_user_id, position) values ($1,$2,$3,$4)`, [req.params.id, req.body.title.trim(), req.body.responsibleUserId ?? null, pos.p]);
    return { task: await loadTask(db, req.params.id) };
  });

  app.patch<{ Params: { id: string; itemId: string }; Body: { title?: string; done?: boolean; responsibleUserId?: string | null } }>('/tasks/:id/checklist/:itemId', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select project_id from tasks where id = $1`, [req.params.id]);
    if (!t) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, t.project_id, 'member');
    const b = req.body ?? {};
    await db.query(
      `update checklist_items set title = coalesce($3, title), done = coalesce($4, done),
         responsible_user_id = case when $5 then $6::uuid else responsible_user_id end
       where id = $1 and task_id = $2`,
      [req.params.itemId, req.params.id, b.title ?? null, b.done ?? null, 'responsibleUserId' in b, b.responsibleUserId ?? null]
    );
    return { task: await loadTask(db, req.params.id) };
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/tasks/:id/checklist/:itemId', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select project_id from tasks where id = $1`, [req.params.id]);
    if (!t) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, t.project_id, 'member');
    await db.query(`delete from checklist_items where id = $1 and task_id = $2`, [req.params.itemId, req.params.id]);
    return { task: await loadTask(db, req.params.id) };
  });

  // Kommentare
  app.post<{ Params: { id: string }; Body: { body: string } }>('/tasks/:id/comments', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select project_id from tasks where id = $1`, [req.params.id]);
    if (!t) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, t.project_id, 'member');
    if (!req.body?.body?.trim()) throw badRequest('Kommentar leer');
    const c = await db.one(`insert into task_comments (task_id, user_id, body) values ($1,$2,$3) returning *`, [req.params.id, user.id, req.body.body.trim()]);
    return { comment: { id: c.id, taskId: c.task_id, userId: c.user_id, userName: user.name, body: c.body, createdAt: c.created_at } };
  });

  async function rememberContact(projectId: string, email: string) {
    await db.query(`insert into project_contacts (project_id, email) values ($1, lower($2)) on conflict do nothing`, [projectId, email.trim()]);
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

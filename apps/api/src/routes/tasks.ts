import type { FastifyInstance } from 'fastify';
import type { TaskPriority } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { createRecurrenceInstance, dateStr, loadTask, loadTasks, moveTask, newMailCode, resolveProjectLead } from '../tasks/service.js';
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
}

export async function taskRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get<{ Params: { id: string }; Querystring: { archived?: string } }>('/projects/:id/tasks', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const lead = await resolveProjectLead(db, req.params.id);
    const archived = req.query.archived === '1';
    const tasks = await loadTasks(db, `t.project_id = $1 and t.archived_at is ${archived ? 'not' : ''} null`, [req.params.id], lead);
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
    if (!existing) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, existing.project_id, 'member');
    const col = await db.maybeOne(`select * from board_columns where id = $1 and project_id = $2`, [req.body?.columnId, existing.project_id]);
    if (!col) throw badRequest('Spalte gehört nicht zum Projekt');
    const prevCol = await db.one(`select * from board_columns where id = $1`, [existing.column_id]);
    await moveTask(db, existing.id, col.id, req.body?.index ?? null);
    if (col.id !== existing.column_id) {
      await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.move', objectType: 'task', objectId: existing.id, details: { from: prevCol.name, to: col.name } });
      if (col.is_done && !prevCol.is_done) await onTaskDone(existing, user);
    }
    return { task: await loadTask(db, existing.id) };
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/archive', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, existing.project_id, 'member');
    await db.query(`update tasks set archived_at = now(), updated_at = now() where id = $1`, [existing.id]);
    await audit(db, { orgId: user.orgId, projectId: existing.project_id, userId: user.id, action: 'task.archive', objectType: 'task', objectId: existing.id, details: { title: existing.title } });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/tasks/:id/unarchive', async (req) => {
    const user = requireUser(req);
    const existing = await db.maybeOne(`select * from tasks where id = $1`, [req.params.id]);
    if (!existing) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, existing.project_id, 'member');
    await db.query(`update tasks set archived_at = null, updated_at = now() where id = $1`, [existing.id]);
    return { task: await loadTask(db, existing.id) };
  });
  // Alle erledigten Aufgaben einer Spalte archivieren
  app.post<{ Params: { id: string; cid: string } }>('/projects/:id/columns/:cid/archive-done', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const r = await db.query(`update tasks set archived_at = now() where project_id = $1 and column_id = $2 and archived_at is null returning id`, [req.params.id, req.params.cid]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'task.archive_column', objectType: 'board_column', objectId: req.params.cid, details: { count: r.rows.length } });
    return { archived: r.rows.length };
  });

  // Querschnitt: Meine Aufgaben über alle Projekte (ausdrücklich oder geerbt zuständig)
  app.get('/my/tasks', async (req) => {
    const user = requireUser(req);
    const tasks = await loadTasks(
      db,
      `t.project_id in (select project_id from project_members where user_id = $1) and t.archived_at is null
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
    if (b.labelIds) await setLabels(r.id, req.params.id, b.labelIds);
    if (b.recurrence) await db.query(`update tasks set recurrence = $2 where id = $1`, [r.id, JSON.stringify(b.recurrence)]);
    if (b.estimateMinutes) await db.query(`update tasks set estimate_minutes = $2 where id = $1`, [r.id, Math.round(b.estimateMinutes)]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'task.create', objectType: 'task', objectId: r.id, details: { title: b.title } });
    if (b.responsibleUserId) await notify(db, { userId: b.responsibleUserId, projectId: req.params.id, type: 'task.assigned', title: `Dir zugewiesen: ${b.title.trim()}`, body: `von ${user.name}`, link: `/projekte/${req.params.id}/board?task=${r.id}`, dedupeKey: null });
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
      comments: comments.rows.map((c: any) => ({ id: c.id, taskId: c.task_id, userId: c.user_id, userName: c.user_name, body: c.body, source: c.source, mailId: c.mail_id, mentions: c.mentions ?? [], createdAt: c.created_at })),
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
    if (b.labelIds) await setLabels(req.params.id, existing.project_id, b.labelIds);
    if ('recurrence' in b) await db.query(`update tasks set recurrence = $2 where id = $1`, [req.params.id, b.recurrence ? JSON.stringify(b.recurrence) : null]);
    if ('estimateMinutes' in b) await db.query(`update tasks set estimate_minutes = $2 where id = $1`, [req.params.id, b.estimateMinutes && b.estimateMinutes > 0 ? Math.round(b.estimateMinutes) : null]);
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
      // Aufgabe anpassen mit Mail als Beleg: verknüpfen und Änderung im Log festhalten.
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
      // Betroffene informieren (Zuständige der verschobenen Aufgaben)
      for (const c of changes) {
        const t = (await loadTask(db, c.id))!;
        if (t.responsible.userId) await notify(db, { userId: t.responsible.userId, projectId: existing.project_id, type: 'plan.shifted', title: `Termin verschoben: ${t.title}`, body: `Neue Deadline ${c.dueTo ?? '–'} (vorher ${c.dueFrom ?? '–'}), ausgelöst durch „${existing.title}“ von ${user.name}`, link: `/projekte/${existing.project_id}/board?task=${t.id}` });
      }
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
    const members = await db.query(`select m.user_id, u.name from project_members m join users u on u.id = m.user_id where m.project_id = $1`, [t.project_id]);
    const mentions = extractMentions(req.body.body, members.rows.map((r: any) => ({ userId: r.user_id, name: r.name })));
    const c = await db.one(`insert into task_comments (task_id, user_id, body, mentions) values ($1,$2,$3,$4) returning *`, [req.params.id, user.id, req.body.body.trim(), JSON.stringify(mentions)]);
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

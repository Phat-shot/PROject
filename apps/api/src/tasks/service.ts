import { randomBytes } from 'node:crypto';
import type { ResponsibleInfo, Subproject, Task } from '@projekttool/shared';
import type { Db } from '../db.js';

export interface LeadInfo {
  userId: string | null;
  name: string | null;
  email: string | null;
}

/** Verantwortlicher PL (nicht Stellvertreter) als Ende der Vererbungskette. */
export async function resolveProjectLead(db: Db, projectId: string): Promise<LeadInfo> {
  const r = await db.maybeOne(
    `select u.id, u.name, u.email from project_members m join users u on u.id = m.user_id
     where m.project_id = $1 and m.role = 'pl' order by m.is_deputy, m.created_at limit 1`,
    [projectId]
  );
  return r ? { userId: r.id, name: r.name, email: r.email } : { userId: null, name: null, email: null };
}

export function mapSubproject(r: any, lead: LeadInfo): Subproject {
  const responsible: ResponsibleInfo = r.responsible_user_id
    ? { userId: r.responsible_user_id, email: r.responsible_email, name: r.responsible_name, inherited: false, inheritedFrom: null }
    : { userId: lead.userId, email: lead.email, name: lead.name, inherited: true, inheritedFrom: 'project' };
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    responsibleUserId: r.responsible_user_id,
    responsible,
    startDate: dateStr(r.start_date),
    endDate: dateStr(r.end_date),
    position: r.position,
    restricted: Boolean(r.restricted),
    accessUserIds: (typeof r.access_user_ids === 'string' ? JSON.parse(r.access_user_ids) : r.access_user_ids) ?? [],
    accessGroupIds: (typeof r.access_group_ids === 'string' ? JSON.parse(r.access_group_ids) : r.access_group_ids) ?? []
  };
}

export function dateStr(d: any): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

export function newMailCode(): string {
  return randomBytes(4).toString('hex');
}

const TASK_SELECT = `
  select t.*, c.is_done,
    ru.name as responsible_name, ru.email as responsible_user_email,
    s.responsible_user_id as sp_responsible_user_id, su.name as sp_responsible_name, su.email as sp_responsible_email,
    s.end_date as sp_end_date,
    coalesce((select json_agg(d.predecessor_id) from task_dependencies d where d.successor_id = t.id), '[]'::json) as predecessor_ids,
    coalesce((select json_agg(tl.label_id) from task_labels tl where tl.task_id = t.id), '[]'::json) as label_ids,
    (select count(*)::int from task_comments x where x.task_id = t.id) as comment_count,
    (select count(*)::int from attachments x where x.task_id = t.id) as attachment_count,
    (select count(*)::int from mail_task_links x where x.task_id = t.id) as mail_count,
    (select coalesce(sum(minutes), 0)::int from time_entries x where x.task_id = t.id) as logged_minutes,
    (select count(*)::int from checklist_items x where x.task_id = t.id and x.done) as checklist_done,
    (select count(*)::int from checklist_items x where x.task_id = t.id) as checklist_total,
    coalesce((select json_agg(json_build_object('id', p.id, 'title', p.title, 'due', p.due_date)) from task_dependencies d join tasks p on p.id = d.predecessor_id where d.successor_id = t.id), '[]'::json) as predecessors
  from tasks t
  join board_columns c on c.id = t.column_id
  left join users ru on ru.id = t.responsible_user_id
  left join subprojects s on s.id = t.subproject_id
  left join users su on su.id = s.responsible_user_id`;

export async function loadTasks(db: Db, where: string, params: unknown[], lead?: LeadInfo): Promise<Task[]> {
  const rows = await db.query(`${TASK_SELECT} where ${where} order by t.position, t.created_at`, params);
  const leads = new Map<string, LeadInfo>();
  const out: Task[] = [];
  for (const r of rows.rows) {
    let l = lead;
    if (!l) {
      l = leads.get(r.project_id);
      if (!l) {
        l = await resolveProjectLead(db, r.project_id);
        leads.set(r.project_id, l);
      }
    }
    out.push(mapTask(r, l));
  }
  return out;
}

export async function loadTask(db: Db, id: string): Promise<Task | null> {
  const r = await db.maybeOne(`${TASK_SELECT} where t.id = $1`, [id]);
  if (!r) return null;
  const task = mapTask(r, await resolveProjectLead(db, r.project_id));
  const cl = await db.query(`select * from checklist_items where task_id = $1 order by position, title`, [id]);
  task.checklist = cl.rows.map((c: any) => ({ id: c.id, taskId: c.task_id, title: c.title, done: c.done, responsibleUserId: c.responsible_user_id, responsibleEmail: c.responsible_email ?? null, position: c.position }));
  return task;
}

/** Vererbung: Arbeitspaket → Teilprojekt → PL. Konflikte: Deadline nach Teilprojekt-Ende, Start vor Vorgänger-Ende. */
export function mapTask(r: any, lead: LeadInfo): Task {
  let responsible: ResponsibleInfo;
  if (r.responsible_user_id) {
    responsible = { userId: r.responsible_user_id, email: r.responsible_user_email, name: r.responsible_name, inherited: false, inheritedFrom: null };
  } else if (r.responsible_email) {
    responsible = { userId: null, email: r.responsible_email, name: null, inherited: false, inheritedFrom: null };
  } else if (r.sp_responsible_user_id) {
    responsible = { userId: r.sp_responsible_user_id, email: r.sp_responsible_email, name: r.sp_responsible_name, inherited: true, inheritedFrom: 'subproject' };
  } else {
    responsible = { userId: lead.userId, email: lead.email, name: lead.name, inherited: true, inheritedFrom: 'project' };
  }
  const conflicts: string[] = [];
  const due = dateStr(r.due_date);
  const start = dateStr(r.start_date);
  const spEnd = dateStr(r.sp_end_date);
  if (due && spEnd && due > spEnd) conflicts.push(`Deadline ${due} liegt nach Teilprojekt-Ende ${spEnd}`);
  const preds = typeof r.predecessors === 'string' ? JSON.parse(r.predecessors) : r.predecessors ?? [];
  for (const p of preds) {
    const pDue = dateStr(p.due);
    const ref = start ?? due;
    if (pDue && ref && ref < pDue) conflicts.push(`Vorgänger „${p.title}“ endet ${pDue}, Arbeitspaket beginnt ${ref}`);
  }
  const predIds = typeof r.predecessor_ids === 'string' ? JSON.parse(r.predecessor_ids) : r.predecessor_ids ?? [];
  const labelIds = typeof r.label_ids === 'string' ? JSON.parse(r.label_ids) : r.label_ids ?? [];
  return {
    number: r.number ?? 0,
    labelIds,
    archivedAt: r.archived_at,
    recurrence: r.recurrence ?? null,
    estimateMinutes: r.estimate_minutes ?? null,
    loggedMinutes: r.logged_minutes ?? 0,
    blocked: Boolean(r.blocked),
    blockedReason: r.blocked_reason ?? null,
    escalationLevel: r.escalation_level ?? 0,
    escalatedAt: r.escalated_at ?? null,
    hasDescription: Boolean(r.description && String(r.description).trim()),
    commentCount: r.comment_count ?? 0,
    attachmentCount: r.attachment_count ?? 0,
    mailCount: r.mail_count ?? 0,
    checklistDone: r.checklist_done ?? 0,
    checklistTotal: r.checklist_total ?? 0,
    id: r.id,
    projectId: r.project_id,
    subprojectId: r.subproject_id,
    columnId: r.column_id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    startDate: start,
    dueDate: due,
    responsibleUserId: r.responsible_user_id,
    responsibleEmail: r.responsible_email,
    responsible,
    position: r.position,
    mailCode: r.mail_code,
    done: r.is_done,
    conflicts,
    predecessorIds: predIds,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}


/** Reiht ein Arbeitspaket in einer Spalte an Position index ein und nummeriert die Spalte neu. */
export async function moveTask(db: Db, taskId: string, columnId: string, index: number | null) {
  const others = await db.query(`select id from tasks where column_id = $1 and id <> $2 and archived_at is null order by position, created_at`, [columnId, taskId]);
  const ids = others.rows.map((r: any) => r.id as string);
  const at = index === null || index < 0 || index > ids.length ? ids.length : index;
  ids.splice(at, 0, taskId);
  for (const [i, id] of ids.entries()) {
    await db.query(`update tasks set position = $2, column_id = $3, updated_at = case when id = $4 then now() else updated_at end where id = $1`, [id, i, columnId, taskId]);
  }
}

/** Kopiert ein Arbeitspaket als nächste Instanz einer Wiederholung (Checkliste offen, Labels gleich). */
export async function createRecurrenceInstance(db: Db, source: any, nextDue: string, keepRecurrence: boolean): Promise<string> {
  const firstCol = await db.one(`select id from board_columns where project_id = $1 order by position limit 1`, [source.project_id]);
  const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1`, [firstCol.id]);
  let start: string | null = null;
  if (source.start_date && source.due_date) {
    const span = Math.round((new Date(dateStr(source.due_date)! + 'T00:00:00Z').getTime() - new Date(dateStr(source.start_date)! + 'T00:00:00Z').getTime()) / 86400_000);
    const d = new Date(nextDue + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - span); start = d.toISOString().slice(0, 10);
  }
  const r = await db.one(
    `insert into tasks (project_id, subproject_id, column_id, title, description, priority, start_date, due_date, responsible_user_id, responsible_email, position, mail_code, created_by, recurrence, recurrence_parent_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [source.project_id, source.subproject_id, firstCol.id, source.title, source.description, source.priority, start, nextDue, source.responsible_user_id, source.responsible_email, pos.p, newMailCode(), source.created_by,
      keepRecurrence ? JSON.stringify(source.recurrence) : null, source.recurrence_parent_id ?? source.id]
  );
  await db.query(`insert into task_labels (task_id, label_id) select $1, label_id from task_labels where task_id = $2`, [r.id, source.id]);
  await db.query(`insert into checklist_items (task_id, title, responsible_user_id, position) select $1, title, responsible_user_id, position from checklist_items where task_id = $2`, [r.id, source.id]);
  return r.id;
}


/** Aktivität an einem Arbeitspaket vermerken (für die Regel „hängt seit n Tagen“). */
export async function touchTask(db: Db, taskId: string) {
  await db.query(`update tasks set last_activity_at = now() where id = $1`, [taskId]);
}

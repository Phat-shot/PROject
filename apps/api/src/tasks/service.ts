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
    position: r.position
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
  task.checklist = cl.rows.map((c: any) => ({ id: c.id, taskId: c.task_id, title: c.title, done: c.done, responsibleUserId: c.responsible_user_id, position: c.position }));
  return task;
}

/** Vererbung: Aufgabe → Teilprojekt → PL. Konflikte: Deadline nach Teilprojekt-Ende, Start vor Vorgänger-Ende. */
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
    if (pDue && ref && ref < pDue) conflicts.push(`Vorgänger „${p.title}“ endet ${pDue}, Aufgabe beginnt ${ref}`);
  }
  const predIds = typeof r.predecessor_ids === 'string' ? JSON.parse(r.predecessor_ids) : r.predecessor_ids ?? [];
  return {
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

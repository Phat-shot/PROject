import { randomBytes } from 'node:crypto';
import type { ResponsibleInfo, Subproject, Task } from '@projekttool/shared';
import type { Db } from '../db.js';
import { badRequest, forbidden } from '../errors.js';
import { canSeeSubproject } from '../rights.js';
import { agentRunActive } from '../ai/agentEvents.js';

/** Zuständige Person eines Arbeitspakets: aktives Mitglied des Projekts; KI-Agenten weist nur die PL zu. */
export async function assertResponsible(db: Db, projectId: string, membership: { role: string }, userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const r = await db.maybeOne(`select u.kind from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.user_id = $2 and u.active`, [projectId, userId]);
  if (!r) throw badRequest('Zuständige Person ist kein aktives Mitglied des Projekts');
  if (r.kind === 'agent' && membership.role !== 'pl') throw forbidden('KI-Agenten weist nur die Projektleitung zu');
}

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
    description: r.description ?? null,
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

/** Arbeitspaket oder Aufgabe anlegen (Position am Ende der Spalte, eigene Antwortadresse); Prüfungen macht der Aufrufer. */
export async function insertTask(db: Db, p: { projectId: string; subprojectId?: string | null; columnId?: string | null; title: string; description?: string | null; priority?: string | null; startDate?: string | null; dueDate?: string | null; responsibleUserId?: string | null; responsibleEmail?: string | null; createdBy: string; parentId?: string | null }): Promise<{ id: string; number: number }> {
  const columnId = p.columnId ?? (await db.one(`select id from board_columns where project_id = $1 order by position limit 1`, [p.projectId])).id;
  const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1 and parent_id is not distinct from $2`, [columnId, p.parentId ?? null]);
  return db.one(
    `insert into tasks (project_id, subproject_id, column_id, title, description, priority, start_date, due_date, responsible_user_id, responsible_email, position, mail_code, created_by, parent_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id, number`,
    [p.projectId, p.subprojectId ?? null, columnId, p.title, p.description ?? null, p.priority ?? 'normal', p.startDate ?? null, p.dueDate ?? null,
      p.responsibleUserId ?? null, p.responsibleEmail ?? null, pos.p, newMailCode(), p.createdBy, p.parentId ?? null]
  );
}

const TASK_SELECT = `
  select t.*, c.is_done, (select name from users where id = t.requested_by) as requested_by_name,
    ru.name as responsible_name, ru.email as responsible_user_email, pc.name as responsible_contact_name,
    s.responsible_user_id as sp_responsible_user_id, su.name as sp_responsible_name, su.email as sp_responsible_email,
    s.end_date as sp_end_date,
    pt.title as parent_title, pt.number as parent_number,
    pt.responsible_user_id as parent_responsible_user_id, pu.name as parent_responsible_name, pu.email as parent_responsible_user_email,
    pt.responsible_email as parent_responsible_email, ppc.name as parent_responsible_contact_name,
    (select count(*)::int from tasks x join board_columns xc on xc.id = x.column_id where x.parent_id = t.id and x.deleted_at is null and xc.is_done) as subtask_done,
    (select count(*)::int from tasks x where x.parent_id = t.id and x.deleted_at is null) as subtask_total,
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
  left join project_contacts pc on pc.project_id = t.project_id and pc.email = t.responsible_email
  left join subprojects s on s.id = t.subproject_id
  left join users su on su.id = s.responsible_user_id
  left join tasks pt on pt.id = t.parent_id
  left join users pu on pu.id = pt.responsible_user_id
  left join project_contacts ppc on ppc.project_id = pt.project_id and ppc.email = pt.responsible_email`;

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

/** Vererbung: Aufgabe → Arbeitspaket → Teilprojekt → PL. Konflikte: Deadline nach Teilprojekt-Ende, Start vor Vorgänger-Ende. */
export function mapTask(r: any, lead: LeadInfo): Task {
  let responsible: ResponsibleInfo;
  if (r.responsible_user_id) {
    responsible = { userId: r.responsible_user_id, email: r.responsible_user_email, name: r.responsible_name, inherited: false, inheritedFrom: null };
  } else if (r.responsible_email) {
    responsible = { userId: null, email: r.responsible_email, name: r.responsible_contact_name ?? null, inherited: false, inheritedFrom: null };
  } else if (r.parent_responsible_user_id) {
    responsible = { userId: r.parent_responsible_user_id, email: r.parent_responsible_user_email, name: r.parent_responsible_name, inherited: true, inheritedFrom: 'task' };
  } else if (r.parent_responsible_email) {
    responsible = { userId: null, email: r.parent_responsible_email, name: r.parent_responsible_contact_name ?? null, inherited: true, inheritedFrom: 'task' };
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
    deletedAt: r.deleted_at ?? null,
    externalBrief: r.external_brief ?? null,
    agentPaused: Boolean(r.agent_paused),
    agentRunning: agentRunActive(r.id),
    agentWait: r.agent_wait ?? null,
    wait: r.wait_reason ? { reason: r.wait_reason, until: r.wait_until ? new Date(r.wait_until).toISOString() : null, expiredAt: r.wait_expired_at ? new Date(r.wait_expired_at).toISOString() : null } : null,
    agentNextCheckAt: r.agent_next_check_at ? new Date(r.agent_next_check_at).toISOString() : null,
    agentPolicy: r.agent_policy ?? null,
    requestedBy: r.requested_by ? { userId: r.requested_by, name: r.requested_by_name ?? null } : null,
    recurrence: r.recurrence ?? null,
    estimateMinutes: r.estimate_minutes ?? null,
    loggedMinutes: r.logged_minutes ?? 0,
    blocked: Boolean(r.blocked),
    blockedReason: r.blocked_reason ?? null,
    escalationLevel: r.escalation_level ?? 0,
    workflowRunId: r.workflow_run_id ?? null,
    escalatedAt: r.escalated_at ?? null,
    hasDescription: Boolean(r.description && String(r.description).trim()),
    commentCount: r.comment_count ?? 0,
    attachmentCount: r.attachment_count ?? 0,
    mailCount: r.mail_count ?? 0,
    checklistDone: r.checklist_done ?? 0,
    checklistTotal: r.checklist_total ?? 0,
    parentId: r.parent_id ?? null,
    parent: r.parent_id ? { id: r.parent_id, number: r.parent_number ?? 0, title: r.parent_title ?? '' } : null,
    subtaskDone: r.subtask_done ?? 0,
    subtaskTotal: r.subtask_total ?? 0,
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


/** Reiht ein Arbeitspaket in einer Spalte an Position index ein und nummeriert die Spalte neu (nur Geschwister derselben Ebene). */
export async function moveTask(db: Db, taskId: string, columnId: string, index: number | null) {
  const others = await db.query(
    `select id from tasks where column_id = $1 and id <> $2 and archived_at is null and parent_id is not distinct from (select parent_id from tasks where id = $2) order by position, created_at`,
    [columnId, taskId]
  );
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

export type ChainRole = 'requester' | 'parent_responsible' | 'subproject_lead' | 'pl' | 'deputy_pl' | 'escalation_contact';
export interface ChainPerson { id: string; name: string; email: string; why: string; role: ChainRole }

/**
 * Regel C (Grundform): Ansprechpartner eines Arbeitspakets bzw. einer Aufgabe in fester Reihenfolge: Zuständige(r) des
 * Über-AP, Teilprojekt-Verantwortung, verantwortliche PL; nur aktive Personen (keine Agenten, keine Externen) mit Sicht auf
 * das AP, exclude (z. B. der fragende Agent) übersprungen. Stufe 0 ist der erste Eintrag (Ansprechpartner der Agenten,
 * Ziel von refer). Dazu Stellvertretung (mit der PL) und Eskalationskontakt; der Projektkanal ist die Stufe danach (questions.ts).
 * Der Auftraggeber (tasks.requested_by) kommt mit den Aufträgen aus dem Chat hinzu.
 */
export async function contactChain(db: Db, task: { id: string; project_id: string; parent_id: string | null; subproject_id: string | null }, opts: { exclude?: string[] } = {}): Promise<ChainPerson[]> {
  const t = await db.one(`select p.key, pt.number as parent_number, s.name as sp_name, t.requested_by from tasks t join projects p on p.id = t.project_id left join tasks pt on pt.id = t.parent_id left join subprojects s on s.id = t.subproject_id where t.id = $1`, [task.id]);
  // Zuständigkeit des Über-AP wie EFFECTIVE_RESPONSIBLE_SQL für ein Arbeitspaket: direkt, extern (keine Person) oder vom Teilprojekt geerbt
  const parentResp = task.parent_id ? (await db.maybeOne(`select case when pt.responsible_user_id is not null then pt.responsible_user_id when pt.responsible_email is not null then null else s.responsible_user_id end as uid from tasks pt left join subprojects s on s.id = pt.subproject_id where pt.id = $1`, [task.parent_id]))?.uid : null;
  const spResp = task.subproject_id ? (await db.maybeOne(`select responsible_user_id as uid from subprojects where id = $1`, [task.subproject_id]))?.uid : null;
  const plId = (await db.maybeOne(`select user_id from project_members where project_id = $1 and role = 'pl' and not is_deputy`, [task.project_id]))?.user_id;
  // Stellvertretung zusammen mit der PL (menschliche Stellvertreter; Agenten fallen unten heraus), danach der Eskalationskontakt
  const deputies = (await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.role = 'pl' and m.is_deputy and u.kind <> 'agent' order by m.created_at`, [task.project_id])).rows.map((r: any) => r.user_id as string);
  const contactId = (await db.maybeOne(`select escalation->>'contactUserId' as uid from projects where id = $1`, [task.project_id]))?.uid ?? null;
  const out: ChainPerson[] = [];
  const steps: [string | null, string, ChainRole][] = [[t.requested_by ?? null, 'Auftraggeber', 'requester'], [parentResp, `zuständig für ${t.key}-${t.parent_number}`, 'parent_responsible'], [spResp, `verantwortlich für Teilprojekt „${t.sp_name}“`, 'subproject_lead'], [plId, 'Projektleitung', 'pl'], ...deputies.map((d): [string | null, string, ChainRole] => [d, 'stellvertretende Projektleitung', 'deputy_pl']), [contactId, 'Eskalationskontakt', 'escalation_contact']];
  for (const [uid, why, role] of steps) {
    if (!uid || opts.exclude?.includes(uid) || out.some((x) => x.id === uid)) continue;
    const u = await db.maybeOne(`select id, name, email from users where id = $1 and kind <> 'agent' and active`, [uid]);
    if (u && (await canSeeSubproject(db, u.id, task.subproject_id))) out.push({ ...u, why, role });
  }
  return out;
}

import type { Milestone } from '@projekttool/shared';
import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { badRequest } from '../errors.js';
import { dispatch } from '../notify.js';
import { dateStr } from './service.js';

/**
 * Meilensteine mit Status (offen / erreicht) und Bezug zu Arbeitspaketen (milestone_tasks, n:m).
 * Automatik: sind alle verknüpften Arbeitspakete erledigt, schlägt der Meilenstein „erreicht“ vor (Meldung an die PL, die
 * bestätigt) bzw. wird mit der Projekteinstellung „automatisch erreichen“ gleich erreicht. Öffnet sich ein verknüpftes
 * Arbeitspaket wieder, fällt der Vorschlag weg (ein bestätigter Meilenstein bleibt erreicht).
 */

const MS_SELECT = `
  select m.*, u.name as reached_by_name,
    coalesce((select json_agg(mt.task_id) from milestone_tasks mt join tasks t on t.id = mt.task_id where mt.milestone_id = m.id and t.deleted_at is null), '[]'::json) as task_ids,
    (select count(*)::int from milestone_tasks mt join tasks t on t.id = mt.task_id where mt.milestone_id = m.id and t.deleted_at is null) as tasks_total,
    (select count(*)::int from milestone_tasks mt join tasks t on t.id = mt.task_id join board_columns c on c.id = t.column_id where mt.milestone_id = m.id and t.deleted_at is null and c.is_done) as tasks_done
  from milestones m left join users u on u.id = m.reached_by`;

export function mapMilestone(r: any): Milestone {
  const ids = typeof r.task_ids === 'string' ? JSON.parse(r.task_ids) : r.task_ids ?? [];
  return {
    id: r.id, projectId: r.project_id, subprojectId: r.subproject_id, name: r.name, date: dateStr(r.date)!,
    reachedAt: r.reached_at ? new Date(r.reached_at).toISOString() : null,
    reachedBy: r.reached_by ? { userId: r.reached_by, name: r.reached_by_name ?? null } : null,
    reachSuggestedAt: r.reach_suggested_at ? new Date(r.reach_suggested_at).toISOString() : null,
    taskIds: ids, tasksTotal: r.tasks_total ?? ids.length, tasksDone: r.tasks_done ?? 0
  };
}

export async function loadMilestones(db: Db, projectId: string): Promise<Milestone[]> {
  return (await db.query(`${MS_SELECT} where m.project_id = $1 order by m.date, m.name`, [projectId])).rows.map(mapMilestone);
}

export async function loadMilestone(db: Db, id: string): Promise<Milestone | null> {
  const r = await db.maybeOne(`${MS_SELECT} where m.id = $1`, [id]);
  return r ? mapMilestone(r) : null;
}

/** Verknüpfte Arbeitspakete setzen: nur Arbeitspakete (keine Aufgaben) desselben Projekts, nicht im Papierkorb. */
export async function setMilestoneTasks(db: Db, milestoneId: string, projectId: string, taskIds: unknown): Promise<void> {
  if (!Array.isArray(taskIds)) throw badRequest('taskIds: Liste von Arbeitspaketen');
  const ids = [...new Set(taskIds.map(String))];
  const ok = ids.length ? (await db.query(`select id from tasks where id = any($1::uuid[]) and project_id = $2 and parent_id is null and deleted_at is null`, [ids, projectId])).rows.map((r: any) => r.id as string) : [];
  if (ok.length !== ids.length) throw badRequest('Nur Arbeitspakete dieses Projekts lassen sich mit einem Meilenstein verknüpfen');
  await db.query(`delete from milestone_tasks where milestone_id = $1`, [milestoneId]);
  for (const id of ok) await db.query(`insert into milestone_tasks (milestone_id, task_id) values ($1,$2) on conflict do nothing`, [milestoneId, id]);
}

/** Meilensteine eines Arbeitspakets setzen (TaskDrawer, Feld „Meilenstein“). */
export async function setTaskMilestones(db: Db, taskId: string, projectId: string, milestoneIds: unknown): Promise<void> {
  if (!Array.isArray(milestoneIds)) throw badRequest('milestoneIds: Liste von Meilensteinen');
  const t = await db.one(`select parent_id from tasks where id = $1`, [taskId]);
  if (t.parent_id) throw badRequest('Meilensteine hängen an Arbeitspaketen, nicht an Aufgaben');
  const ids = [...new Set(milestoneIds.map(String))];
  const ok = ids.length ? (await db.query(`select id from milestones where id = any($1::uuid[]) and project_id = $2`, [ids, projectId])).rows.map((r: any) => r.id as string) : [];
  if (ok.length !== ids.length) throw badRequest('Meilenstein gehört nicht zum Projekt');
  await db.query(`delete from milestone_tasks where task_id = $1`, [taskId]);
  for (const id of ok) await db.query(`insert into milestone_tasks (milestone_id, task_id) values ($1,$2) on conflict do nothing`, [id, taskId]);
}

export interface MsActor { id: string | null; orgId: string; name?: string }

/** Meilenstein erreicht setzen bzw. wieder öffnen (PL oder „Projektplan ändern“; Automatik ohne Person). */
export async function setReached(db: Db, milestoneId: string, reached: boolean, actor: MsActor, opts: { auto?: boolean } = {}): Promise<void> {
  const m = await db.one(`select * from milestones where id = $1`, [milestoneId]);
  if (reached && m.reached_at) return;
  if (!reached && !m.reached_at && !m.reach_suggested_at) return;
  await db.query(reached
    ? `update milestones set reached_at = now(), reached_by = $2, reach_suggested_at = null where id = $1`
    : `update milestones set reached_at = null, reached_by = null, reach_suggested_at = null where id = $1`, reached ? [milestoneId, actor.id] : [milestoneId]);
  await audit(db, { orgId: actor.orgId, projectId: m.project_id, userId: actor.id, action: reached ? 'milestone.reached' : 'milestone.reopened', objectType: 'milestone', objectId: m.id, details: { name: m.name, ...(opts.auto ? { auto: 'all_tasks_done' } : {}) } });
  // Vorschlag erledigt: Meldungen an die PL schließen
  await db.query(`update notifications set read_at = coalesce(read_at, now()), resolved_at = now() where type = 'milestone.reach' and dedupe_key like $1 and resolved_at is null`, [`ms_reach:${m.id}:%`]);
  if (reached) {
    await dispatch(db, { event: 'progress', projectId: m.project_id, type: 'milestone.reached', title: `Meilenstein erreicht: ${m.name}`, body: opts.auto ? 'Alle verknüpften Arbeitspakete sind erledigt (automatisch).' : actor.name ? `bestätigt von ${actor.name}` : null, link: `/projekte/${m.project_id}/plan?ms=${m.id}`, actorId: actor.id, progress: { milestone: true, done: false } });
  }
}

/**
 * Nach einem Statuswechsel eines Arbeitspakets (oder einer Aufgabe: deren Arbeitspaket): verknüpfte Meilensteine prüfen.
 * Alle erledigt → automatisch erreichen (Projekteinstellung) oder einmal „erreicht?“ bei der PL vorschlagen; nicht mehr alle
 * erledigt → Vorschlag zurückziehen.
 */
export async function syncMilestonesOf(db: Db, taskId: string, actorId: string | null): Promise<void> {
  const rows = (await db.query(
    `select m.id, m.name, m.project_id, m.reached_at, m.reach_suggested_at, p.org_id, p.milestone_auto_reach,
       (select count(*)::int from milestone_tasks x join tasks t on t.id = x.task_id where x.milestone_id = m.id and t.deleted_at is null) as total,
       (select count(*)::int from milestone_tasks x join tasks t on t.id = x.task_id join board_columns c on c.id = t.column_id where x.milestone_id = m.id and t.deleted_at is null and c.is_done) as done
     from milestone_tasks mt join milestones m on m.id = mt.milestone_id join projects p on p.id = m.project_id
     where mt.task_id = (select coalesce(parent_id, id) from tasks where id = $1)`, [taskId])).rows;
  for (const m of rows) {
    if (m.reached_at) continue;
    const all = m.total > 0 && m.done === m.total;
    if (!all) {
      if (m.reach_suggested_at) {
        await db.query(`update milestones set reach_suggested_at = null where id = $1`, [m.id]);
        await db.query(`update notifications set read_at = coalesce(read_at, now()), resolved_at = now() where type = 'milestone.reach' and dedupe_key like $1 and resolved_at is null`, [`ms_reach:${m.id}:%`]);
      }
      continue;
    }
    if (m.milestone_auto_reach) { await setReached(db, m.id, true, { id: actorId, orgId: m.org_id }, { auto: true }); continue; }
    if (m.reach_suggested_at) continue;
    const at = new Date();
    await db.query(`update milestones set reach_suggested_at = $2 where id = $1`, [m.id, at]);
    const pls = (await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.role = 'pl' and u.kind <> 'agent' and u.active`, [m.project_id])).rows.map((r: any) => r.user_id as string);
    await dispatch(db, { event: 'confirm', projectId: m.project_id, users: pls, type: 'milestone.reach', title: `Meilenstein erreicht? ${m.name}`, body: `Alle ${m.total} verknüpften Arbeitspakete sind erledigt. Bitte im Plan bestätigen.`, link: `/projekte/${m.project_id}/plan?ms=${m.id}`, dedupeKey: `ms_reach:${m.id}:${at.toISOString()}`, actorId: null });
  }
}

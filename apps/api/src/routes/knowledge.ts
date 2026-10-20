import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { canSeeSubproject, requireProject, requireTask } from '../rights.js';
import { RELATION_SELECT, decideRelation, mapRelation, projectDigest, runProjectReview } from '../ai/knowledge.js';
import { effectiveAgentPolicy } from '../ai/agentPolicy.js';

/**
 * Projektwissen (Konzept 6.6–6.8): Beziehungen zwischen Arbeitspaketen (TaskDrawer „Verwandte APs“), Entscheidung mit den
 * Rechten der entscheidenden Person, Projektüberblick und der Projektdurchlauf von Hand (PL, nur mit Projektagent und scope project).
 */
export async function knowledgeRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get<{ Params: { id: string } }>('/tasks/:id/relations', async (req) => {
    const user = requireUser(req);
    const { task } = await requireTask(db, user, req.params.id);
    const apId = task.parent_id ?? task.id;
    const rows = await db.query(`${RELATION_SELECT} where (r.task_a = $1 or r.task_b = $1) order by (r.status = 'rejected'), r.created_at desc limit 30`, [apId]);
    const out = [];
    for (const r of rows.rows) {
      const other = await db.one(`select subproject_id from tasks where id = $1`, [r.task_a === apId ? r.task_b : r.task_a]);
      if (await canSeeSubproject(db, user.id, other.subproject_id)) out.push(mapRelation(r, apId));
    }
    return { relations: out };
  });

  // Entscheidung über eine Beziehung (Karte, Chat oder TaskDrawer): sync, dependency, duplicate, independent
  app.post<{ Params: { id: string }; Body: { option?: string; leadTaskId?: string | null; text?: string | null } }>('/relations/:id/decide', async (req) => {
    const user = requireUser(req);
    if (user.kind === 'agent') throw forbidden('Beziehungen entscheiden Personen');
    const rel = await db.maybeOne(`select r.* from task_relations r join projects p on p.id = r.project_id where r.id = $1 and p.org_id = $2`, [req.params.id, user.orgId]);
    if (!rel) throw notFound('Beziehung nicht gefunden');
    await requireProject(db, user, rel.project_id, 'member');
    const option = String(req.body?.option ?? '');
    if (!['sync', 'dependency', 'duplicate', 'independent'].includes(option)) throw badRequest('option: sync, dependency, duplicate oder independent');
    try {
      const res = await decideRelation(db, { relationId: rel.id, option, user: { id: user.id, name: user.name, orgId: user.orgId }, leadTaskId: req.body?.leadTaskId ?? null, text: req.body?.text ?? null });
      const row = await db.one(`${RELATION_SELECT} where r.id = $1`, [rel.id]);
      return { ...res, relation: mapRelation(row, rel.task_a) };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/dürfen|setzt die PL/.test(msg)) throw forbidden(msg);
      throw badRequest(msg);
    }
  });

  // Projektüberblick aus Sicht des Projektagenten (Struktur per Code, Steckbrief vom Projektagenten)
  app.get<{ Params: { id: string } }>('/projects/:id/digest', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'reader');
    const p = await db.one(`select agent_user_id from projects where id = $1`, [req.params.id]);
    if (!p.agent_user_id) return { digest: null };
    const d = await projectDigest(db, { projectId: req.params.id, agentId: p.agent_user_id });
    const row = await db.maybeOne(`select built_at, brief_run_id from project_digests where project_id = $1 and visibility_key = $2`, [req.params.id, d.key]);
    const last = await db.maybeOne(`select created_at, status, error from agent_runs where project_id = $1 and scope = 'project' order by created_at desc limit 1`, [req.params.id]);
    const pol = await effectiveAgentPolicy(db, { agentId: p.agent_user_id, projectId: req.params.id });
    return { digest: { projectId: req.params.id, structure: d.structure, brief: d.brief, builtAt: row?.built_at ?? null, briefRunId: row?.brief_run_id ?? null, lastReview: last ? { at: last.created_at, status: last.status, error: last.error ?? null } : null, scope: pol.scope, reviewAt: pol.reviewAt } };
  });

  // Projektdurchlauf jetzt (PL): auch ohne geänderten Quell-Hash; Budget, Pause und Freigaben gelten weiter
  app.post<{ Params: { id: string } }>('/projects/:id/agent-review', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const p = await db.one(`select agent_user_id from projects where id = $1`, [req.params.id]);
    if (!p.agent_user_id) throw badRequest('Kein Projektagent gesetzt (Mitglieder › Projektagent)');
    const pol = await effectiveAgentPolicy(db, { agentId: p.agent_user_id, projectId: req.params.id });
    if (pol.scope !== 'project') throw badRequest('Reichweite des Projektagenten ist „zugewiesene Arbeitspakete“; Projektdurchlauf braucht „ganzes Projekt“');
    const agent = await db.one(`select id, name, org_id, persona, active from users where id = $1`, [p.agent_user_id]);
    if (!agent.active) throw badRequest('Der Projektagent ist deaktiviert');
    const r = await runProjectReview(db, app.mail, app.fetchFn, agent, req.params.id, { force: true });
    return { run: r };
  });
}

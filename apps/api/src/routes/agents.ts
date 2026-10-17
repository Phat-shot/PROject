import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { runAgentOnTask } from '../ai/agent.js';

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';

/**
 * KI-Agenten verwaltet der Org-Admin (Anlage, Name, Deaktivierung). Ein Agent ist ein Benutzer ohne Login,
 * nie Org-Admin, in Projekten nur Mitglied mit Stellvertretung; Arbeitspakete weist ihm nur die PL zu.
 */
export async function agentRoutes(app: FastifyInstance) {
  const db = app.db;
  const mapAgent = (r: any) => ({ id: r.id, name: r.name, email: r.email, active: r.active, aiProfileId: r.ai_profile_id ?? null, createdAt: r.created_at, projects: r.projects ?? [], runs: r.runs ?? 0, lastRunAt: r.last_run_at ?? null });

  app.get('/agents', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select u.*, coalesce((select json_agg(json_build_object('id', p.id, 'key', p.key, 'name', p.name)) from project_members m join projects p on p.id = m.project_id where m.user_id = u.id and p.status = 'active'), '[]'::json) as projects,
        (select count(*)::int from agent_runs r where r.agent_user_id = u.id) as runs, (select max(created_at) from agent_runs r where r.agent_user_id = u.id) as last_run_at
       from users u where u.org_id = $1 and u.kind = 'agent' order by u.name`, [user.orgId]);
    return { agents: rows.rows.map(mapAgent) };
  });

  app.post<{ Body: { name: string; aiProfileId?: string | null } }>('/agents', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin legt Agenten an');
    const name = req.body?.name?.trim();
    if (!name) throw badRequest('Name erforderlich');
    const email = `${slug(name)}-${randomBytes(3).toString('hex')}@agent.local`;
    const profileId = req.body?.aiProfileId ?? (await db.one(`select settings from orgs where id = $1`, [user.orgId])).settings?.ai?.defaultProfileId ?? null;
    if (profileId && !(await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2`, [profileId, user.orgId]))) throw badRequest('KI-Profil nicht gefunden');
    const r = await db.one(`insert into users (org_id, email, name, password_hash, global_role, kind, ai_profile_id) values ($1,$2,$3,'','user','agent',$4) returning *`, [user.orgId, email, name, profileId]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'agent.create', objectType: 'user', objectId: r.id, details: { name } });
    return { agent: mapAgent(r) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; active?: boolean; aiProfileId?: string | null } }>('/agents/:id', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const a = await db.maybeOne(`select * from users where id = $1 and org_id = $2 and kind = 'agent'`, [req.params.id, user.orgId]);
    if (!a) throw notFound('Agent nicht gefunden');
    const b = req.body ?? {};
    if (b.aiProfileId && !(await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2`, [b.aiProfileId, user.orgId]))) throw badRequest('KI-Profil nicht gefunden');
    await db.query(`update users set name = coalesce($2, name), active = coalesce($3, active), ai_profile_id = case when $4 then $5::uuid else ai_profile_id end where id = $1`, [a.id, b.name?.trim() || null, typeof b.active === 'boolean' ? b.active : null, 'aiProfileId' in b, b.aiProfileId ?? null]);
    if (b.active === false) await db.query(`update tasks set responsible_user_id = null where responsible_user_id = $1 and archived_at is null`, [a.id]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'agent.update', objectType: 'user', objectId: a.id, details: b });
    return { agent: mapAgent(await db.one(`select * from users where id = $1`, [a.id])) };
  });

  // Läufe je Projekt (Mitglieder lesen), je Arbeitspaket
  app.get<{ Params: { id: string }; Querystring: { taskId?: string } }>('/projects/:id/agent-runs', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const rows = await db.query(`select r.*, u.name as agent_name, t.title as task_title, t.number as task_number from agent_runs r join users u on u.id = r.agent_user_id left join tasks t on t.id = r.task_id where r.project_id = $1 and ($2::uuid is null or r.task_id = $2) order by r.created_at desc limit 100`, [req.params.id, req.query.taskId ?? null]);
    return { runs: rows.rows.map((r: any) => ({ id: r.id, agentId: r.agent_user_id, agentName: r.agent_name, taskId: r.task_id, taskTitle: r.task_title, taskNumber: r.task_number, trigger: r.trigger, status: r.status, reasoning: r.reasoning, actions: r.actions ?? [], inputTokens: r.input_tokens, outputTokens: r.output_tokens, error: r.error, createdAt: r.created_at })) };
  });

  // PL: Agent an einem Arbeitspaket pausieren/fortsetzen oder sofort laufen lassen
  app.post<{ Params: { id: string }; Body: { paused: boolean } }>('/tasks/:id/agent-pause', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select * from tasks where id = $1 and deleted_at is null`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id, 'pl');
    await db.query(`update tasks set agent_paused = $2 where id = $1`, [t.id, Boolean(req.body?.paused)]);
    await audit(db, { orgId: user.orgId, projectId: t.project_id, userId: user.id, action: 'agent.pause', objectType: 'task', objectId: t.id, details: { paused: Boolean(req.body?.paused) } });
    return { ok: true, paused: Boolean(req.body?.paused) };
  });
  app.post<{ Params: { id: string } }>('/tasks/:id/agent-run', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select * from tasks where id = $1 and deleted_at is null`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id, 'pl');
    const agent = t.responsible_user_id ? await db.maybeOne(`select id, name, org_id from users where id = $1 and kind = 'agent' and active`, [t.responsible_user_id]) : null;
    if (!agent) throw badRequest('Dem Arbeitspaket ist kein Agent zugewiesen');
    const r = await runAgentOnTask(db, app.mail, app.fetchFn, agent, t.id, 'manual');
    if (r.status === 'error') throw badRequest(r.error ?? 'Lauf fehlgeschlagen');
    if (r.status === 'skipped') throw badRequest(r.error ?? 'Lauf übersprungen');
    return r;
  });
}

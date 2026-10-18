import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { agentForTask, runAgentOnTask } from '../ai/agent.js';

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';

/** Persona: eine Zeile, die den Schreibstil des Agenten beschreibt (Log, Mails, Doku, Chat); Zeilenumbrüche werden zu Leerzeichen. */
const PERSONA_MAX = 300;
function cleanPersona(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (s.length > PERSONA_MAX) throw badRequest(`Persona höchstens ${PERSONA_MAX} Zeichen`);
  return s || null;
}

/** Unterschrift für Mails: frei formulierbar, mehrzeilig (höchstens 8 Zeilen, 500 Zeichen); leer = Standard „Name (KI-Agent, Projekt KEY)“. */
function cleanSignature(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join('\n').trim();
  if (s.length > 500 || s.split('\n').length > 8) throw badRequest('Unterschrift höchstens 8 Zeilen und 500 Zeichen');
  return s || null;
}

/**
 * KI-Agenten verwaltet der Org-Admin (Anlage, Name, Persona, Deaktivierung). Ein Agent ist ein Benutzer ohne Login,
 * nie Org-Admin, in Projekten nur Mitglied mit Stellvertretung; Arbeitspakete weist ihm nur die PL zu.
 */
export async function agentRoutes(app: FastifyInstance) {
  const db = app.db;
  const mapAgent = (r: any) => ({ id: r.id, name: r.name, email: r.email, active: r.active, aiProfileId: r.ai_profile_id ?? null, persona: r.persona ?? null, signature: r.signature ?? null, thinkingMode: r.thinking_mode ?? null, createdAt: r.created_at, projects: r.projects ?? [], runs: r.runs ?? 0, lastRunAt: r.last_run_at ?? null });

  app.get('/agents', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select u.*, coalesce((select json_agg(json_build_object('id', p.id, 'key', p.key, 'name', p.name)) from project_members m join projects p on p.id = m.project_id where m.user_id = u.id and p.status = 'active'), '[]'::json) as projects,
        (select count(*)::int from agent_runs r where r.agent_user_id = u.id) as runs, (select max(created_at) from agent_runs r where r.agent_user_id = u.id) as last_run_at
       from users u where u.org_id = $1 and u.kind = 'agent' order by u.name`, [user.orgId]);
    return { agents: rows.rows.map(mapAgent) };
  });

  app.post<{ Body: { name: string; aiProfileId?: string | null; persona?: string | null } }>('/agents', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin legt Agenten an');
    const name = req.body?.name?.trim();
    if (!name) throw badRequest('Name erforderlich');
    const email = `${slug(name)}-${randomBytes(3).toString('hex')}@agent.local`;
    const profileId = req.body?.aiProfileId ?? (await db.one(`select settings from orgs where id = $1`, [user.orgId])).settings?.ai?.defaultProfileId ?? null;
    if (profileId && !(await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2`, [profileId, user.orgId]))) throw badRequest('KI-Profil nicht gefunden');
    const persona = cleanPersona(req.body?.persona);
    const r = await db.one(`insert into users (org_id, email, name, password_hash, global_role, kind, ai_profile_id, persona) values ($1,$2,$3,'','user','agent',$4,$5) returning *`, [user.orgId, email, name, profileId, persona]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'agent.create', objectType: 'user', objectId: r.id, details: { name, persona } });
    return { agent: mapAgent(r) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; active?: boolean; aiProfileId?: string | null; persona?: string | null; signature?: string | null; thinkingMode?: 'off' | 'on' | null } }>('/agents/:id', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const a = await db.maybeOne(`select * from users where id = $1 and org_id = $2 and kind = 'agent'`, [req.params.id, user.orgId]);
    if (!a) throw notFound('Agent nicht gefunden');
    const b = req.body ?? {};
    if (b.aiProfileId && !(await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2`, [b.aiProfileId, user.orgId]))) throw badRequest('KI-Profil nicht gefunden');
    const persona = 'persona' in b ? cleanPersona(b.persona) : null;
    if ('thinkingMode' in b && b.thinkingMode !== null && b.thinkingMode !== 'off' && b.thinkingMode !== 'on') throw badRequest('Denkmodus: off, on oder null (wie Profil)');
    if ('thinkingMode' in b) await db.query(`update users set thinking_mode = $2 where id = $1`, [a.id, b.thinkingMode ?? null]);
    if ('signature' in b) await db.query(`update users set signature = $2 where id = $1`, [a.id, cleanSignature(b.signature)]);
    await db.query(`update users set name = coalesce($2, name), active = coalesce($3, active), ai_profile_id = case when $4 then $5::uuid else ai_profile_id end, persona = case when $6 then $7 else persona end where id = $1`, [a.id, b.name?.trim() || null, typeof b.active === 'boolean' ? b.active : null, 'aiProfileId' in b, b.aiProfileId ?? null, 'persona' in b, persona]);
    if (b.active === false) await db.query(`update tasks set responsible_user_id = null where responsible_user_id = $1 and archived_at is null`, [a.id]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'agent.update', objectType: 'user', objectId: a.id, details: b });
    return { agent: mapAgent(await db.one(`select * from users where id = $1`, [a.id])) };
  });

  // Läufe je Projekt (Mitglieder lesen), je Arbeitspaket
  app.get<{ Params: { id: string }; Querystring: { taskId?: string } }>('/projects/:id/agent-runs', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const rows = await db.query(`select r.*, u.name as agent_name, t.title as task_title, t.number as task_number from agent_runs r join users u on u.id = r.agent_user_id left join tasks t on t.id = r.task_id where r.project_id = $1 and ($2::uuid is null or r.task_id = $2) order by r.created_at desc limit 100`, [req.params.id, req.query.taskId ?? null]);
    return { runs: rows.rows.map((r: any) => ({ id: r.id, agentId: r.agent_user_id, agentName: r.agent_name, taskId: r.task_id, taskTitle: r.task_title, taskNumber: r.task_number, trigger: r.trigger, status: r.status, reasoning: r.reasoning, actions: r.actions ?? [], proposed: r.proposed ?? null, inputTokens: r.input_tokens, outputTokens: r.output_tokens, error: r.error, createdAt: r.created_at })) };
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
    const agent = await agentForTask(db, t.id);
    if (!agent) throw badRequest('Für das Arbeitspaket ist kein Agent zuständig (direkt oder geerbt)');
    const r = await runAgentOnTask(db, app.mail, app.fetchFn, agent, t.id, 'manual');
    if (r.status === 'skipped') throw badRequest(r.error ?? 'Lauf übersprungen');
    if (r.status === 'error' && !r.actions.length) throw badRequest(r.error ?? 'Lauf fehlgeschlagen');
    return r;
  });
}

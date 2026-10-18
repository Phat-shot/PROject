import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { User } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { hasOrgRight, requireProject } from '../rights.js';
import { orgAiSettings, projectProfiles } from '../ai/client.js';
import { aiAllowed, aiError } from '../ai/policy.js';
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
 * KI-Agenten verwaltet der Org-Admin bzw. die KI-Verwaltung (Anlage, Name, Persona, Deaktivierung). Ein Agent ist ein
 * Benutzer ohne Login, nie Org-Admin, in Projekten nur Mitglied mit Stellvertretung; Arbeitspakete weist ihm nur die PL zu.
 */
export async function agentRoutes(app: FastifyInstance) {
  const db = app.db;
  const mapAgent = (r: any) => ({ id: r.id, name: r.name, email: r.email, active: r.active, aiProfileId: r.ai_profile_id ?? null, persona: r.persona ?? null, signature: r.signature ?? null, thinkingMode: r.thinking_mode ?? null,
    projectBound: r.agent_project_id ? { id: r.agent_project_id, label: r.bound_label ?? '' } : null, dailyBudget: r.agent_daily_budget ?? null, createdAt: r.created_at, projects: r.projects ?? [], runs: r.runs ?? 0, lastRunAt: r.last_run_at ?? null });

  app.get('/agents', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select u.*,
        -- Persönliche Projekte: nur „persönlich (Eigentümer)“, kein Kürzel und kein Name
        coalesce((select json_agg(case when p.personal then json_build_object('id', p.id, 'key', '–', 'name', 'persönlich (' || coalesce(o.name, '?') || ')') else json_build_object('id', p.id, 'key', p.key, 'name', p.name) end)
          from project_members m join projects p on p.id = m.project_id left join users o on o.id = p.created_by where m.user_id = u.id and p.status = 'active'), '[]'::json) as projects,
        (select case when p.personal then 'persönliches Projekt von ' || coalesce(o.name, '?') else p.key || ' ' || p.name end from projects p left join users o on o.id = p.created_by where p.id = u.agent_project_id) as bound_label,
        (select count(*)::int from agent_runs r where r.agent_user_id = u.id) as runs, (select max(created_at) from agent_runs r where r.agent_user_id = u.id) as last_run_at
       from users u where u.org_id = $1 and u.kind = 'agent' order by u.name`, [user.orgId]);
    return { agents: rows.rows.map(mapAgent) };
  });

  app.post<{ Body: { name: string; aiProfileId?: string | null; persona?: string | null } }>('/agents', async (req) => {
    const user = requireUser(req);
    if (!hasOrgRight(user, 'ai_admin')) throw forbidden('Nur Org-Admin oder KI-Verwaltung legt Agenten an');
    const name = req.body?.name?.trim();
    if (!name) throw badRequest('Name erforderlich');
    const email = `${slug(name)}-${randomBytes(3).toString('hex')}@agent.local`;
    const profileId = req.body?.aiProfileId ?? (await db.one(`select settings from orgs where id = $1`, [user.orgId])).settings?.ai?.defaultProfileId ?? null;
    if (profileId && !(await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2 and project_id is null`, [profileId, user.orgId]))) throw badRequest('KI-Profil nicht gefunden');
    const persona = cleanPersona(req.body?.persona);
    const r = await db.one(`insert into users (org_id, email, name, password_hash, global_role, kind, ai_profile_id, persona) values ($1,$2,$3,'','user','agent',$4,$5) returning *`, [user.orgId, email, name, profileId, persona]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'agent.create', objectType: 'user', objectId: r.id, details: { name, persona } });
    return { agent: mapAgent(r) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; active?: boolean; aiProfileId?: string | null; persona?: string | null; signature?: string | null; thinkingMode?: 'off' | 'on' | null } }>('/agents/:id', async (req) => {
    const user = requireUser(req);
    if (!hasOrgRight(user, 'ai_admin')) throw forbidden('Nur Org-Admin oder KI-Verwaltung');
    const a = await db.maybeOne(`select * from users where id = $1 and org_id = $2 and kind = 'agent'`, [req.params.id, user.orgId]);
    if (!a) throw notFound('Agent nicht gefunden');
    const b = req.body ?? {};
    // Agent einer PL: der Org-Admin sieht ihn und kann ihn (de)aktivieren, gestaltet ihn aber nicht
    if (a.agent_project_id && Object.keys(b).some((k) => k !== 'active')) throw forbidden('Dieser Agent gehört zu einem Projekt; Einstellungen macht dessen PL');
    if (b.aiProfileId && !(await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2 and project_id is null`, [b.aiProfileId, user.orgId]))) throw badRequest('KI-Profil nicht gefunden');
    const persona = 'persona' in b ? cleanPersona(b.persona) : null;
    if ('thinkingMode' in b && b.thinkingMode !== null && b.thinkingMode !== 'off' && b.thinkingMode !== 'on') throw badRequest('Denkmodus: off, on oder null (wie Profil)');
    if ('thinkingMode' in b) await db.query(`update users set thinking_mode = $2 where id = $1`, [a.id, b.thinkingMode ?? null]);
    if ('signature' in b) await db.query(`update users set signature = $2 where id = $1`, [a.id, cleanSignature(b.signature)]);
    await db.query(`update users set name = coalesce($2, name), active = coalesce($3, active), ai_profile_id = case when $4 then $5::uuid else ai_profile_id end, persona = case when $6 then $7 else persona end where id = $1`, [a.id, b.name?.trim() || null, typeof b.active === 'boolean' ? b.active : null, 'aiProfileId' in b, b.aiProfileId ?? null, 'persona' in b, persona]);
    if (b.active === false) await db.query(`update tasks set responsible_user_id = null where responsible_user_id = $1 and archived_at is null`, [a.id]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'agent.update', objectType: 'user', objectId: a.id, details: b });
    return { agent: mapAgent(await db.one(`select * from users where id = $1`, [a.id])) };
  });

  // ---- Eigene Agenten der PL: nur für das eigene Projekt, nur freigegebene KI-Profile, Tagesbudget höchstens der Mandantenwert;
  // erlaubt über die KI-Freigaben (pl.agents für die PL im Projekt)
  const boundOf = async (projectId: string, id: string) => db.maybeOne(`select * from users where id = $1 and kind = 'agent' and agent_project_id = $2`, [id, projectId]);
  const checkPolicy = async (user: User, projectId: string, b: { aiProfileId?: string | null; dailyBudget?: number | null }, cur?: any) => {
    const s = await orgAiSettings(db, user.orgId);
    const d = await aiAllowed(db, { userId: user.id, projectId, feature: 'pl.agents' });
    if (!d.allowed) throw forbidden(`Eigene Agenten der PL sind nicht freigegeben: ${d.reason}`);
    // Nur LLMs, die im Projekt verfügbar sind (vom Org-Admin freigegeben oder eigenes LLM des Projekts)
    const available = await projectProfiles(db, projectId);
    const profileId = 'aiProfileId' in b ? b.aiProfileId ?? null : cur?.ai_profile_id ?? available[0]?.id ?? null;
    if (!profileId || !available.some((p) => p.id === profileId)) throw badRequest('Dieses LLM ist im Projekt nicht verfügbar');
    const budget = 'dailyBudget' in b ? (b.dailyBudget == null ? s.plAgents.maxBudget : Number(b.dailyBudget)) : cur?.agent_daily_budget ?? s.plAgents.maxBudget;
    if (!Number.isInteger(budget) || budget < 0 || budget > s.plAgents.maxBudget) throw badRequest(`Tagesbudget 0 bis ${s.plAgents.maxBudget} Läufe`);
    return { profileId, budget, policy: s.plAgents };
  };
  app.get<{ Params: { id: string } }>('/projects/:id/agents', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    const s = await orgAiSettings(db, user.orgId);
    const rows = await db.query(`select u.*, (select count(*)::int from agent_runs r where r.agent_user_id = u.id) as runs, (select max(created_at) from agent_runs r where r.agent_user_id = u.id) as last_run_at from users u where u.agent_project_id = $1 and u.kind = 'agent' order by u.name`, [req.params.id]);
    const profiles = (await projectProfiles(db, req.params.id)).map((p) => ({ id: p.id, name: p.name }));
    const d = m.role === 'pl' ? await aiAllowed(db, { userId: user.id, projectId: req.params.id, feature: 'pl.agents' }) : null;
    return { agents: rows.rows.map((r: any) => ({ ...mapAgent(r), runs: r.runs, lastRunAt: r.last_run_at })), policy: { enabled: Boolean(d?.allowed), maxBudget: s.plAgents.maxBudget, profiles }, canManage: Boolean(d?.allowed), manageReason: d ? (d.allowed ? null : d.reason) : 'Nur die PL' };
  });
  app.post<{ Params: { id: string }; Body: { name: string; persona?: string | null; signature?: string | null; aiProfileId?: string | null; thinkingMode?: 'off' | 'on' | null; dailyBudget?: number | null; role?: 'member' | 'pl'; agentCanMail?: boolean } }>('/projects/:id/agents', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const b = req.body ?? ({} as any);
    const name = String(b.name ?? '').trim().slice(0, 80);
    if (!name) throw badRequest('Name erforderlich');
    const { profileId, budget } = await checkPolicy(user, req.params.id, b);
    if (b.thinkingMode != null && b.thinkingMode !== 'off' && b.thinkingMode !== 'on') throw badRequest('Denkmodus: off, on oder null (wie Profil)');
    const email = `${slug(name)}-${randomBytes(3).toString('hex')}@agent.local`;
    const r = await db.one(`insert into users (org_id, email, name, password_hash, global_role, kind, ai_profile_id, persona, signature, thinking_mode, agent_project_id, agent_daily_budget, agent_created_by) values ($1,$2,$3,'','user','agent',$4,$5,$6,$7,$8,$9,$10) returning *`,
      [user.orgId, email, name, profileId, cleanPersona(b.persona), cleanSignature(b.signature), b.thinkingMode ?? null, req.params.id, budget, user.id]);
    const role = b.role === 'pl' ? 'pl' : 'member';
    await db.query(`insert into project_members (project_id, user_id, role, is_deputy, can_edit_plan, can_approve, can_finalize, can_use_ai, agent_can_mail) values ($1,$2,$3,true,$4,false,false,true,$5)`, [req.params.id, r.id, role, role === 'pl', b.agentCanMail !== false]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'agent.create', objectType: 'user', objectId: r.id, details: { name, projectBound: true, role, dailyBudget: budget } });
    return { agent: mapAgent(r) };
  });
  app.patch<{ Params: { id: string; aid: string }; Body: { name?: string; persona?: string | null; signature?: string | null; aiProfileId?: string | null; thinkingMode?: 'off' | 'on' | null; dailyBudget?: number | null; active?: boolean } }>('/projects/:id/agents/:aid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const a = await boundOf(req.params.id, req.params.aid);
    if (!a) throw notFound('Agent des Projekts nicht gefunden');
    const b = req.body ?? {};
    const { profileId, budget } = await checkPolicy(user, req.params.id, b, a);
    if ('thinkingMode' in b && b.thinkingMode !== null && b.thinkingMode !== 'off' && b.thinkingMode !== 'on') throw badRequest('Denkmodus: off, on oder null (wie Profil)');
    await db.query(`update users set name = coalesce($2, name), persona = case when $3 then $4 else persona end, signature = case when $5 then $6 else signature end, ai_profile_id = $7, thinking_mode = case when $8 then $9 else thinking_mode end, agent_daily_budget = $10, active = coalesce($11, active) where id = $1`,
      [a.id, b.name?.trim().slice(0, 80) || null, 'persona' in b, cleanPersona(b.persona), 'signature' in b, cleanSignature(b.signature), profileId, 'thinkingMode' in b, b.thinkingMode ?? null, budget, typeof b.active === 'boolean' ? b.active : null]);
    if (b.active === false) await db.query(`update tasks set responsible_user_id = null where responsible_user_id = $1 and archived_at is null`, [a.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'agent.update', objectType: 'user', objectId: a.id, details: { ...b, persona: undefined, signature: undefined } });
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
    // Auch der Lauf von Hand beachtet Pause, KI-Freigaben und Tagesbudget
    if (t.agent_paused) throw badRequest('Der Agent ist an diesem Arbeitspaket pausiert. Erst fortsetzen.');
    const d = await aiAllowed(db, { userId: agent.id, projectId: t.project_id, feature: 'agent.run', taskId: t.id });
    if (!d.allowed) throw aiError(d);
    const r = await runAgentOnTask(db, app.mail, app.fetchFn, agent, t.id, 'manual');
    if (r.status === 'skipped') throw badRequest(r.error ?? 'Lauf übersprungen');
    if (r.status === 'error' && !r.actions.length) throw badRequest(r.error ?? 'Lauf fehlgeschlagen');
    return r;
  });
}

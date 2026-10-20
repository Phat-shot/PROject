import type { FastifyInstance } from 'fastify';
import type { AgentActionClass, AgentMode, AgentPolicy } from '@projekttool/shared';
import { effectiveAgentPolicy, MODE_ORDER, parseAgentPolicy } from '../ai/agentPolicy.js';
import { randomBytes } from 'node:crypto';
import type { User } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { hasOrgRight, requireProject, requireTask, visibleSubprojectSql } from '../rights.js';
import { agentUsableIn, orgAiSettings, projectProfiles } from '../ai/client.js';
import { aiAllowed, aiError } from '../ai/policy.js';
import { agentForTask, runAgentOnTask } from '../ai/agent.js';
import { projectLabelSql, SQL } from '../projectPolicy.js';

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
  const mapAgent = (r: any) => ({ id: r.id, name: r.name, email: r.email, active: r.active, aiProfileId: r.ai_profile_id ?? null, profileName: r.profile_name ?? null, persona: r.persona ?? null, signature: r.signature ?? null, thinkingMode: r.thinking_mode ?? null,
    projectBound: r.agent_project_id ? { id: r.agent_project_id, label: r.bound_label ?? '' } : null, scope: r.agent_project_id ? 'project' : r.agent_scope ?? 'all', projectIds: r.scope_project_ids ?? [],
    dailyBudget: r.agent_daily_budget ?? null, createdAt: r.created_at, projects: r.projects ?? [], runs: r.runs ?? 0, lastRunAt: r.last_run_at ?? null });
  /** Einsatz eines Org-Agenten: alle Projekte oder ausgewählte (nur Projekte des Mandanten). */
  const validScope = (v: unknown) => { if (v !== 'all' && v !== 'selected') throw badRequest('Einsatz: all oder selected'); return v; };
  async function setAgentProjects(orgId: string, agentId: string, ids: unknown[]) {
    await db.query(`delete from agent_projects where agent_user_id = $1`, [agentId]);
    for (const id of ids.map(String)) if (await db.maybeOne(`select 1 from projects where id = $1 and org_id = $2`, [id, orgId])) await db.query(`insert into agent_projects (agent_user_id, project_id) values ($1,$2) on conflict do nothing`, [agentId, id]);
  }
  /** Je Projektmitgliedschaft: läuft der Agent dort (Einsatz, LLM verfügbar) oder warum nicht. */
  const withUsable = async (agents: any[]) => {
    for (const a of agents) for (const p of a.projects) { const u = await agentUsableIn(db, a.id, p.id); p.usable = u.ok; p.reason = u.ok ? null : u.reason; }
    return agents;
  };

  app.get('/agents', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select u.*,
        (select a.name from ai_profiles a where a.id = coalesce(u.ai_profile_id, (select (o.settings->'ai'->>'defaultProfileId')::uuid from orgs o where o.id = u.org_id))) as profile_name,
        coalesce((select json_agg(x.project_id) from agent_projects x where x.agent_user_id = u.id), '[]'::json) as scope_project_ids,
        -- Persönliche Projekte: nur „persönlich (Eigentümer)“, kein Kürzel und kein Name
        coalesce((select json_agg(case when ${SQL.isPersonal('p')} then json_build_object('id', p.id, 'key', '–', 'name', ${projectLabelSql('p', 'o')}) else json_build_object('id', p.id, 'key', p.key, 'name', p.name) end)
          from project_members m join projects p on p.id = m.project_id left join users o on o.id = p.created_by where m.user_id = u.id and p.status = 'active'), '[]'::json) as projects,
        (select ${projectLabelSql('p', 'o')} from projects p left join users o on o.id = p.created_by where p.id = u.agent_project_id) as bound_label,
        (select count(*)::int from agent_runs r where r.agent_user_id = u.id) as runs, (select max(created_at) from agent_runs r where r.agent_user_id = u.id) as last_run_at
       from users u where u.org_id = $1 and u.kind = 'agent' order by u.name`, [user.orgId]);
    return { agents: await withUsable(rows.rows.map(mapAgent)) };
  });

  app.post<{ Body: { name: string; aiProfileId?: string | null; persona?: string | null; scope?: 'all' | 'selected'; projectIds?: string[] } }>('/agents', async (req) => {
    const user = requireUser(req);
    if (!hasOrgRight(user, 'ai_admin')) throw forbidden('Nur Org-Admin oder KI-Verwaltung legt Agenten an');
    const name = req.body?.name?.trim();
    if (!name) throw badRequest('Name erforderlich');
    const email = `${slug(name)}-${randomBytes(3).toString('hex')}@agent.local`;
    const profileId = req.body?.aiProfileId ?? (await db.one(`select settings from orgs where id = $1`, [user.orgId])).settings?.ai?.defaultProfileId ?? null;
    if (profileId && !(await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2 and project_id is null`, [profileId, user.orgId]))) throw badRequest('KI-Profil nicht gefunden');
    const persona = cleanPersona(req.body?.persona);
    const scope = validScope(req.body?.scope ?? 'all');
    const r = await db.one(`insert into users (org_id, email, name, password_hash, global_role, kind, ai_profile_id, persona, agent_scope) values ($1,$2,$3,'','user','agent',$4,$5,$6) returning *`, [user.orgId, email, name, profileId, persona, scope]);
    if (Array.isArray(req.body?.projectIds)) await setAgentProjects(user.orgId, r.id, req.body.projectIds);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'agent.create', objectType: 'user', objectId: r.id, details: { name, persona, scope } });
    return { agent: mapAgent(await db.one(`select u.*, coalesce((select json_agg(x.project_id) from agent_projects x where x.agent_user_id = u.id), '[]'::json) as scope_project_ids from users u where u.id = $1`, [r.id])) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; active?: boolean; aiProfileId?: string | null; persona?: string | null; signature?: string | null; thinkingMode?: 'off' | 'on' | null; scope?: 'all' | 'selected'; projectIds?: string[] } }>('/agents/:id', async (req) => {
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
    if (b.scope !== undefined) await db.query(`update users set agent_scope = $2 where id = $1`, [a.id, validScope(b.scope)]);
    if (Array.isArray(b.projectIds)) await setAgentProjects(user.orgId, a.id, b.projectIds);
    await db.query(`update users set name = coalesce($2, name), active = coalesce($3, active), ai_profile_id = case when $4 then $5::uuid else ai_profile_id end, persona = case when $6 then $7 else persona end where id = $1`, [a.id, b.name?.trim() || null, typeof b.active === 'boolean' ? b.active : null, 'aiProfileId' in b, b.aiProfileId ?? null, 'persona' in b, persona]);
    if (b.active === false) await db.query(`update tasks set responsible_user_id = null where responsible_user_id = $1 and archived_at is null`, [a.id]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'agent.update', objectType: 'user', objectId: a.id, details: b });
    // Warnungen: Projekte, in denen der Agent nach der Änderung nicht mehr läuft (Mitgliedschaft bleibt)
    const warnings: string[] = [];
    const rows = await db.query(`select p.id, ${projectLabelSql('p', 'o')} as label from project_members m join projects p on p.id = m.project_id left join users o on o.id = p.created_by where m.user_id = $1 and p.status = 'active' order by p.key`, [a.id]);
    for (const r of rows.rows) { const u = await agentUsableIn(db, a.id, r.id); if (!u.ok) warnings.push(`Läuft in ${r.label} nicht: ${u.reason}`); }
    return { agent: mapAgent(await db.one(`select u.*, coalesce((select json_agg(x.project_id) from agent_projects x where x.agent_user_id = u.id), '[]'::json) as scope_project_ids from users u where u.id = $1`, [a.id])), warnings };
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
    // Agenten der Organisation für den Aufnahme-Dialog: einsetzbar oder Grund (Einsatz, LLM im Projekt), schon Mitglied
    const org = await db.query(`select u.id, u.name, u.persona, (select a.name from ai_profiles a where a.id = coalesce(u.ai_profile_id, (select (o.settings->'ai'->>'defaultProfileId')::uuid from orgs o where o.id = u.org_id))) as profile_name, exists (select 1 from project_members pm where pm.project_id = $2 and pm.user_id = u.id) as member from users u where u.org_id = $1 and u.kind = 'agent' and u.active and u.agent_project_id is null order by u.name`, [user.orgId, req.params.id]);
    const orgAgents = [] as { id: string; name: string; persona: string | null; profileName: string | null; member: boolean; usable: boolean; reason: string | null }[];
    for (const r of org.rows) { const u = await agentUsableIn(db, r.id, req.params.id); orgAgents.push({ id: r.id, name: r.name, persona: r.persona ?? null, profileName: r.profile_name ?? null, member: Boolean(r.member), usable: u.ok, reason: u.ok ? null : u.reason }); }
    // Agenten im Projekt (Mitglieder): Einsetzbarkeit mit Grund
    const members = await db.query(`select u.id, u.name, m.role, m.is_deputy, u.agent_project_id, (select a.name from ai_profiles a where a.id = coalesce(u.ai_profile_id, (select (o.settings->'ai'->>'defaultProfileId')::uuid from orgs o where o.id = u.org_id))) as profile_name from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.kind = 'agent' order by u.name`, [req.params.id]);
    const inProject = [] as { id: string; name: string; role: string; profileName: string | null; own: boolean; usable: boolean; reason: string | null }[];
    for (const r of members.rows) { const u = await agentUsableIn(db, r.id, req.params.id); inProject.push({ id: r.id, name: r.name, role: r.role, profileName: r.profile_name ?? null, own: Boolean(r.agent_project_id), usable: u.ok, reason: u.ok ? null : u.reason }); }
    return { agents: rows.rows.map((r: any) => ({ ...mapAgent(r), runs: r.runs, lastRunAt: r.last_run_at })), orgAgents, inProject, policy: { enabled: Boolean(d?.allowed), maxBudget: s.plAgents.maxBudget, profiles }, canManage: Boolean(d?.allowed), manageReason: d ? (d.allowed ? null : d.reason) : 'Nur die PL' };
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

  // Läufe je Projekt (Mitglieder lesen), je Arbeitspaket; Läufe an Arbeitspaketen eingeschränkter Teilprojekte nur mit Sicht darauf
  app.get<{ Params: { id: string }; Querystring: { taskId?: string } }>('/projects/:id/agent-runs', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    if (req.query.taskId) await requireTask(db, user, req.query.taskId);
    const rows = await db.query(`select r.*, u.name as agent_name, t.title as task_title, t.number as task_number from agent_runs r join users u on u.id = r.agent_user_id left join tasks t on t.id = r.task_id where r.project_id = $1 and ($2::uuid is null or r.task_id = $2) and ${visibleSubprojectSql(3)} order by r.created_at desc limit 100`, [req.params.id, req.query.taskId ?? null, user.id]);
    return { runs: rows.rows.map((r: any) => ({ id: r.id, agentId: r.agent_user_id, agentName: r.agent_name, taskId: r.task_id, taskTitle: r.task_title, taskNumber: r.task_number, trigger: r.trigger, status: r.status, reasoning: r.reasoning, actions: r.actions ?? [], proposed: r.proposed ?? null, inputTokens: r.input_tokens, outputTokens: r.output_tokens, webSearches: r.web_searches ?? 0, scope: r.scope ?? 'task', contextStats: r.context_stats ?? null, cost: r.cost ?? 1, depth: r.context_stats?.depth ?? null, error: r.error, createdAt: r.created_at })) };
  });

  // PL: Agent an einem Arbeitspaket pausieren/fortsetzen oder sofort laufen lassen
  /** Quellen der Online-Recherche am Arbeitspaket (Konzept 8). */
  app.get<{ Params: { id: string } }>('/tasks/:id/web-sources', async (req) => {
    const user = requireUser(req);
    const { task } = await requireTask(db, user, req.params.id);
    const rows = await db.query(`select * from agent_web_sources where task_id = $1 order by retrieved_at desc limit 100`, [task.id]);
    return { sources: rows.rows.map((r: any) => ({ id: r.id, runId: r.run_id, taskId: r.task_id, pageId: r.page_id, query: r.query, url: r.url, title: r.title, citedText: r.cited_text, retrievedAt: r.retrieved_at })) };
  });
  app.post<{ Params: { id: string }; Body: { paused: boolean } }>('/tasks/:id/agent-pause', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select * from tasks where id = $1 and deleted_at is null`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id, 'pl');
    await db.query(`update tasks set agent_paused = $2 where id = $1`, [t.id, Boolean(req.body?.paused)]);
    await audit(db, { orgId: user.orgId, projectId: t.project_id, userId: user.id, action: 'agent.pause', objectType: 'task', objectId: t.id, details: { paused: Boolean(req.body?.paused) } });
    return { ok: true, paused: Boolean(req.body?.paused) };
  });
  /**
   * Selbstständigkeit für ein Arbeitspaket (gilt auch für seine Aufgaben): die PL frei; mit „Projektplan ändern“ nur verschärfen
   * (strenger als die ohne AP wirksame Policy); null = erben.
   */
  app.put<{ Params: { id: string }; Body: { mode?: AgentMode | null; confirm?: AgentActionClass[] | null; depth?: string | null } | null }>('/tasks/:id/agent-policy', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select * from tasks where id = $1 and deleted_at is null`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    const m = await requireProject(db, user, t.project_id, 'member');
    if (m.role !== 'pl' && !m.canEditPlan) throw forbidden('Erfordert die PL oder das Recht „Projektplan ändern“');
    let v: AgentPolicy | null;
    try { v = req.body === null || req.body === undefined || !Object.keys(req.body).length || (req.body.mode === null && !req.body.confirm && !req.body.depth) ? null : parseAgentPolicy(req.body, { limits: false, workflows: false }); } catch (e: any) { throw badRequest(e.message); }
    if (v && !Object.keys(v).length) v = null;
    if (m.role !== 'pl') {
      // Nur verschärfen: mode nicht lascher als ohne AP, confirm nur ergänzen
      const base = await effectiveAgentPolicy(db, { projectId: t.project_id, taskId: null });
      if (!v) throw forbidden('Zurücksetzen auf die Vorgabe darf nur die PL');
      // Denktiefe darf auch „Projektplan ändern“ frei setzen (Konzept KI-Agent 7.1)
      if (v.mode && MODE_ORDER.indexOf(v.mode) < MODE_ORDER.indexOf(base.mode)) throw forbidden(`Mit „Projektplan ändern“ lässt sich die Selbstständigkeit nur verschärfen (Vorgabe: ${base.mode})`);
      if (v.confirm && base.confirm.some((k) => !v!.confirm!.includes(k))) throw forbidden('Bestätigungen lassen sich nur ergänzen, nicht entfernen');
    }
    await db.query(`update tasks set agent_policy = $2::jsonb where id = $1`, [t.id, v ? JSON.stringify(v) : null]);
    await audit(db, { orgId: user.orgId, projectId: t.project_id, userId: user.id, action: 'agent.policy', objectType: 'task', objectId: t.id, details: (v ?? { inherit: true }) as Record<string, unknown> });
    return { policy: v, effective: await effectiveAgentPolicy(db, { agentId: (await agentForTask(db, t.id))?.id ?? null, projectId: t.project_id, taskId: t.id }) };
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
    if (!d.allowed) throw aiError(d, true);
    const r = await runAgentOnTask(db, app.mail, app.fetchFn, agent, t.id, 'manual');
    if (r.status === 'skipped') throw badRequest(r.error ?? 'Lauf übersprungen');
    if (r.status === 'error' && !r.actions.length) throw badRequest(r.error ?? 'Lauf fehlgeschlagen');
    return r;
  });
}

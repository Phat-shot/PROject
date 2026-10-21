import type { FastifyInstance } from 'fastify';
import type { AgentActionClass, AgentMode, AgentPolicy, AiFeature } from '@projekttool/shared';
import { AI_FEATURES, DEFAULT_AGENT_RIGHTS } from '@projekttool/shared';
import { effectiveAgentPolicy, MODE_ORDER, parseAgentPolicy } from '../ai/agentPolicy.js';
import { randomBytes } from 'node:crypto';
import type { User } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { hasOrgRight, requireProject, requireTask, visibleSubprojectSql } from '../rights.js';
import { agentUsableIn, orgAiSettings } from '../ai/client.js';
import { aiAllowed, aiError, ownLlmAllowed, rightsOf } from '../ai/policy.js';
import { agentForTask, runAgentOnTask } from '../ai/agent.js';
import { agentRunActive, queueAgentRun } from '../ai/agentEvents.js';
import { projectLabelSql, SQL } from '../projectPolicy.js';
import { clearRating, myRatings, recordFeedback } from '../ai/feedback.js';

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
 * KI-Agenten: Ein Agent ist ein Benutzer ohne Login und gehört zu genau einem LLM. Wer das LLM verwaltet, legt ihn an, gestaltet
 * ihn und legt fest, was er darf (Rechte, Obergrenze der Selbstständigkeit, Budget, Einsatz): beim LLM des Mandanten die
 * KI-Verwaltung (Org-Admin, ai_admin), beim eigenen LLM eines Projekts dessen PL. Ins Projekt kommt ein Agent per Einladung der
 * PL; dort schränkt sie nur weiter ein (projects.ts). Deaktivieren darf zusätzlich immer die KI-Verwaltung.
 */
export async function agentRoutes(app: FastifyInstance) {
  const db = app.db;
  const mapAgent = (r: any, canManage = false) => ({ id: r.id, name: r.name, email: r.email, active: r.active, aiProfileId: r.ai_profile_id ?? null, profileName: r.profile_name ?? null, profileProjectId: r.profile_project_id ?? null, persona: r.persona ?? null, signature: r.signature ?? null, thinkingMode: r.thinking_mode ?? null,
    projectBound: r.agent_project_id ? { id: r.agent_project_id, label: r.bound_label ?? '' } : null, scope: r.agent_project_id ? 'project' : r.agent_scope ?? 'all', projectIds: r.scope_project_ids ?? [],
    rights: rightsOf(r), policy: (r.agent_policy ?? {}) as AgentPolicy,
    dailyBudget: r.agent_daily_budget ?? null, createdAt: r.created_at, projects: r.projects ?? [], runs: r.runs ?? 0, lastRunAt: r.last_run_at ?? null, canManage });
  const AGENT_SELECT = `select u.*, a.name as profile_name, a.project_id as profile_project_id,
        coalesce((select json_agg(x.project_id) from agent_projects x where x.agent_user_id = u.id), '[]'::json) as scope_project_ids,
        -- Persönliche Projekte: nur „persönlich (Eigentümer)“, kein Kürzel und kein Name
        coalesce((select json_agg(case when ${SQL.isPersonal('p')} then json_build_object('id', p.id, 'key', '–', 'name', ${projectLabelSql('p', 'o')}) else json_build_object('id', p.id, 'key', p.key, 'name', p.name) end)
          from project_members m join projects p on p.id = m.project_id left join users o on o.id = p.created_by where m.user_id = u.id and p.status = 'active'), '[]'::json) as projects,
        (select ${projectLabelSql('p', 'o')} from projects p left join users o on o.id = p.created_by where p.id = u.agent_project_id) as bound_label,
        (select count(*)::int from agent_runs r where r.agent_user_id = u.id) as runs, (select max(created_at) from agent_runs r where r.agent_user_id = u.id) as last_run_at
       from users u left join ai_profiles a on a.id = u.ai_profile_id`;
  /** Einsatz eines Agenten an einem LLM des Mandanten: alle Projekte oder ausgewählte (nur Projekte des Mandanten). */
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
  /** Verwaltet die Person dieses LLM? LLM des Mandanten: KI-Verwaltung; eigenes LLM eines Projekts: dessen PL (solange der Mandant eigene LLMs dort erlaubt). */
  async function canManageProfile(user: User, profile: { project_id: string | null } | null): Promise<boolean> {
    if (!profile) return false;
    if (!profile.project_id) return hasOrgRight(user, 'ai_admin');
    const m = await db.maybeOne(`select role from project_members where project_id = $1 and user_id = $2`, [profile.project_id, user.id]);
    return m?.role === 'pl' && (await ownLlmAllowed(db, user.orgId, profile.project_id));
  }
  const profileOf = async (orgId: string, id: unknown) => (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? db.maybeOne(`select id, name, project_id from ai_profiles where id = $1 and org_id = $2`, [id, orgId]) : null);
  /** Rechte: Liste bekannter Funktionen; Obergrenze: Policy mit Grenzen (maxMode, lockedConfirm, maxDepth). */
  const validRights = (v: unknown): AiFeature[] => { if (!Array.isArray(v)) throw badRequest('Rechte: Liste'); const bad = v.find((f) => !AI_FEATURES.some((d) => d.key === f)); if (bad) throw badRequest(`Unbekanntes Recht ${String(bad)}`); return [...new Set(v as AiFeature[])]; };
  const validPolicy = (v: unknown): AgentPolicy => { try { const p = parseAgentPolicy(v ?? {}, { limits: true, workflows: true }); delete p.chatOrders; delete p.reviewAt; delete p.scope; delete p.synergies; return p; } catch (e: any) { throw badRequest(e.message); } };
  const validBudget = async (orgId: string, v: unknown): Promise<number | null> => {
    if (v === null || v === undefined || v === '') return null;
    const max = (await orgAiSettings(db, orgId)).agentDailyBudget;
    if (!Number.isInteger(v) || Number(v) < 0 || Number(v) > max) throw badRequest(`Tagesbudget: 0 bis ${max} Läufe oder leer (= Mandant)`);
    return Number(v);
  };
  const thinking = (v: unknown) => { if (v !== null && v !== undefined && v !== 'off' && v !== 'on') throw badRequest('Denkmodus: off, on oder null (wie LLM)'); return (v ?? null) as 'off' | 'on' | null; };

  app.get('/agents', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(`${AGENT_SELECT} where u.org_id = $1 and u.kind = 'agent' order by u.name`, [user.orgId]);
    const out = [];
    for (const r of rows.rows) out.push(mapAgent(r, await canManageProfile(user, { project_id: r.profile_project_id ?? null })));
    return { agents: await withUsable(out) };
  });

  app.post<{ Body: { name: string; aiProfileId: string; persona?: string | null; signature?: string | null; thinkingMode?: 'off' | 'on' | null; scope?: 'all' | 'selected'; projectIds?: string[]; dailyBudget?: number | null; rights?: AiFeature[]; policy?: AgentPolicy } }>('/agents', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? ({} as any);
    const name = String(b.name ?? '').trim().slice(0, 80);
    if (!name) throw badRequest('Name erforderlich');
    // Ohne Angabe nur, wenn eindeutig: das einzige LLM des Mandanten, das die Person verwaltet
    const only = b.aiProfileId ? null : hasOrgRight(user, 'ai_admin') ? (await db.query(`select id from ai_profiles where org_id = $1 and project_id is null`, [user.orgId])).rows : [];
    const profile = await profileOf(user.orgId, b.aiProfileId ?? (only?.length === 1 ? only[0].id : null));
    if (!profile) throw badRequest('LLM wählen: ein Agent gehört zu genau einem LLM');
    if (!(await canManageProfile(user, profile))) throw forbidden(profile.project_id ? 'Agenten an einem eigenen LLM legt die PL des Projekts an (wenn der Mandant eigene LLMs erlaubt)' : 'Agenten an LLMs des Mandanten legt die KI-Verwaltung an');
    const rights = b.rights === undefined ? DEFAULT_AGENT_RIGHTS : validRights(b.rights);
    const policy = validPolicy(b.policy);
    const budget = await validBudget(user.orgId, b.dailyBudget);
    const scope = profile.project_id ? 'all' : validScope(b.scope ?? 'all');
    const email = `${slug(name)}-${randomBytes(3).toString('hex')}@agent.local`;
    const r = await db.one(`insert into users (org_id, email, name, password_hash, global_role, kind, ai_profile_id, persona, signature, thinking_mode, agent_scope, agent_project_id, agent_created_by, agent_daily_budget, agent_rights, agent_policy)
      values ($1,$2,$3,'','user','agent',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [user.orgId, email, name, profile.id, cleanPersona(b.persona), cleanSignature(b.signature), thinking(b.thinkingMode), scope, profile.project_id, user.id, budget, rights, JSON.stringify(policy)]);
    if (!profile.project_id && Array.isArray(b.projectIds)) await setAgentProjects(user.orgId, r.id, b.projectIds);
    // Agent am eigenen LLM eines Projekts: dort gleich Mitglied (ein anderes Projekt kann ihn nicht nutzen)
    if (profile.project_id) await db.query(`insert into project_members (project_id, user_id, role, is_deputy, can_edit_plan, can_approve, can_finalize, can_use_ai, agent_can_mail) values ($1,$2,'member',true,false,false,false,true,true) on conflict do nothing`, [profile.project_id, r.id]);
    await audit(db, { orgId: user.orgId, projectId: profile.project_id ?? null, userId: user.id, action: 'agent.create', objectType: 'user', objectId: r.id, details: { name, profile: profile.name, rights, policy, dailyBudget: budget } });
    return { agent: mapAgent(await db.one(`${AGENT_SELECT} where u.id = $1`, [r.id]), true) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; active?: boolean; aiProfileId?: string; persona?: string | null; signature?: string | null; thinkingMode?: 'off' | 'on' | null; scope?: 'all' | 'selected'; projectIds?: string[]; dailyBudget?: number | null; rights?: AiFeature[]; policy?: AgentPolicy } }>('/agents/:id', async (req) => {
    const user = requireUser(req);
    const a = await db.maybeOne(`select u.*, p.project_id as profile_project_id from users u left join ai_profiles p on p.id = u.ai_profile_id where u.id = $1 and u.org_id = $2 and u.kind = 'agent'`, [req.params.id, user.orgId]);
    if (!a) throw notFound('Agent nicht gefunden');
    const b = req.body ?? {};
    const manages = await canManageProfile(user, { project_id: a.profile_project_id ?? a.agent_project_id ?? null });
    // Die KI-Verwaltung darf jeden Agenten (de)aktivieren; alles andere nur, wer sein LLM verwaltet
    const onlyActive = Object.keys(b).every((k) => k === 'active');
    if (!manages && !(onlyActive && hasOrgRight(user, 'ai_admin'))) throw forbidden('Diesen Agenten verwaltet, wer sein LLM verwaltet');
    if (b.aiProfileId !== undefined && b.aiProfileId !== a.ai_profile_id) {
      const np = await profileOf(user.orgId, b.aiProfileId);
      if (!np || !(await canManageProfile(user, np))) throw badRequest('LLM nicht gefunden oder nicht von dir verwaltet');
      if ((np.project_id ?? null) !== (a.agent_project_id ?? null)) throw badRequest('Ein Agent wechselt nur zwischen LLMs derselben Ebene (Mandant bzw. dasselbe Projekt)');
      await db.query(`update users set ai_profile_id = $2 where id = $1`, [a.id, np.id]);
    }
    if ('thinkingMode' in b) await db.query(`update users set thinking_mode = $2 where id = $1`, [a.id, thinking(b.thinkingMode)]);
    if ('signature' in b) await db.query(`update users set signature = $2 where id = $1`, [a.id, cleanSignature(b.signature)]);
    if ('persona' in b) await db.query(`update users set persona = $2 where id = $1`, [a.id, cleanPersona(b.persona)]);
    if ('dailyBudget' in b) await db.query(`update users set agent_daily_budget = $2 where id = $1`, [a.id, await validBudget(user.orgId, b.dailyBudget)]);
    if (b.rights !== undefined) await db.query(`update users set agent_rights = $2 where id = $1`, [a.id, validRights(b.rights)]);
    if (b.policy !== undefined) await db.query(`update users set agent_policy = $2::jsonb where id = $1`, [a.id, JSON.stringify(validPolicy(b.policy))]);
    if (!a.agent_project_id && b.scope !== undefined) await db.query(`update users set agent_scope = $2 where id = $1`, [a.id, validScope(b.scope)]);
    if (!a.agent_project_id && Array.isArray(b.projectIds)) await setAgentProjects(user.orgId, a.id, b.projectIds);
    await db.query(`update users set name = coalesce($2, name), active = coalesce($3, active) where id = $1`, [a.id, b.name?.trim().slice(0, 80) || null, typeof b.active === 'boolean' ? b.active : null]);
    if (b.active === false) await db.query(`update tasks set responsible_user_id = null where responsible_user_id = $1 and archived_at is null`, [a.id]);
    await audit(db, { orgId: user.orgId, projectId: a.agent_project_id ?? null, userId: user.id, action: 'agent.update', objectType: 'user', objectId: a.id, details: { ...b, persona: undefined, signature: undefined } });
    // Warnungen: Projekte, in denen der Agent nach der Änderung nicht mehr läuft (Mitgliedschaft bleibt)
    const warnings: string[] = [];
    const rows = await db.query(`select p.id, ${projectLabelSql('p', 'o')} as label from project_members m join projects p on p.id = m.project_id left join users o on o.id = p.created_by where m.user_id = $1 and p.status = 'active' order by p.key`, [a.id]);
    for (const r of rows.rows) { const u = await agentUsableIn(db, a.id, r.id); if (!u.ok) warnings.push(`Läuft in ${r.label} nicht: ${u.reason}`); }
    return { agent: mapAgent(await db.one(`${AGENT_SELECT} where u.id = $1`, [a.id]), manages), warnings };
  });

  /**
   * Agenten für die Projekteinstellungen: die eingeladenen (Rolle, wirksame Rechte, läuft oder warum nicht) und die einladbaren
   * des Mandanten bzw. vom eigenen LLM des Projekts (einsetzbar oder Grund).
   */
  app.get<{ Params: { id: string } }>('/projects/:id/agents', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const rows = await db.query(`${AGENT_SELECT} where u.org_id = $1 and u.kind = 'agent' and (u.agent_project_id is null or u.agent_project_id = $2) order by u.name`, [user.orgId, req.params.id]);
    const members = new Map((await db.query(`select user_id, role, agent_policy from project_members where project_id = $1`, [req.params.id])).rows.map((r: any) => [r.user_id, r]));
    const inProject = []; const candidates = [];
    for (const r of rows.rows) {
      const u = await agentUsableIn(db, r.id, req.params.id);
      const base = { ...mapAgent(r, await canManageProfile(user, { project_id: r.profile_project_id ?? null })), usable: u.ok, reason: u.ok ? null : u.reason };
      const m = members.get(r.id);
      if (m) inProject.push({ ...base, role: m.role, deny: Array.isArray(m.agent_policy?.deny) ? m.agent_policy.deny : [] });
      else if (r.active) candidates.push(base);
    }
    return { inProject, candidates, budget: (await orgAiSettings(db, user.orgId)).agentDailyBudget };
  });

  /** Lauf eines Agenten bewerten (👍 1, 👎 -1, 0 = zurücknehmen), optional mit Kommentar (KI-Feedback); wer den Lauf sehen darf. */
  app.post<{ Params: { id: string }; Body: { rating: 1 | -1 | 0; comment?: string | null } }>('/agent-runs/:id/rating', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select r.*, t.title as task_title from agent_runs r left join tasks t on t.id = r.task_id where r.id = $1 and r.org_id = $2`, [req.params.id, user.orgId]);
    if (!r || !r.project_id) throw notFound('Lauf nicht gefunden');
    await requireProject(db, user, r.project_id);
    if (r.task_id) await requireTask(db, user, r.task_id);
    const rating = Number(req.body?.rating);
    if (![1, -1, 0].includes(rating)) throw badRequest('rating: 1, -1 oder 0');
    if (rating === 0) { await clearRating(db, user.id, 'agent_run', r.id); return { rating: null }; }
    await recordFeedback(db, { orgId: user.orgId, projectId: r.project_id, agentId: r.agent_user_id, userId: user.id, kind: 'rating', rating: rating as 1 | -1, comment: req.body?.comment ?? null, sourceType: 'agent_run', sourceId: r.id,
      context: { detail: `${r.task_title ? `„${r.task_title}“ · ` : ''}Anlass ${r.trigger}`, output: { note: r.reasoning, actions: r.actions }, reason: r.error } });
    return { rating };
  });

  // Läufe je Projekt (Mitglieder lesen), je Arbeitspaket; Läufe an Arbeitspaketen eingeschränkter Teilprojekte nur mit Sicht darauf
  app.get<{ Params: { id: string }; Querystring: { taskId?: string } }>('/projects/:id/agent-runs', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    if (req.query.taskId) await requireTask(db, user, req.query.taskId);
    const rows = await db.query(`select r.*, u.name as agent_name, t.title as task_title, t.number as task_number from agent_runs r join users u on u.id = r.agent_user_id left join tasks t on t.id = r.task_id where r.project_id = $1 and ($2::uuid is null or r.task_id = $2) and ${visibleSubprojectSql(3)} order by r.created_at desc limit 100`, [req.params.id, req.query.taskId ?? null, user.id]);
    const rated = await myRatings(db, user.id, 'agent_run', rows.rows.map((r: any) => r.id));
    return { runs: rows.rows.map((r: any) => ({ id: r.id, myRating: rated.get(r.id) ?? null, agentId: r.agent_user_id, agentName: r.agent_name, taskId: r.task_id, taskTitle: r.task_title, taskNumber: r.task_number, trigger: r.trigger, status: r.status, reasoning: r.reasoning, actions: r.actions ?? [], proposed: r.proposed ?? null, inputTokens: r.input_tokens, outputTokens: r.output_tokens, webSearches: r.web_searches ?? 0, scope: r.scope ?? 'task', contextStats: r.context_stats ?? null, cost: r.cost ?? 1, depth: r.context_stats?.depth ?? null, error: r.error, createdAt: r.created_at })) };
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
  /** Policy am Arbeitspaket (eigener Wert) und wirksame Policy mit Herkunft für den zuständigen Agenten. */
  app.get<{ Params: { id: string } }>('/tasks/:id/agent-policy', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select id, project_id, agent_policy from tasks where id = $1 and deleted_at is null`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id);
    return { policy: (t.agent_policy ?? null) as AgentPolicy | null, effective: await effectiveAgentPolicy(db, { agentId: (await agentForTask(db, t.id))?.id ?? null, projectId: t.project_id, taskId: t.id }) };
  });
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
  // Lauf von Hand: entkoppelt (202, Ergebnis unter Läufe, im Log und im zentralen KI-Log); ?wait=1 wartet auf das Ergebnis
  app.post<{ Params: { id: string }; Querystring: { wait?: string } }>('/tasks/:id/agent-run', async (req, reply) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select * from tasks where id = $1 and deleted_at is null`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id, 'pl');
    const agent = await agentForTask(db, t.id);
    if (!agent) throw badRequest('Für das Arbeitspaket ist kein Agent zuständig (direkt oder geerbt)');
    // Auch der Lauf von Hand beachtet Pause, Rechte und Tagesbudget
    if (t.agent_paused) throw badRequest('Der Agent ist an diesem Arbeitspaket pausiert. Erst fortsetzen.');
    const d = await aiAllowed(db, { userId: agent.id, projectId: t.project_id, feature: 'agent.run', taskId: t.id });
    if (!d.allowed) throw aiError(d, true);
    if (req.query.wait !== '1') {
      if (agentRunActive(t.id)) return reply.code(202).send({ queued: true, already: true });
      queueAgentRun(t.id, 'manual', agent.id);
      return reply.code(202).send({ queued: true });
    }
    const r = await runAgentOnTask(db, app.mail, app.fetchFn, agent, t.id, 'manual');
    if (r.status === 'skipped') throw badRequest(r.error ?? 'Lauf übersprungen');
    if (r.status === 'error' && !r.actions.length) throw badRequest(r.error ?? 'Lauf fehlgeschlagen');
    return r;
  });
}

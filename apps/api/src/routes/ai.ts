import type { FastifyInstance } from 'fastify';
import { syncTaskBookings } from '../resources/service.js';
import { parseWindow } from '../ai/web.js';
import { decideProposals } from '../ai/agentApproval.js';
import type { AiFeature, AiProposal, User } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { canSeeSubproject, hasOrgRight, requireProject, requireTask, visibleSubprojectSql } from '../rights.js';
import { mailAccess } from '../mail/access.js';
import { loadMailRow } from '../mail/actions.js';
import { linkMailToTask } from '../mail/link.js';
import { aiConfigFor, aiStatus, complete, MODELS, profileWarnings, projectProfiles } from '../ai/client.js';
import { aiError, assistAgent, ownLlmAllowed } from '../ai/policy.js';
import { askProject, essenceForPage, essenceForTask, statusReportDraft, summarizeMail } from '../ai/service.js';
import { loadTask, touchTask } from '../tasks/service.js';
import { htmlToMd, mdToHtml } from '../docs/html.js';
import { mapPage } from '../docs/service.js';
import { notify } from '../notify.js';
import { agentChatMessage } from '../ai/plan.js';
import { seal } from '../secrets.js';
import { PROJECT_LABEL_SQL } from '../projectPolicy.js';
import { recordFeedback } from '../ai/feedback.js';
import { listFeedback, type FeedbackQuery } from '../ai/feedback.js';

function mapProposal(r: any): AiProposal {
  return { id: r.id, projectId: r.project_id, kind: r.kind, mailId: r.mail_id, taskId: r.task_id, pageId: r.page_id, payload: r.payload ?? {}, status: r.status, createdBy: r.created_by, createdByName: r.created_by_name ?? null, decidedBy: r.decided_by, decidedAt: r.decided_at, note: r.note, createdAt: r.created_at, taskTitle: r.task_title ?? null, pageTitle: r.page_title ?? null, mailSubject: r.mail_subject ?? null,
    actionClass: r.action_class ?? null, seq: r.seq ?? 0, questionId: r.question_id ?? null, agentRunId: r.agent_run_id ?? null, result: r.result ?? null };
}

/**
 * KI-Modul (letztes Modul, Regel vor KI): Assistenz auf Knopfdruck, ausgeführt von einem Agenten des Projekts (Projektagent,
 * sonst Auswahl): Zusammenfassen direkt; Essenz in Arbeitspaket oder Seite nur als Vorschlag, den eine Person mit Freigaberecht
 * (oder die PL) anwendet; Statusbericht als Entwurfsseite; Frage ans Projekt mit Quellen. LLMs des Mandanten und die Einstellungen
 * pflegen Org-Admin und KI-Verwaltung (ai_admin), eigene LLMs eines Projekts dessen PL.
 */
export async function aiRoutes(app: FastifyInstance) {
  const db = app.db;
  /**
   * Assistenz im Projekt: Projektzugriff, die Person mit „KI nutzen“ (Leser nur „Frage ans Projekt“), ausgeführt vom gewählten
   * Agenten bzw. dem Projektagenten (Recht am Agenten, Einschränkung im Projekt, LLM, Budget des Agenten).
   */
  const gate = async (user: User, projectId: string, feature: AiFeature, agentId?: string | null) => {
    await requireProject(db, user, projectId, 'reader');
    return assistAgent(db, user, projectId, feature, agentId || null);
  };
  const requireAiAdmin = (user: User) => { if (!hasOrgRight(user, 'ai_admin')) throw forbidden('Nur Org-Admin oder KI-Verwaltung'); };
  const canApprove = async (user: any, projectId: string) => { const m = await requireProject(db, user, projectId, 'member'); if (m.role !== 'pl' && !m.canApprove) throw forbidden('Freigabe nur mit dem Recht „Freigeben“ oder als PL'); return m; };
  /** Vorschlag zu einem Arbeitspaket entscheiden nur mit Sicht auf dessen Teilprojekt (eingeschränkte TPs). */
  const canSeeProposal = async (user: User, p: any) => {
    const t = p.task_id ? await db.maybeOne(`select subproject_id from tasks where id = $1`, [p.task_id]) : null;
    if (t && !(await canSeeSubproject(db, user.id, t.subproject_id))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
  };

  // KI-Feedback (nur KI-Verwaltung): Liste mit Filtern und Export als JSONL oder CSV, um Prompt, KI-Sheet und Agenten zu verbessern
  app.get<{ Querystring: FeedbackQuery }>('/ai/feedback', async (req) => {
    const user = requireUser(req);
    requireAiAdmin(user);
    const items = await listFeedback(db, user.orgId, { ...req.query, limit: Math.min(Number(req.query.limit) || 200, 500) });
    const counts = await db.query(`select kind, count(*)::int as n, count(*) filter (where rating = -1)::int as down, count(*) filter (where rating = 1)::int as up from ai_feedback where org_id = $1 group by kind`, [user.orgId]);
    return { items, counts: counts.rows };
  });
  app.get<{ Querystring: FeedbackQuery & { format?: 'jsonl' | 'csv' } }>('/ai/feedback/export', async (req, reply) => {
    const user = requireUser(req);
    requireAiAdmin(user);
    const items = await listFeedback(db, user.orgId, { ...req.query, limit: 10_000 });
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.feedback_export', objectType: 'org', objectId: user.orgId, details: { format: req.query.format ?? 'jsonl', count: items.length, filter: { kind: req.query.kind, agentId: req.query.agentId, rating: req.query.rating, from: req.query.from, to: req.query.to } } });
    const day = new Date().toISOString().slice(0, 10);
    if (req.query.format === 'csv') {
      const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = items.map((f) => [f.createdAt, f.kind, f.rating ?? '', f.agent?.name ?? '', f.user?.name ?? '', f.project ?? '', f.comment ?? '', JSON.stringify(f.context)].map(q).join(';'));
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="ki-feedback-${day}.csv"`);
      return `\ufeff${['Zeit', 'Art', 'Bewertung', 'Agent', 'Person', 'Projekt', 'Kommentar', 'Kontext'].map(q).join(';')}\n${rows.join('\n')}\n`;
    }
    reply.header('content-type', 'application/x-ndjson; charset=utf-8').header('content-disposition', `attachment; filename="ki-feedback-${day}.jsonl"`);
    return items.map((f) => JSON.stringify(f)).join('\n') + (items.length ? '\n' : '');
  });

  app.get('/ai/status', async (req) => { const user = requireUser(req); return { ...(await aiStatus(db, user.orgId)), models: MODELS }; });

  app.put<{ Body: { enabled?: boolean; agentDailyBudget?: number; ownLlm?: 'off' | 'personal' | 'all'; externalGuard?: 'strict' | 'check'; web?: Record<string, unknown> | null; externalWindow?: Record<string, unknown> | null } }>('/ai/settings', async (req) => {
    const user = requireUser(req);
    requireAiAdmin(user);
    const b = req.body ?? {};
    const cur = (await db.one(`select settings from orgs where id = $1`, [user.orgId])).settings?.ai ?? {};
    // Online-Recherche: Suchdienst für lokale Profile (Schlüssel versiegelt, null löscht ihn), Grenzen, Domains (allowed oder blocked, nicht beides)
    let web: Record<string, unknown> | undefined;
    if (b.web !== undefined) {
      const w: any = b.web ?? {}; const curW: any = cur.web ?? {};
      if (w.provider !== undefined && !['none', 'searxng', 'brave'].includes(w.provider)) throw badRequest('Online-Recherche: provider none, searxng oder brave');
      const dom = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean).slice(0, 50) : undefined);
      const allowed = dom(w.allowedDomains); const blocked = dom(w.blockedDomains);
      if (allowed?.length && blocked?.length) throw badRequest('Online-Recherche: entweder erlaubte oder gesperrte Domains, nicht beides');
      const url = w.url === undefined ? curW.url : w.url ? String(w.url).trim().replace(/\/+$/, '') : null;
      if (url && !/^https?:\/\//.test(url)) throw badRequest('Online-Recherche: Adresse mit http(s)://');
      web = { provider: w.provider ?? curW.provider ?? 'none', url, apiKey: w.apiKey === null ? null : typeof w.apiKey === 'string' && w.apiKey.trim() ? seal(w.apiKey.trim()) : curW.apiKey ?? null,
        maxPerRun: w.maxPerRun !== undefined ? Math.max(1, Math.min(20, Number(w.maxPerRun) || 5)) : curW.maxPerRun ?? 5, dailyPerAgent: w.dailyPerAgent !== undefined ? Math.max(0, Math.min(500, Number(w.dailyPerAgent) || 0)) : curW.dailyPerAgent ?? 20,
        allowedDomains: allowed ?? (blocked?.length ? [] : curW.allowedDomains ?? []), blockedDomains: blocked ?? (allowed?.length ? [] : curW.blockedDomains ?? []) };
    }
    let externalWindow: Record<string, unknown> | undefined;
    if (b.externalWindow !== undefined) {
      const w = parseWindow(b.externalWindow ?? {});
      if (!w) throw badRequest('Arbeitszeitfenster: enabled, days, from, to');
      if (w.from >= w.to) throw badRequest('Arbeitszeitfenster: Beginn vor Ende');
      externalWindow = w as unknown as Record<string, unknown>;
    }
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw badRequest('Notaus: enabled true oder false');
    if (b.ownLlm !== undefined && !['off', 'personal', 'all'].includes(b.ownLlm)) throw badRequest('Eigenes LLM: off, personal oder all');
    if (b.externalGuard !== undefined && !['strict', 'check'].includes(b.externalGuard)) throw badRequest('Außenprüfung: strict oder check');
    const clamp = (v: unknown) => Math.max(0, Math.min(10000, Number(v) || 0));
    await db.query(`update orgs set settings = settings || $2::jsonb where id = $1`, [user.orgId, JSON.stringify({ ai: { ...cur, agentDailyBudget: b.agentDailyBudget != null ? Math.min(1000, clamp(b.agentDailyBudget)) : cur.agentDailyBudget, ...(b.ownLlm ? { ownLlm: b.ownLlm } : {}), ...(b.externalGuard ? { externalGuard: b.externalGuard } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(web !== undefined ? { web } : {}), ...(externalWindow !== undefined ? { externalWindow } : {}) } })]);
    if (web !== undefined || externalWindow !== undefined) await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.settings', objectType: 'org', objectId: user.orgId, details: { web: web ? { ...web, apiKey: undefined, keySet: Boolean(web.apiKey) } : undefined, externalWindow } });
    if (b.enabled !== undefined && b.enabled !== (cur.enabled !== false)) await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.killswitch', objectType: 'org', objectId: user.orgId, details: { enabled: b.enabled } });
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.settings', objectType: 'org', objectId: user.orgId, details: b });
    return aiStatus(db, user.orgId);
  });

  // KI-Profile: Anbieter, Adresse, Modell, Schlüssel (nur schreibend); Org-Admin
  const validProfile = (b: any, cur?: any) => {
    const provider = (b.provider ?? cur?.provider) === 'local' ? 'local' : 'anthropic';
    const model = String(b.model ?? cur?.model ?? (provider === 'anthropic' ? MODELS[0] : '')).trim();
    if (!model || !/^[\w.:\/-]+$/i.test(model)) throw badRequest('Modell erforderlich (Name wie beim Anbieter)');
    const baseUrl = provider === 'local' ? String(b.baseUrl ?? cur?.base_url ?? '').trim().replace(/\/$/, '') : null;
    if (provider === 'local' && !/^https?:\/\//.test(baseUrl ?? '')) throw badRequest('Adresse des lokalen LLM als http(s)://…/v1');
    const name = String(b.name ?? cur?.name ?? '').trim();
    if (!name) throw badRequest('Name erforderlich');
    return { provider, model, baseUrl, name };
  };
  app.get('/ai/profiles', async (req) => { const user = requireUser(req); return { profiles: (await aiStatus(db, user.orgId)).profiles }; });
  const validScope = (v: unknown) => { if (v !== 'all' && v !== 'selected' && v !== 'none') throw badRequest('Freigabe: all, selected oder none'); return v; };
  /** Freigabe für ausgewählte Projekte: nur Projekte des Mandanten. */
  async function setReleasedProjects(orgId: string, profileId: string, ids: unknown[]) {
    await db.query(`delete from ai_profile_projects where profile_id = $1`, [profileId]);
    for (const id of ids.map(String)) if (await db.maybeOne(`select 1 from projects where id = $1 and org_id = $2`, [id, orgId])) await db.query(`insert into ai_profile_projects (profile_id, project_id) values ($1,$2) on conflict do nothing`, [profileId, id]);
  }
  // Org-Admin: Projekte für die Freigabe „ausgewählte Projekte“
  app.get('/ai/release-projects', async (req) => {
    const user = requireUser(req);
    requireAiAdmin(user);
    const r = await db.query(`select p.id, ${PROJECT_LABEL_SQL} as label from projects p left join users ow on ow.id = p.created_by where p.org_id = $1 and p.status = 'active' and p.kind = 'project' order by p.personal, p.key`, [user.orgId]);
    return { projects: r.rows };
  });
  // Org-Admin: eigene LLMs der Projekte mit Metadaten (ohne Schlüssel und Inhalte), sperrbar
  app.get('/ai/project-llms', async (req) => {
    const user = requireUser(req);
    requireAiAdmin(user);
    const r = await db.query(`select a.id, a.name, a.provider, a.model, a.base_url, a.active, a.admin_blocked, a.tokens_in, a.tokens_out, a.last_used_at, a.created_at, ${PROJECT_LABEL_SQL} as project_label, cu.name as created_by_name
      from ai_profiles a join projects p on p.id = a.project_id left join users ow on ow.id = p.created_by left join users cu on cu.id = a.created_by where a.org_id = $1 order by a.created_at`, [user.orgId]);
    return { llms: r.rows.map((x: any) => ({ id: x.id, name: x.name, provider: x.provider, model: x.model, baseUrl: x.base_url, active: x.active, adminBlocked: x.admin_blocked, tokensIn: Number(x.tokens_in), tokensOut: Number(x.tokens_out), lastUsedAt: x.last_used_at, createdAt: x.created_at, project: x.project_label, createdBy: x.created_by_name ?? null })) };
  });

  // ---- Im Projekt verfügbare LLMs; eigenes LLM einbinden und verwalten (PL), wenn der Mandant es für diese Projektart erlaubt
  const ownAllowed = (orgId: string, projectId: string) => ownLlmAllowed(db, orgId, projectId);
  /** Kontextfenster des Modells in Token (leer = Standard 32k); die Eingabe belegt höchstens 45 % (Konzept 6.8) */
  const validContext = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(v); if (!Number.isInteger(n) || n < 4000 || n > 2_000_000) throw badRequest('Kontextgröße: ganze Zahl ab 4000 Token'); return n; };
  const mapOwn = (r: any) => ({ id: r.id, name: r.name, provider: r.provider, model: r.model, baseUrl: r.base_url, hasKey: Boolean(r.api_key), active: r.active, adminBlocked: r.admin_blocked, thinkingOff: Boolean(r.thinking_off), webSearch: Boolean(r.web_search), contextTokens: r.context_tokens ?? null, tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), lastUsedAt: r.last_used_at });
  const ownReason = async (_user: User, projectId: string) => ((await ownAllowed(_user.orgId, projectId)) ? null : 'Eigene LLMs sind für dieses Projekt nicht erlaubt (Verwaltung › KI)');
  app.get<{ Params: { id: string } }>('/projects/:id/llms', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    const own = m.role === 'pl' ? (await db.query(`select * from ai_profiles where project_id = $1 order by created_at`, [req.params.id])).rows.map(mapOwn) : [];
    const reason = m.role === 'pl' ? await ownReason(user, req.params.id) : 'Nur die PL';
    return { available: await projectProfiles(db, req.params.id), own, canAddOwn: !reason, addOwnReason: reason, ownLlmAllowed: m.role === 'pl' && (await ownAllowed(user.orgId, req.params.id)) };
  });
  const ownOf = async (projectId: string, id: string) => { const r = await db.maybeOne(`select * from ai_profiles where id = $1 and project_id = $2`, [id, projectId]); if (!r) throw notFound('LLM des Projekts nicht gefunden'); return r; };
  app.post<{ Params: { id: string }; Body: any }>('/projects/:id/llms', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const reason = await ownReason(user, req.params.id);
    if (reason) throw forbidden(reason);
    const b: any = req.body ?? {};
    const v = validProfile(b);
    const r = await db.one(`insert into ai_profiles (org_id, name, provider, base_url, model, api_key, thinking_off, project_id, project_scope, created_by, web_search) values ($1,$2,$3,$4,$5,$6,$7,$8,'none',$9,$10) returning *`,
      [user.orgId, v.name, v.provider, v.baseUrl, v.model, b.apiKey?.trim() ? seal(b.apiKey.trim()) : null, b.thinkingOff === true, req.params.id, user.id, b.webSearch === true]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'ai.project_llm.create', objectType: 'ai_profile', objectId: r.id, details: { name: v.name, provider: v.provider, model: v.model, baseUrl: v.baseUrl } });
    return { llm: mapOwn(r) };
  });
  app.patch<{ Params: { id: string; lid: string }; Body: any }>('/projects/:id/llms/:lid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const cur = await ownOf(req.params.id, req.params.lid);
    const b: any = req.body ?? {};
    const v = validProfile(b, cur);
    // Ohne Erlaubnis des Mandanten nur einschränken: deaktivieren oder Schlüssel entfernen; jede andere Änderung wie Einbinden
    const changes = v.name !== cur.name || v.provider !== cur.provider || v.baseUrl !== cur.base_url || v.model !== cur.model || Boolean(b.apiKey?.trim?.())
      || (b.active === true && !cur.active) || (typeof b.thinkingOff === 'boolean' && b.thinkingOff !== Boolean(cur.thinking_off)) || (b.webSearch === true && !cur.web_search);
    if (changes) { const reason = await ownReason(user, req.params.id); if (reason) throw forbidden(reason); }
    const key = b.apiKey === null ? null : b.apiKey?.trim() ? seal(b.apiKey.trim()) : cur.api_key;
    await db.query(`update ai_profiles set name = $2, provider = $3, base_url = $4, model = $5, api_key = $6, active = $7, thinking_off = $8, web_search = $9 where id = $1`, [cur.id, v.name, v.provider, v.baseUrl, v.model, key, typeof b.active === 'boolean' ? b.active : cur.active, typeof b.thinkingOff === 'boolean' ? b.thinkingOff : Boolean(cur.thinking_off), typeof b.webSearch === 'boolean' ? b.webSearch : Boolean(cur.web_search)]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'ai.project_llm.update', objectType: 'ai_profile', objectId: cur.id, details: { name: v.name, provider: v.provider, model: v.model, baseUrl: v.baseUrl, active: b.active, keyChanged: b.apiKey !== undefined } });
    return { llm: mapOwn(await db.one(`select * from ai_profiles where id = $1`, [cur.id])) };
  });
  app.delete<{ Params: { id: string; lid: string } }>('/projects/:id/llms/:lid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const cur = await ownOf(req.params.id, req.params.lid);
    if (await db.maybeOne(`select 1 from users where ai_profile_id = $1 and active`, [cur.id])) throw badRequest('Das LLM hat noch aktive Agenten: erst die Agenten deaktivieren');
    await db.query(`update projects set ai_profile_id = null where ai_profile_id = $1`, [cur.id]);
    await db.query(`update users set ai_profile_id = null where ai_profile_id = $1`, [cur.id]);
    await db.query(`delete from ai_profiles where id = $1`, [cur.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'ai.project_llm.delete', objectType: 'ai_profile', objectId: cur.id, details: { name: cur.name } });
    return { ok: true };
  });
  app.post<{ Params: { id: string; lid: string } }>('/projects/:id/llms/:lid/test', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    // Auch der Verbindungstest nur, solange der Mandant eigene LLMs für diese Projektart erlaubt
    if (!(await ownAllowed(user.orgId, req.params.id))) throw forbidden('Eigene LLMs sind für dieses Projekt nicht erlaubt (Verwaltung › KI)');
    const own = await ownOf(req.params.id, req.params.lid);
    const { cfg, decision } = await aiConfigFor(db, { userId: user.id, feature: 'profile.test', profileId: own.id });
    if (!cfg) throw aiError(decision);
    const c = await complete(cfg, app.fetchFn, { system: 'Antworte mit genau einem Wort.', prompt: 'Sag „bereit“.', maxTokens: 20 });
    return { ok: true, model: c.model, reply: c.text };
  });
  app.post<{ Body: any }>('/ai/profiles', async (req) => {
    const user = requireUser(req);
    requireAiAdmin(user);
    const b: any = req.body ?? {};
    const v = validProfile(b);
    const scope = validScope(b.projectScope ?? 'all');
    if (b.personalScope !== undefined && (typeof b.personalScope !== 'boolean' || (b.personalScope && scope !== 'all'))) throw badRequest('„Auch in persönlichen Projekten“ gibt es nur bei „alle Projekte“; bei „ausgewählte“ persönliche Projekte einzeln auswählen');
    const contextTokens = validContext(b.contextTokens);
    const r = await db.one(`insert into ai_profiles (org_id, name, provider, base_url, model, api_key, thinking_off, project_scope, personal_scope, web_search, context_tokens) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [user.orgId, v.name, v.provider, v.baseUrl, v.model, b.apiKey?.trim() ? seal(b.apiKey.trim()) : null, b.thinkingOff === true, scope, b.personalScope === true, b.webSearch === true, contextTokens]);
    if (Array.isArray(b.projectIds)) await setReleasedProjects(user.orgId, r.id, b.projectIds);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.profile.create', objectType: 'ai_profile', objectId: r.id, details: { name: v.name, provider: v.provider, model: v.model, baseUrl: v.baseUrl, thinkingOff: b.thinkingOff === true } });
    return { profile: (await aiStatus(db, user.orgId)).profiles.find((p) => p.id === r.id) };
  });
  app.patch<{ Params: { id: string }; Body: any }>('/ai/profiles/:id', async (req) => {
    const user = requireUser(req);
    requireAiAdmin(user);
    const cur = await db.maybeOne(`select * from ai_profiles where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!cur) throw notFound('Profil nicht gefunden');
    const b: any = req.body ?? {};
    // Eigenes LLM eines Projekts: der Org-Admin sperrt oder entsperrt nur, Inhalt und Schlüssel bleiben beim Projekt
    if (cur.project_id) {
      if (Object.keys(b).some((k) => k !== 'adminBlocked') || typeof b.adminBlocked !== 'boolean') throw forbidden('Eigene LLMs der Projekte kann der Org-Admin nur sperren oder entsperren');
      await db.query(`update ai_profiles set admin_blocked = $2 where id = $1`, [cur.id, b.adminBlocked]);
      await audit(db, { orgId: user.orgId, userId: user.id, action: b.adminBlocked ? 'ai.project_llm.block' : 'ai.project_llm.unblock', objectType: 'ai_profile', objectId: cur.id });
      return { ok: true, adminBlocked: b.adminBlocked, warnings: await profileWarnings(db, user.orgId, cur.id) };
    }
    const v = validProfile(b, cur);
    const scopeNow = b.projectScope !== undefined ? validScope(b.projectScope) : cur.project_scope;
    if (b.personalScope !== undefined && (typeof b.personalScope !== 'boolean' || (b.personalScope && scopeNow !== 'all'))) throw badRequest('„Auch in persönlichen Projekten“ gibt es nur bei „alle Projekte“; bei „ausgewählte“ persönliche Projekte einzeln auswählen');
    if (b.projectScope !== undefined) await db.query(`update ai_profiles set project_scope = $2 where id = $1`, [cur.id, scopeNow]);
    if (b.personalScope !== undefined) await db.query(`update ai_profiles set personal_scope = $2 where id = $1`, [cur.id, b.personalScope]);
    else if (scopeNow !== 'all' && cur.personal_scope) await db.query(`update ai_profiles set personal_scope = false where id = $1`, [cur.id]);
    if (Array.isArray(b.projectIds)) await setReleasedProjects(user.orgId, cur.id, b.projectIds);
    const key = b.apiKey === null ? null : b.apiKey?.trim() ? seal(b.apiKey.trim()) : cur.api_key;
    const thinkingOff = typeof b.thinkingOff === 'boolean' ? b.thinkingOff : Boolean(cur.thinking_off);
    const contextTokens = b.contextTokens === undefined ? cur.context_tokens ?? null : validContext(b.contextTokens);
    await db.query(`update ai_profiles set name = $2, provider = $3, base_url = $4, model = $5, api_key = $6, active = $7, thinking_off = $8, web_search = $9, context_tokens = $10 where id = $1`, [cur.id, v.name, v.provider, v.baseUrl, v.model, key, typeof b.active === 'boolean' ? b.active : cur.active, thinkingOff, typeof b.webSearch === 'boolean' ? b.webSearch : Boolean(cur.web_search), contextTokens]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.profile.update', objectType: 'ai_profile', objectId: cur.id, details: { name: v.name, provider: v.provider, model: v.model, baseUrl: v.baseUrl, active: b.active, thinkingOff, keyChanged: b.apiKey !== undefined } });
    // Warnungen: Agenten mit diesem LLM, die in Projekten nicht mehr laufen (Einsatz enger, deaktiviert)
    return { profile: (await aiStatus(db, user.orgId)).profiles.find((p) => p.id === cur.id), warnings: await profileWarnings(db, user.orgId, cur.id) };
  });
  app.delete<{ Params: { id: string } }>('/ai/profiles/:id', async (req) => {
    const user = requireUser(req);
    requireAiAdmin(user);
    if (await db.maybeOne(`select 1 from users where ai_profile_id = $1 and active`, [req.params.id])) throw badRequest('Das LLM hat noch aktive Agenten: erst die Agenten deaktivieren');
    await db.query(`update users set ai_profile_id = null where ai_profile_id = $1`, [req.params.id]);
    await db.query(`delete from ai_profiles where id = $1 and org_id = $2 and project_id is null`, [req.params.id, user.orgId]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.profile.delete', objectType: 'ai_profile', objectId: req.params.id });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/ai/profiles/:id/test', async (req) => {
    const user = requireUser(req);
    requireAiAdmin(user);
    if (!(await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2 and project_id is null`, [req.params.id, user.orgId]))) throw notFound('Profil nicht gefunden');
    // Verbindungstest: auch er ruft das LLM, der Notaus gilt
    const { cfg, decision } = await aiConfigFor(db, { userId: user.id, feature: 'profile.test', profileId: req.params.id });
    if (!cfg) throw aiError(decision);
    const c = await complete(cfg, app.fetchFn, { system: 'Antworte mit genau einem Wort.', prompt: 'Sag „bereit“.', maxTokens: 20 });
    return { ok: true, model: c.model, reply: c.text };
  });

  // Mail zusammenfassen (direkt, Ergebnis wird an der Mail gespeichert)
  app.post<{ Params: { mid: string }; Body: { agentId?: string | null } }>('/mail/mails/:mid/ai/summarize', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailAccess(db, user, mail.id);
    if (!access.ok) throw forbidden();
    if (!access.rights.canAi) throw forbidden('Kein KI-Recht in dieser Ansicht');
    const pid = access.viewIds.length ? (await db.maybeOne(`select project_id from mail_views where id = $1`, [access.viewIds[0]]))?.project_id ?? null : null;
    if (!pid) throw badRequest('Mail gehört zu keiner Projektansicht');
    // Gleiche Regel wie bei den Vorschlägen: KI-Recht an der Ansicht und Freigabe im Projekt („KI nutzen“)
    const { cfg, agent } = await gate(user, pid, 'assist.summarize', req.body?.agentId);
    const summary = await summarizeMail(db, cfg, app.fetchFn, user, mail, pid);
    await agentChatMessage(db, agent, { userId: user.id }, `Zusammenfassung von „${String(mail.subject ?? '').slice(0, 80)}“:\n${summary}`, pid);
    return { summary, viaChat: agent.name };
  });

  // Essenz → Arbeitspaket (Vorschlag)
  app.post<{ Params: { mid: string }; Body: { taskId: string; agentId?: string | null } }>('/mail/mails/:mid/ai/essence', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailAccess(db, user, mail.id);
    if (!access.ok || !access.rights.canAi) throw forbidden('Kein KI-Recht in dieser Ansicht');
    const task = await db.maybeOne(`select t.*, c.name as column_name from tasks t join board_columns c on c.id = t.column_id where t.id = $1 and t.deleted_at is null`, [req.body?.taskId]);
    if (!task) throw notFound('Arbeitspaket nicht gefunden');
    await requireTask(db, user, task.id);
    const { cfg, agent } = await gate(user, task.project_id, 'assist.essence', req.body?.agentId);
    const cols = await db.query(`select name from board_columns where project_id = $1 order by position`, [task.project_id]);
    const e = await essenceForTask(db, cfg, app.fetchFn, user, mail, { id: task.id, title: task.title, description: task.description, dueDate: task.due_date ? String(task.due_date).slice(0, 10) : null, columnName: task.column_name, projectId: task.project_id }, cols.rows.map((c: any) => c.name));
    const r = await db.one(`insert into ai_proposals (org_id, project_id, kind, mail_id, task_id, payload, created_by) values ($1,$2,'task_update',$3,$4,$5,$6) returning *`, [user.orgId, task.project_id, mail.id, task.id, JSON.stringify({ ...e, agentId: agent.id }), user.id]);
    await audit(db, { orgId: user.orgId, projectId: task.project_id, userId: user.id, action: 'ai.proposal', objectType: 'ai_proposal', objectId: r.id, details: { kind: 'task_update', taskId: task.id, mailId: mail.id } });
    await notifyApprovers(task.project_id, user.id, `KI-Vorschlag: ${task.title}`, e.summary, `/projekte/${task.project_id}/ki`, task.subproject_id);
    await agentChatMessage(db, agent, { userId: user.id }, `Vorschlag zu „${task.title}“ aus der Mail „${String(mail.subject ?? '').slice(0, 80)}“: ${e.summary}\nFreigabe: /projekte/${task.project_id}/ki`, task.project_id);
    return { proposal: mapProposal(r), viaChat: agent.name };
  });

  // Essenz → Seite (Vorschlag)
  app.post<{ Params: { mid: string }; Body: { pageId: string; agentId?: string | null } }>('/mail/mails/:mid/ai/merge-page', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailAccess(db, user, mail.id);
    if (!access.ok || !access.rights.canAi) throw forbidden('Kein KI-Recht in dieser Ansicht');
    const page = await db.maybeOne(`select * from doc_pages where id = $1 and deleted_at is null`, [req.body?.pageId]);
    if (!page) throw notFound('Seite nicht gefunden');
    if (page.status === 'final') throw badRequest('Finale Seite ist gesperrt. Erst wieder öffnen.');
    const { cfg, agent } = await gate(user, page.project_id, 'assist.essence', req.body?.agentId);
    const section = await essenceForPage(db, cfg, app.fetchFn, user, mail, page);
    const r = await db.one(`insert into ai_proposals (org_id, project_id, kind, mail_id, page_id, payload, created_by) values ($1,$2,'page_append',$3,$4,$5,$6) returning *`, [user.orgId, page.project_id, mail.id, page.id, JSON.stringify({ section, agentId: agent.id }), user.id]);
    await audit(db, { orgId: user.orgId, projectId: page.project_id, userId: user.id, action: 'ai.proposal', objectType: 'ai_proposal', objectId: r.id, details: { kind: 'page_append', pageId: page.id, mailId: mail.id } });
    await notifyApprovers(page.project_id, user.id, `KI-Vorschlag für Seite: ${page.title}`, `Aus Mail „${mail.subject}“`, `/projekte/${page.project_id}/ki`);
    await agentChatMessage(db, agent, { userId: user.id }, `Vorschlag für die Seite „${page.title}“ aus der Mail „${String(mail.subject ?? '').slice(0, 80)}“: ${section.slice(0, 200).replace(/\s+/g, ' ')} …\nFreigabe: /projekte/${page.project_id}/ki`, page.project_id);
    return { proposal: mapProposal(r), viaChat: agent.name };
  });

  // Vorschläge zu Arbeitspaketen eingeschränkter Teilprojekte nur mit Sicht darauf
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/projects/:id/ai/proposals', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    const status = req.query.status ?? 'pending';
    const rows = await db.query(
      `select p.*, u.name as created_by_name, t.title as task_title, d.title as page_title, m.subject as mail_subject from ai_proposals p
       left join users u on u.id = p.created_by left join tasks t on t.id = p.task_id left join doc_pages d on d.id = p.page_id left join mails m on m.id = p.mail_id
       where p.project_id = $1 and ($2 = 'all' or p.status = $2) and ${visibleSubprojectSql(3)} order by p.created_at desc limit 100`, [req.params.id, status, user.id]);
    return { proposals: rows.rows.map(mapProposal), canApprove: m.role === 'pl' || m.canApprove };
  });

  // Vorschlag anwenden: Log-Eintrag (Quelle KI), ggf. Status/Termin, Mail verknüpfen; bzw. Abschnitt an Seite anhängen
  app.post<{ Params: { id: string }; Body: { logEntry?: string; section?: string; applyColumn?: boolean; applyDueDate?: boolean } }>('/ai/proposals/:id/approve', async (req) => {
    const user = requireUser(req);
    const p = await db.maybeOne(`select * from ai_proposals where id = $1`, [req.params.id]);
    if (!p) throw notFound('Vorschlag nicht gefunden');
    if (p.status !== 'pending') throw badRequest('Vorschlag ist bereits entschieden');
    if (p.kind === 'agent_action') { const rows = await decideProposals(db, app.mail, app.fetchFn, { ids: [p.id], approve: true, user }); return { ok: true, proposal: rows[0] ? mapProposal(rows[0]) : null }; }
    await canApprove(user, p.project_id);
    await canSeeProposal(user, p);
    const b = req.body ?? {};
    if (p.kind === 'task_update') {
      const task = await db.maybeOne(`select * from tasks where id = $1 and deleted_at is null`, [p.task_id]);
      if (!task) throw notFound('Arbeitspaket nicht mehr vorhanden');
      const pay = p.payload ?? {};
      const changes: string[] = [];
      if (b.applyColumn !== false && pay.columnName) {
        const col = await db.maybeOne(`select id, is_done from board_columns where project_id = $1 and lower(name) = lower($2)`, [p.project_id, pay.columnName]);
        if (col && col.id !== task.column_id) { await db.query(`update tasks set column_id = $2 where id = $1`, [task.id, col.id]); changes.push(`Status → ${pay.columnName}`); }
      }
      if (b.applyDueDate !== false && pay.dueDate && pay.dueDate !== (task.due_date ? String(task.due_date).slice(0, 10) : null)) {
        await db.query(`update tasks set due_date = $2 where id = $1`, [task.id, pay.dueDate]);
        await syncTaskBookings(db, { id: user.id, name: user.name, orgId: user.orgId, kind: 'person' }, task.id);
        changes.push(`Termin → ${pay.dueDate}`);
      }
      const entry = (b.logEntry?.trim() || pay.logEntry || pay.summary || '').trim();
      // Vor dem Übernehmen geändert: Fassung des Agenten und Fassung der Person sichern
      if (b.logEntry?.trim() && b.logEntry.trim() !== String(pay.logEntry ?? '').trim()) await recordFeedback(db, { orgId: user.orgId, projectId: p.project_id, agentId: pay.agentId ?? null, userId: user.id, kind: 'proposal_edited', sourceType: 'ai_proposal', sourceId: p.id, context: { detail: 'Essenz → Arbeitspaket', before: pay.logEntry, after: b.logEntry.trim(), output: pay } });
      const mail = p.mail_id ? await db.maybeOne(`select id, subject, from_addr, date from mails where id = $1`, [p.mail_id]) : null;
      const suffix = mail ? `\n\nQuelle: Mail „${mail.subject}“ von ${mail.from_addr} (${new Date(mail.date).toLocaleDateString('de-DE')})` : '';
      await db.query(`insert into task_comments (task_id, user_id, body, source, mail_id) values ($1,$2,$3,'ai',$4)`, [task.id, user.id, `${entry}${changes.length ? `\n\n${changes.join(', ')}` : ''}${suffix}`, mail?.id ?? null]);
      if (mail) await linkMailToTask(db, { mailId: mail.id, taskId: task.id, linkedBy: user.id, actorId: user.id, logged: true });
      await touchTask(db, task.id);
      await db.query(`update ai_proposals set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [p.id, user.id]);
      await audit(db, { orgId: user.orgId, projectId: p.project_id, userId: user.id, action: 'ai.approve', objectType: 'task', objectId: task.id, details: { proposalId: p.id, changes } });
      return { ok: true, task: await loadTask(db, task.id) };
    }
    const page = await db.maybeOne(`select * from doc_pages where id = $1 and deleted_at is null`, [p.page_id]);
    if (!page) throw notFound('Seite nicht mehr vorhanden');
    if (page.status === 'final') throw badRequest('Finale Seite ist gesperrt. Erst wieder öffnen.');
    const section = (b.section?.trim() || p.payload?.section || '').trim();
    if (b.section?.trim() && b.section.trim() !== String(p.payload?.section ?? '').trim()) await recordFeedback(db, { orgId: user.orgId, projectId: p.project_id, agentId: p.payload?.agentId ?? null, userId: user.id, kind: 'proposal_edited', sourceType: 'ai_proposal', sourceId: p.id, context: { detail: 'Essenz → Seite', before: p.payload?.section, after: b.section.trim() } });
    const html = `${(page.content_html ?? mdToHtml(page.content_md)).replace(/\s+$/, '')}\n${mdToHtml(section)}`;
    const u = await db.one(`update doc_pages set content_html = $2, content_md = $3, version = version + 1, updated_by = $4, updated_at = now() where id = $1 returning *`, [page.id, html, htmlToMd(html), user.id]);
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,$2,$3,$4,$5,$6,$7)`, [u.id, u.version, u.title, u.content_md, u.content_html, u.status, user.id]);
    if (p.mail_id) await db.query(`insert into mail_page_links (mail_id, page_id, kind, linked_by) values ($1,$2,'section',$3) on conflict do nothing`, [p.mail_id, page.id, user.id]);
    await db.query(`update ai_proposals set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [p.id, user.id]);
    await audit(db, { orgId: user.orgId, projectId: p.project_id, userId: user.id, action: 'ai.approve', objectType: 'doc_page', objectId: page.id, details: { proposalId: p.id, version: u.version } });
    return { ok: true, page: mapPage(u) };
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>('/ai/proposals/:id/reject', async (req) => {
    const user = requireUser(req);
    const p = await db.maybeOne(`select * from ai_proposals where id = $1`, [req.params.id]);
    if (!p) throw notFound('Vorschlag nicht gefunden');
    if (p.status !== 'pending') throw badRequest('Vorschlag ist bereits entschieden');
    if (p.kind === 'agent_action') { await decideProposals(db, app.mail, app.fetchFn, { ids: [p.id], approve: false, reason: req.body?.note ?? null, user }); return { ok: true }; }
    await canApprove(user, p.project_id);
    await canSeeProposal(user, p);
    await db.query(`update ai_proposals set status = 'rejected', decided_by = $2, decided_at = now(), note = $3 where id = $1`, [p.id, user.id, req.body?.note?.trim() || null]);
    await audit(db, { orgId: user.orgId, projectId: p.project_id, userId: user.id, action: 'ai.reject', objectType: 'ai_proposal', objectId: p.id, details: { note: req.body?.note } });
    await recordFeedback(db, { orgId: user.orgId, projectId: p.project_id, agentId: p.payload?.agentId ?? null, userId: user.id, kind: 'proposal_rejected', comment: req.body?.note ?? null, sourceType: 'ai_proposal', sourceId: p.id, context: { detail: p.kind === 'page_append' ? 'Essenz → Seite' : 'Essenz → Arbeitspaket', output: p.payload, reason: req.body?.note } });
    return { ok: true };
  });

  // Statusbericht-Entwurf als Seite (Status Entwurf) im Ordner „Berichte“
  app.post<{ Params: { id: string }; Body: { agentId?: string | null } }>('/projects/:id/ai/status-report', async (req) => {
    const user = requireUser(req);
    const { cfg } = await gate(user, req.params.id, 'assist.report', req.body?.agentId);
    const today = new Date().toISOString().slice(0, 10);
    const md = await statusReportDraft(db, cfg, app.fetchFn, user, req.params.id, today);
    const folder = await db.maybeOne(`select id from doc_folders where project_id = $1 and name = 'Berichte'`, [req.params.id]);
    const title = `Statusbericht-Entwurf (KI) ${today}`;
    const html = mdToHtml(md);
    const page = await db.one(`insert into doc_pages (project_id, folder_id, title, content_md, content_html, status, created_by, updated_by) values ($1,$2,$3,$4,$5,'draft',$6,$6) returning *`, [req.params.id, folder?.id ?? null, title, md, html, user.id]);
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,1,$2,$3,$4,'draft',$5)`, [page.id, title, md, html, user.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'ai.status_report', objectType: 'doc_page', objectId: page.id });
    return { page: mapPage(page) };
  });

  app.post<{ Params: { id: string }; Body: { question: string; agentId?: string | null } }>('/projects/:id/ai/ask', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'reader');
    const q = req.body?.question?.trim();
    if (!q || q.length < 3) throw badRequest('Frage erforderlich');
    const { cfg } = await gate(user, req.params.id, 'assist.ask', req.body?.agentId);
    return askProject(db, cfg, app.fetchFn, user, req.params.id, q);
  });

  /** Meldung an PL und Freigebende; bei einem Arbeitspaket im eingeschränkten Teilprojekt nur an die, die es sehen. */
  async function notifyApprovers(projectId: string, byUserId: string, title: string, body: string, link: string, subprojectId: string | null = null) {
    const rows = await db.query(`select user_id from project_members where project_id = $1 and (role = 'pl' or can_approve) and user_id <> $2`, [projectId, byUserId]);
    for (const r of rows.rows) if (await canSeeSubproject(db, r.user_id, subprojectId)) await notify(db, { userId: r.user_id, projectId, type: 'ai.proposal', title, body, link, actorId: byUserId });
  }
}

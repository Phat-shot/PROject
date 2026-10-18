import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { unseal } from '../secrets.js';

/**
 * Modellanbindung je Mandant (Verwaltung › KI): Anthropic über das offizielle SDK oder ein lokales LLM mit
 * OpenAI-kompatibler Schnittstelle (Ollama, vLLM, LM Studio, llama.cpp). Schlüssel liegt verschlüsselt im Mandanten
 * oder kommt aus ANTHROPIC_API_KEY; ohne Modell/Schlüssel sind alle KI-Funktionen aus.
 */
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export type AiProvider = 'anthropic' | 'local';

export interface AiProfileRow { id: string; org_id: string; name: string; provider: AiProvider; base_url: string | null; model: string; api_key: string | null; active: boolean; thinking_off?: boolean; admin_blocked?: boolean; project_id?: string | null; project_scope?: 'all' | 'selected' | 'none' }
/**
 * enableThinking (nur lokal): false = Denkmodus aus, true = ausdrücklich an, undefined = Standard von Modell/Server;
 * gesendet als chat_template_kwargs.enable_thinking (ausgewertet von vLLM und llama.cpp).
 */
export interface AiConfig { profileId: string; name: string; provider: AiProvider; apiKey: string | null; model: string; baseUrl: string | null; enableThinking?: boolean }
export type OwnLlmMode = 'off' | 'personal' | 'all';
export interface AiStatus { enabled: boolean; profiles: { id: string; name: string; provider: AiProvider; model: string; baseUrl: string | null; hasKey: boolean; active: boolean; thinkingOff: boolean; projectScope: 'all' | 'selected' | 'none'; projectIds: string[] }[]; defaultProfileId: string | null; agentDailyBudget: number; plAgents: { enabled: boolean; maxBudget: number }; ownLlm: OwnLlmMode }

/** Konfiguration aus einem Profil; der Anthropic-Schlüssel darf nur bei Profilen des Mandanten aus ANTHROPIC_API_KEY kommen, eigene LLMs eines Projekts brauchen einen eigenen. */
export function profileConfig(r: AiProfileRow | null | undefined): AiConfig | null {
  if (!r || !r.active || r.admin_blocked) return null;
  const apiKey = unseal(r.api_key) || (r.provider === 'anthropic' && !r.project_id ? process.env.ANTHROPIC_API_KEY ?? null : null);
  if (r.provider === 'local' ? !(r.base_url && r.model) : !apiKey) return null;
  return { profileId: r.id, name: r.name, provider: r.provider, apiKey, model: r.model || DEFAULT_MODEL, baseUrl: r.provider === 'local' ? String(r.base_url).replace(/\/$/, '') : null, enableThinking: r.provider === 'local' && r.thinking_off ? false : undefined };
}

/** Eigene Agenten der PL: erlaubt?, höchstes Tagesbudget je Agent (nie über dem Mandantenwert); sie laufen auf den im Projekt verfügbaren LLMs. */
export interface PlAgentPolicy { enabled: boolean; maxBudget: number }
export async function orgAiSettings(db: Db, orgId: string): Promise<{ defaultProfileId: string | null; agentDailyBudget: number; plAgents: PlAgentPolicy; ownLlm: OwnLlmMode }> {
  const o = await db.one(`select settings from orgs where id = $1`, [orgId]);
  const ai = o.settings?.ai ?? {};
  // 0 gilt (keine Läufe); nur ein fehlender oder unlesbarer Wert fällt auf 50 zurück
  const budget = Number(ai.agentDailyBudget ?? 50);
  const agentDailyBudget = Number.isFinite(budget) ? Math.max(0, budget) : 50;
  const pa = ai.plAgents ?? {};
  const ownLlm: OwnLlmMode = ai.ownLlm === 'off' || ai.ownLlm === 'all' ? ai.ownLlm : 'personal';
  return { defaultProfileId: ai.defaultProfileId ?? null, agentDailyBudget, plAgents: { enabled: Boolean(pa.enabled), maxBudget: Math.min(agentDailyBudget, Math.max(0, Number(pa.maxBudget ?? 20) || 0)) }, ownLlm };
}

/**
 * Im Projekt verfügbare LLMs (Aliase a = ai_profiles, p = projects, o = orgs): Profile des Mandanten, die der Org-Admin
 * für alle oder dieses Projekt freigegeben hat, und eigene LLMs des Projekts, soweit der Mandant sie für diese Projektart
 * erlaubt (aus / nur persönliche / alle); gesperrte und inaktive nie.
 */
export const PROJECT_PROFILE_SQL = `a.org_id = p.org_id and a.active and not a.admin_blocked and (
    (a.project_id is null and (a.project_scope = 'all' or (a.project_scope = 'selected' and exists (select 1 from ai_profile_projects x where x.profile_id = a.id and x.project_id = p.id))))
    or (a.project_id = p.id and (case coalesce(o.settings->'ai'->>'ownLlm', 'personal') when 'all' then true when 'personal' then p.personal else false end)))`;

export async function projectProfiles(db: Db, projectId: string): Promise<{ id: string; name: string; provider: AiProvider; model: string; own: boolean }[]> {
  const r = await db.query(`select a.id, a.name, a.provider, a.model, a.project_id from projects p join orgs o on o.id = p.org_id join ai_profiles a on ${PROJECT_PROFILE_SQL} where p.id = $1 order by a.project_id nulls first, a.name`, [projectId]);
  return r.rows.map((x: any) => ({ id: x.id, name: x.name, provider: x.provider, model: x.model, own: Boolean(x.project_id) }));
}
export async function profileAvailableInProject(db: Db, projectId: string, profileId: string): Promise<boolean> {
  return Boolean(await db.maybeOne(`select 1 from projects p join orgs o on o.id = p.org_id join ai_profiles a on ${PROJECT_PROFILE_SQL} where p.id = $1 and a.id = $2`, [projectId, profileId]));
}

/** Verbrauch je Profil (Token, zuletzt genutzt): der Server registriert hier, wohin gezählt wird. */
let usageSink: ((profileId: string, inputTokens: number, outputTokens: number) => Promise<unknown>) | null = null;
export function registerAiUsage(fn: typeof usageSink) { usageSink = fn; }

export async function aiStatus(db: Db, orgId: string): Promise<AiStatus> {
  // Profile des Mandanten (eigene LLMs der Projekte stehen getrennt unter /ai/project-llms)
  const rows = await db.query(`select a.*, coalesce((select json_agg(x.project_id) from ai_profile_projects x where x.profile_id = a.id), '[]'::json) as project_ids from ai_profiles a where a.org_id = $1 and a.project_id is null order by a.created_at`, [orgId]);
  const own = await db.maybeOne(`select 1 from ai_profiles where org_id = $1 and project_id is not null and active and not admin_blocked limit 1`, [orgId]);
  const s = await orgAiSettings(db, orgId);
  const profiles = (rows.rows as any[]).map((r) => ({ id: r.id, name: r.name, provider: r.provider, model: r.model, baseUrl: r.base_url, hasKey: Boolean(unseal(r.api_key) || (r.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY)), active: r.active, thinkingOff: Boolean(r.thinking_off), projectScope: r.project_scope ?? 'all', projectIds: r.project_ids ?? [] }));
  return { enabled: (rows.rows as AiProfileRow[]).some((r) => profileConfig(r)) || Boolean(own), profiles, defaultProfileId: s.defaultProfileId, agentDailyBudget: s.agentDailyBudget, plAgents: s.plAgents, ownLlm: s.ownLlm };
}

/** Projekt-KI: das dem Projekt zugewiesene Profil, solange es dort verfügbar ist (Freigabe, eigenes LLM erlaubt, nicht gesperrt); sonst ist die KI im Projekt aus. */
export async function aiConfigForProject(db: Db, projectId: string): Promise<AiConfig | null> {
  const r = await db.maybeOne<AiProfileRow>(`select a.* from projects p join orgs o on o.id = p.org_id join ai_profiles a on a.id = p.ai_profile_id and ${PROJECT_PROFILE_SQL} where p.id = $1`, [projectId]);
  return profileConfig(r);
}
/**
 * Agent: eigenes Profil, sonst das Standardprofil des Mandanten; der Denkmodus des Agenten (aus/an) überschreibt den des Profils.
 * Agenten der PL laufen nur auf LLMs, die in ihrem Projekt verfügbar sind.
 */
export async function aiConfigForAgent(db: Db, agentUserId: string): Promise<AiConfig | null> {
  const r = await db.maybeOne<AiProfileRow & { agent_thinking: 'off' | 'on' | null; agent_project_id: string | null }>(`select a.*, u.thinking_mode as agent_thinking, u.agent_project_id from users u join ai_profiles a on a.id = coalesce(u.ai_profile_id, (select (o.settings->'ai'->>'defaultProfileId')::uuid from orgs o where o.id = u.org_id)) where u.id = $1`, [agentUserId]);
  if (r?.agent_project_id ? !(await profileAvailableInProject(db, r.agent_project_id, r.id)) : r?.project_id) return null;
  const cfg = profileConfig(r);
  if (cfg && cfg.provider === 'local' && r?.agent_thinking) cfg.enableThinking = r.agent_thinking === 'on';
  return cfg;
}
export async function aiConfigForProfile(db: Db, orgId: string, profileId: string): Promise<AiConfig | null> {
  return profileConfig(await db.maybeOne<AiProfileRow>(`select * from ai_profiles where id = $1 and org_id = $2`, [profileId, orgId]));
}

export interface Completion { text: string; inputTokens: number; outputTokens: number; model: string }
export interface CompleteOpts { system: string; prompt: string; maxTokens?: number; /** JSON-Schema für strukturierte Antwort */ schema?: Record<string, unknown> }

/** Eine Anfrage: Systemanweisung und Nutzertext; mit schema kommt JSON zurück (Anthropic: Structured Outputs, lokal: json_object). */
export async function complete(cfg: AiConfig, fetchFn: typeof fetch, opts: CompleteOpts): Promise<Completion> {
  const r = await (cfg.provider === 'local' ? completeLocal(cfg, fetchFn, opts) : completeAnthropic(cfg, fetchFn, opts));
  if (usageSink) await usageSink(cfg.profileId, r.inputTokens, r.outputTokens).catch(() => undefined);
  return r;
}

async function completeAnthropic(cfg: AiConfig, fetchFn: typeof fetch, opts: CompleteOpts): Promise<Completion> {
  const client = new Anthropic({ apiKey: cfg.apiKey!, fetch: fetchFn as any, maxRetries: 1, timeout: 120_000 });
  try {
    const r = await client.beta.messages.create({
      model: cfg.model, max_tokens: opts.maxTokens ?? 4000, system: opts.system, messages: [{ role: 'user', content: opts.prompt }],
      output_config: { effort: 'low', ...(opts.schema ? { format: { type: 'json_schema', schema: opts.schema as any } } : {}) },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'
    });
    if (r.stop_reason === 'refusal') throw new HttpError(400, `KI hat die Anfrage abgelehnt${r.stop_details && 'category' in r.stop_details && r.stop_details.category ? ` (${r.stop_details.category})` : ''}.`);
    const text = r.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
    return { text, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, model: r.model };
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(400, 'KI-Schlüssel ungültig (401). In der Verwaltung prüfen.');
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'KI-Kontingent erschöpft oder zu viele Anfragen (429). Später erneut versuchen.');
    if (e instanceof Anthropic.APIError) throw new HttpError(400, `KI-Anfrage fehlgeschlagen: ${e.message}`);
    throw new HttpError(400, `KI nicht erreichbar: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

/** OpenAI-kompatibel (/v1/chat/completions): Ollama, vLLM, LM Studio, llama.cpp. */
async function completeLocal(cfg: AiConfig, fetchFn: typeof fetch, opts: CompleteOpts): Promise<Completion> {
  const url = `${cfg.baseUrl}/chat/completions`;
  let r: Response;
  try {
    r = await fetchFn(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, max_tokens: opts.maxTokens ?? 4000, temperature: 0.2, messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.prompt }], ...(opts.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'antwort', schema: opts.schema } } } : {}), ...(cfg.enableThinking !== undefined ? { chat_template_kwargs: { enable_thinking: cfg.enableThinking } } : {}) })
    });
  } catch (e: any) {
    throw new HttpError(400, `Lokales LLM nicht erreichbar (${cfg.baseUrl}): ${String(e?.message ?? e).slice(0, 150)}`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 401 ? 400 : 400, `Lokales LLM: ${j?.error?.message ?? j?.error ?? `HTTP ${r.status}`}`);
  const text = String(j.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new HttpError(400, 'Lokales LLM lieferte keine Antwort');
  return { text, inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0, model: j.model ?? cfg.model };
}

/** JSON aus einer Antwort lesen; Codezäune und Text vor/nach dem Objekt werden ignoriert. */
export function parseJson<T = any>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new HttpError(400, 'KI-Antwort enthielt kein JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

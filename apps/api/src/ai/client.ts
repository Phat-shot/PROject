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

export interface AiProfileRow { id: string; org_id: string; name: string; provider: AiProvider; base_url: string | null; model: string; api_key: string | null; active: boolean; thinking_off?: boolean }
/**
 * enableThinking (nur lokal): false = Denkmodus aus, true = ausdrücklich an, undefined = Standard von Modell/Server;
 * gesendet als chat_template_kwargs.enable_thinking (ausgewertet von vLLM und llama.cpp).
 */
export interface AiConfig { profileId: string; name: string; provider: AiProvider; apiKey: string | null; model: string; baseUrl: string | null; enableThinking?: boolean }
export interface AiStatus { enabled: boolean; profiles: { id: string; name: string; provider: AiProvider; model: string; baseUrl: string | null; hasKey: boolean; active: boolean; thinkingOff: boolean }[]; defaultProfileId: string | null; agentDailyBudget: number }

/** Konfiguration aus einem Profil; Anthropic-Schlüssel darf aus ANTHROPIC_API_KEY kommen. */
export function profileConfig(r: AiProfileRow | null | undefined): AiConfig | null {
  if (!r || !r.active) return null;
  const apiKey = unseal(r.api_key) || (r.provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY ?? null : null);
  if (r.provider === 'local' ? !(r.base_url && r.model) : !apiKey) return null;
  return { profileId: r.id, name: r.name, provider: r.provider, apiKey, model: r.model || DEFAULT_MODEL, baseUrl: r.provider === 'local' ? String(r.base_url).replace(/\/$/, '') : null, enableThinking: r.provider === 'local' && r.thinking_off ? false : undefined };
}

export async function orgAiSettings(db: Db, orgId: string): Promise<{ defaultProfileId: string | null; agentDailyBudget: number }> {
  const o = await db.one(`select settings from orgs where id = $1`, [orgId]);
  const ai = o.settings?.ai ?? {};
  return { defaultProfileId: ai.defaultProfileId ?? null, agentDailyBudget: Number(ai.agentDailyBudget) || 50 };
}

export async function aiStatus(db: Db, orgId: string): Promise<AiStatus> {
  const rows = await db.query(`select * from ai_profiles where org_id = $1 order by created_at`, [orgId]);
  const s = await orgAiSettings(db, orgId);
  const profiles = (rows.rows as AiProfileRow[]).map((r) => ({ id: r.id, name: r.name, provider: r.provider, model: r.model, baseUrl: r.base_url, hasKey: Boolean(unseal(r.api_key) || (r.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY)), active: r.active, thinkingOff: Boolean(r.thinking_off) }));
  return { enabled: (rows.rows as AiProfileRow[]).some((r) => profileConfig(r)), profiles, defaultProfileId: s.defaultProfileId, agentDailyBudget: s.agentDailyBudget };
}

/** Projekt-KI: das dem Projekt zugewiesene Profil; ohne Zuweisung ist die KI im Projekt aus. */
export async function aiConfigForProject(db: Db, projectId: string): Promise<AiConfig | null> {
  const r = await db.maybeOne<AiProfileRow>(`select a.* from projects p join ai_profiles a on a.id = p.ai_profile_id where p.id = $1`, [projectId]);
  return profileConfig(r);
}
/** Agent: eigenes Profil, sonst das Standardprofil des Mandanten; der Denkmodus des Agenten (aus/an) überschreibt den des Profils. */
export async function aiConfigForAgent(db: Db, agentUserId: string): Promise<AiConfig | null> {
  const r = await db.maybeOne<AiProfileRow & { agent_thinking: 'off' | 'on' | null }>(`select a.*, u.thinking_mode as agent_thinking from users u join ai_profiles a on a.id = coalesce(u.ai_profile_id, (select (o.settings->'ai'->>'defaultProfileId')::uuid from orgs o where o.id = u.org_id)) where u.id = $1`, [agentUserId]);
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
  return cfg.provider === 'local' ? completeLocal(cfg, fetchFn, opts) : completeAnthropic(cfg, fetchFn, opts);
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

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

export interface AiConfig { provider: AiProvider; apiKey: string | null; model: string; baseUrl: string | null; source: 'env' | 'org' | null; agentDailyBudget: number }
export interface AiStatus { enabled: boolean; provider: AiProvider; model: string; baseUrl: string | null; hasKey: boolean; source: 'env' | 'org' | null; agentDailyBudget: number }

async function readCfg(db: Db, orgId: string): Promise<AiConfig & { enabledFlag: boolean }> {
  const o = await db.one(`select settings, ai_api_key from orgs where id = $1`, [orgId]);
  const ai = o.settings?.ai ?? {};
  const provider: AiProvider = ai.provider === 'local' ? 'local' : 'anthropic';
  const apiKey = unseal(o.ai_api_key) || (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY ?? null : null);
  const source = o.ai_api_key ? 'org' : apiKey ? 'env' : null;
  return { provider, apiKey, model: ai.model || (provider === 'local' ? '' : DEFAULT_MODEL), baseUrl: provider === 'local' ? String(ai.baseUrl ?? '').replace(/\/$/, '') || null : null, source, agentDailyBudget: Number(ai.agentDailyBudget) || 50, enabledFlag: ai.enabled !== false };
}

export async function aiStatus(db: Db, orgId: string): Promise<AiStatus> {
  const c = await readCfg(db, orgId);
  const ready = c.provider === 'local' ? Boolean(c.baseUrl && c.model) : Boolean(c.apiKey);
  return { enabled: c.enabledFlag && ready, provider: c.provider, model: c.model, baseUrl: c.baseUrl, hasKey: Boolean(c.apiKey), source: c.source, agentDailyBudget: c.agentDailyBudget };
}

export async function aiConfig(db: Db, orgId: string): Promise<AiConfig | null> {
  const c = await readCfg(db, orgId);
  if (!c.enabledFlag) return null;
  if (c.provider === 'local' ? !(c.baseUrl && c.model) : !c.apiKey) return null;
  return c;
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
      body: JSON.stringify({ model: cfg.model, max_tokens: opts.maxTokens ?? 4000, temperature: 0.2, messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.prompt }], ...(opts.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'antwort', schema: opts.schema } } } : {}) })
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

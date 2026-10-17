import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { unseal } from '../secrets.js';

/**
 * Anbindung an die Anthropic Messages API. Der Schlüssel kommt aus der Umgebung (ANTHROPIC_API_KEY) oder aus den
 * Mandanten-Einstellungen (Verwaltung); das Modell ist je Mandant wählbar. Ohne Schlüssel oder bei „aus“ sind alle
 * KI-Funktionen abgeschaltet und die Knöpfe in der Oberfläche inaktiv.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];

export interface AiConfig { apiKey: string; model: string; source: 'env' | 'org' }
export interface AiStatus { enabled: boolean; model: string; hasKey: boolean; source: 'env' | 'org' | null }

export async function aiStatus(db: Db, orgId: string): Promise<AiStatus> {
  const o = await db.one(`select settings, ai_api_key from orgs where id = $1`, [orgId]);
  const ai = o.settings?.ai ?? {};
  const source = o.ai_api_key ? 'org' : process.env.ANTHROPIC_API_KEY ? 'env' : null;
  return { enabled: ai.enabled !== false && source !== null, model: ai.model || DEFAULT_MODEL, hasKey: source !== null, source };
}

export async function aiConfig(db: Db, orgId: string): Promise<AiConfig | null> {
  const o = await db.one(`select settings, ai_api_key from orgs where id = $1`, [orgId]);
  const ai = o.settings?.ai ?? {};
  if (ai.enabled === false) return null;
  const apiKey = unseal(o.ai_api_key) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return { apiKey, model: ai.model || DEFAULT_MODEL, source: o.ai_api_key ? 'org' : 'env' };
}

export interface Completion { text: string; inputTokens: number; outputTokens: number; model: string }

/** Eine Anfrage: Systemanweisung und Nutzertext; Antwort als Text. Fehler werden verständlich gemeldet. */
export async function complete(cfg: AiConfig, fetchFn: typeof fetch, opts: { system: string; prompt: string; maxTokens?: number }): Promise<Completion> {
  const r = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.model, max_tokens: opts.maxTokens ?? 1500, system: opts.system, messages: [{ role: 'user', content: opts.prompt }] })
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message ?? `HTTP ${r.status}`;
    // 4xx, damit die Meldung die Oberfläche erreicht (der Fehler liegt an Schlüssel, Kontingent oder Anfrage, nicht am Server)
    if (r.status === 401) throw new HttpError(400, 'KI-Schlüssel ungültig (401). In der Verwaltung prüfen.');
    if (r.status === 429) throw new HttpError(429, 'KI-Kontingent erschöpft oder zu viele Anfragen (429). Später erneut versuchen.');
    throw new HttpError(400, `KI-Anfrage fehlgeschlagen: ${msg}`);
  }
  const text = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
  return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0, model: j.model ?? cfg.model };
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

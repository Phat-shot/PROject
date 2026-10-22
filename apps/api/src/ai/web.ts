import Anthropic from '@anthropic-ai/sdk';
import type { ExternalWindow } from '@projekttool/shared';
import type { Db } from '../db.js';
import { unseal } from '../secrets.js';
import { isIP } from 'node:net';
import { isPublicAddress, outboundHostError } from '../netGuard.js';
import type { AiConfig } from './client.js';
import { aiAllowed } from './policy.js';

/**
 * Online-Recherche (Konzept 8). Anthropic-Profile: Server-Tool web_search (Zitate kommen als Quellen zurück); lokale Profile:
 * SearXNG oder Brave Search, danach ruft das System die Seiten selbst ab (nur GET, SSRF-Schutz, Größenlimit) und gibt Ausschnitte
 * mit URL weiter. Freigabe: KI-Funktion agent.web (standardmäßig gesperrt), ai_profiles.web_search, Tagesbudget je Agent.
 * Nur lesen: keine Formulare, keine Kontaktaufnahme. Suchbegriffe werden vor dem Senden von Adressen, Telefonnummern und
 * Namen der Projektmitglieder befreit und protokolliert.
 */
export interface WebSettings { provider: 'none' | 'searxng' | 'brave'; url: string | null; apiKey: string | null; maxPerRun: number; dailyPerAgent: number; allowedDomains: string[]; blockedDomains: string[] }
export interface WebSource { url: string; title: string | null; citedText: string | null }
export interface ResearchResult { /** gesendete Suchfrage (gefiltert) */ query: string; text: string; sources: WebSource[]; searches: number; inputTokens: number; outputTokens: number; error?: string }

const num = (v: unknown, def: number, max: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.round(n)) : def; };
const domains = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean).slice(0, 50) : []);

export async function webSettings(db: Db, orgId: string): Promise<WebSettings> {
  const o = await db.one(`select settings->'ai'->'web' as w from orgs where id = $1`, [orgId]);
  const w = o.w ?? {};
  return { provider: w.provider === 'searxng' || w.provider === 'brave' ? w.provider : 'none', url: w.url ? String(w.url).replace(/\/+$/, '') : null, apiKey: unseal(w.apiKey) || null, maxPerRun: num(w.maxPerRun, 5, 20), dailyPerAgent: num(w.dailyPerAgent, 20, 500), allowedDomains: domains(w.allowedDomains), blockedDomains: domains(w.blockedDomains) };
}

/** Darf dieser Agent mit diesem Profil jetzt recherchieren? Begründung für Prompt und Log. */
export async function webAvailable(db: Db, q: { agentId: string; agentName: string; projectId: string; cfg: AiConfig; now?: Date }): Promise<{ ok: true; settings: WebSettings; left: number } | { ok: false; reason: string }> {
  const d = await aiAllowed(db, { userId: q.agentId, projectId: q.projectId, feature: 'agent.web', budget: false, now: q.now });
  if (!d.allowed) return { ok: false, reason: d.publicReason };
  const p = await db.maybeOne(`select web_search, org_id from ai_profiles where id = $1`, [q.cfg.profileId]);
  if (!p?.web_search) return { ok: false, reason: `Profil ${q.cfg.name} ohne Online-Recherche (Verwaltung › KI › LLMs)` };
  const settings = await webSettings(db, p.org_id);
  if (q.cfg.provider === 'local' && settings.provider === 'none') return { ok: false, reason: `kein Suchdienst für lokale Profile (Verwaltung › KI › Online-Recherche: SearXNG oder Brave)` };
  if (q.cfg.provider === 'local' && !settings.url && settings.provider === 'searxng') return { ok: false, reason: 'SearXNG ohne Adresse (Verwaltung › KI › Online-Recherche)' };
  if (q.cfg.provider === 'local' && settings.provider === 'brave' && !settings.apiKey) return { ok: false, reason: 'Brave Search ohne Schlüssel (Verwaltung › KI › Online-Recherche)' };
  const today = (q.now ?? new Date()).toISOString().slice(0, 10);
  const used = (await db.one(`select coalesce(sum(web_searches), 0)::int as n from agent_runs where agent_user_id = $1 and created_at >= $2::date`, [q.agentId, today])).n;
  if (used >= settings.dailyPerAgent) return { ok: false, reason: `Tagesbudget der Recherche für ${q.agentName} erreicht (${settings.dailyPerAgent} Suchen)` };
  return { ok: true, settings, left: settings.dailyPerAgent - used };
}

/** Suchbegriffe ohne Mailadressen, Telefonnummern und Namen der Projektmitglieder (Datenschutz, Konzept 8). */
export function filterQuery(q: string, names: string[]): string {
  let s = String(q ?? '').replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ' ').replace(/(\+?\d[\d\s/().-]{7,}\d)/g, ' ');
  for (const n of names) {
    const parts = n.split(/\s+/).filter((p) => p.length > 2);
    if (parts.length >= 2) s = s.replace(new RegExp(parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gi'), ' ');
    for (const p of parts) if (p.length > 3) s = s.replace(new RegExp(`(?<![\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'giu'), ' ');
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Nur öffentliche HTTP(S)-Ziele: keine Zugangsdaten in der URL, kein localhost, keine privaten oder Link-Local-Adressen (auch IPv4-mapped IPv6). */
export function safeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0') return null;
  if (isIP(h) && !isPublicAddress(h)) return null;
  return u;
}
const domainOk = (u: URL, s: WebSettings) => { const h = u.hostname.toLowerCase(); const hit = (list: string[]) => list.some((d) => h === d || h.endsWith(`.${d}`)); if (s.allowedDomains.length) return hit(s.allowedDomains); if (s.blockedDomains.length) return !hit(s.blockedDomains); return true; };

/** Seite abrufen (nur GET, 10 s, höchstens 200 kB) und als Text kürzen. */
async function fetchExcerpt(fetchFn: typeof fetch, url: URL, maxChars = 1500): Promise<string | null> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetchFn(url.toString(), { method: 'GET', redirect: 'manual', headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.5', 'user-agent': 'Projekttool-Recherche/1.0 (nur lesen)' }, signal: ctrl.signal });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return null;
    const reader = r.body?.getReader(); if (!reader) return null;
    const chunks: Uint8Array[] = []; let size = 0;
    while (size < 200_000) { const { value, done } = await reader.read(); if (done) break; if (value) { chunks.push(value); size += value.length; } }
    await reader.cancel().catch(() => undefined);
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, maxChars) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

interface Hit { url: string; title: string | null; snippet: string | null }
async function searchLocal(fetchFn: typeof fetch, s: WebSettings, query: string): Promise<Hit[]> {
  if (s.provider === 'searxng') {
    const r = await fetchFn(`${s.url}/search?q=${encodeURIComponent(query)}&format=json&language=de`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`SearXNG antwortet mit HTTP ${r.status}`);
    const j: any = await r.json();
    return (Array.isArray(j.results) ? j.results : []).slice(0, 8).map((x: any) => ({ url: String(x.url ?? ''), title: x.title ? String(x.title) : null, snippet: x.content ? String(x.content) : null }));
  }
  const r = await fetchFn(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&country=DE&search_lang=de`, { headers: { accept: 'application/json', 'X-Subscription-Token': s.apiKey ?? '' } });
  if (!r.ok) throw new Error(`Brave Search antwortet mit HTTP ${r.status}`);
  const j: any = await r.json();
  return (j?.web?.results ?? []).slice(0, 8).map((x: any) => ({ url: String(x.url ?? ''), title: x.title ? String(x.title) : null, snippet: x.description ? String(x.description) : null }));
}

/** Tool-Version je Modell (neuere Modelle: web_search_20260209, sonst web_search_20250305). */
export const webSearchToolType = (model: string) => (/(opus|sonnet)-4-[6-9]|(opus|sonnet)-[5-9]|haiku-[5-9]|fable|mythos/i.test(model) ? 'web_search_20260209' : 'web_search_20250305');

/** Eine Recherche; Fehler kommen als error-Text zurück, nie als Exception. */
export async function research(db: Db, cfg: AiConfig, fetchFn: typeof fetch, q: { question: string; settings: WebSettings; names: string[]; maxUses?: number }): Promise<ResearchResult> {
  const query = filterQuery(q.question, q.names);
  if (!query) return { query, text: '', sources: [], searches: 0, inputTokens: 0, outputTokens: 0, error: 'Suchfrage leer (nach dem Entfernen von Namen und Adressen)' };
  const s = q.settings;
  if (cfg.provider === 'anthropic') {
    try {
      const client = new Anthropic({ apiKey: cfg.apiKey!, fetch: fetchFn as any, maxRetries: 1, timeout: 180_000 });
      const tool: any = { type: webSearchToolType(cfg.model), name: 'web_search', max_uses: Math.max(1, Math.min(q.maxUses ?? s.maxPerRun, s.maxPerRun)), user_location: { type: 'approximate', country: 'DE', timezone: 'Europe/Berlin' }, ...(s.allowedDomains.length ? { allowed_domains: s.allowedDomains } : s.blockedDomains.length ? { blocked_domains: s.blockedDomains } : {}) };
      const r: any = await client.beta.messages.create({
        model: cfg.model, max_tokens: 3000,
        system: 'Du recherchierst für ein Projektteam im Web. Antworte auf Deutsch, knapp und sachlich; nenne zu jeder Aussage die Quelle. Nur lesen: keine Formulare, keine Kontaktaufnahme. Fehlen belastbare Quellen, sag das.',
        messages: [{ role: 'user', content: query }], tools: [tool]
      } as any);
      const sources: WebSource[] = []; const seen = new Set<string>();
      const add = (url: unknown, title: unknown, cited: unknown) => { const u = String(url ?? ''); if (!u || seen.has(u) || !safeUrl(u)) return; seen.add(u); sources.push({ url: u, title: title ? String(title) : null, citedText: cited ? String(cited).slice(0, 500) : null }); };
      let text = '';
      // Zitierte Quellen zuerst (aus den Textblöcken), danach übrige Treffer der Suche
      for (const b of r.content ?? []) if (b.type === 'text') { text += (text ? '\n' : '') + String(b.text ?? ''); for (const c of b.citations ?? []) if (c.type === 'web_search_result_location') add(c.url, c.title, c.cited_text); }
      for (const b of r.content ?? []) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const x of b.content) if (x.type === 'web_search_result') add(x.url, x.title, null);
      const searches = Number(r.usage?.server_tool_use?.web_search_requests ?? (r.content ?? []).filter((b: any) => b.type === 'server_tool_use').length) || 0;
      // Quellen: zitierte zuerst, Treffer ohne Zitat nur bis fünf
      const cited = sources.filter((x) => x.citedText); const rest = sources.filter((x) => !x.citedText).slice(0, Math.max(0, 5 - cited.length));
      return { query, text: text.trim(), sources: [...cited, ...rest], searches: Math.max(searches, 1), inputTokens: Number(r.usage?.input_tokens ?? 0), outputTokens: Number(r.usage?.output_tokens ?? 0) };
    } catch (e: any) {
      return { query, text: '', sources: [], searches: 0, inputTokens: 0, outputTokens: 0, error: `Recherche fehlgeschlagen: ${String(e?.message ?? e).slice(0, 200)}` };
    }
  }
  try {
    const hits = (await searchLocal(fetchFn, s, query)).map((h) => ({ ...h, u: safeUrl(h.url) })).filter((h) => h.u && domainOk(h.u, s)).slice(0, 5);
    const sources: WebSource[] = []; const lines: string[] = [];
    for (const [i, h] of hits.entries()) {
      // Hostnamen erst nach der DNS-Auflösung prüfen (z. B. 127.0.0.1.nip.io)
      const excerpt = i < 3 && !(await outboundHostError(h.u!.hostname)) ? await fetchExcerpt(fetchFn, h.u!) : null;
      sources.push({ url: h.u!.toString(), title: h.title, citedText: (excerpt ?? h.snippet ?? '').slice(0, 500) || null });
      lines.push(`[${i + 1}] ${h.title ?? h.u!.hostname} – ${h.u}\n${excerpt ?? h.snippet ?? '(kein Text abgerufen)'}`);
    }
    return { query, text: lines.length ? lines.join('\n\n') : 'Keine Treffer.', sources, searches: 1, inputTokens: 0, outputTokens: 0 };
  } catch (e: any) {
    return { query, text: '', sources: [], searches: 1, inputTokens: 0, outputTokens: 0, error: `Recherche fehlgeschlagen: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

/** Abschnitt „Quellen (abgerufen am …)“ für Seiten, die im selben Lauf entstehen oder geändert werden. */
export function sourcesSection(sources: WebSource[], now = new Date()): string {
  if (!sources.length) return '';
  const seen = new Set<string>();
  const lines = sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true))).slice(0, 15).map((s) => `- [${(s.title ?? s.url).replace(/[\[\]]/g, '')}](${s.url})`);
  return `\n\n## Quellen (abgerufen am ${now.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })})\n\n${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Arbeitszeitfenster für Mails der Agenten nach außen (Entscheidung: Mo–Fr 07–19 Europe/Berlin, nur für externe Mails)

export const DEFAULT_WINDOW: ExternalWindow = { enabled: true, days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' };
export async function externalWindow(db: Db, orgId: string): Promise<ExternalWindow> {
  const o = await db.one(`select settings->'ai'->'externalWindow' as w from orgs where id = $1`, [orgId]);
  return parseWindow(o.w) ?? DEFAULT_WINDOW;
}
export function parseWindow(raw: unknown): ExternalWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as any;
  const hm = (v: unknown, def: string) => (/^\d{2}:\d{2}$/.test(String(v ?? '')) ? String(v) : def);
  const days = Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter((d: number) => d >= 1 && d <= 7))] as number[] : DEFAULT_WINDOW.days;
  return { enabled: x.enabled !== false, days: days.length ? days : DEFAULT_WINDOW.days, from: hm(x.from, DEFAULT_WINDOW.from), to: hm(x.to, DEFAULT_WINDOW.to) };
}
const berlin = (d: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { dow, hm: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`, ymd: `${get('year')}-${get('month')}-${get('day')}` };
};
/** Liegt der Zeitpunkt im Fenster? */
export function inWindow(w: ExternalWindow, now: Date): boolean {
  if (!w.enabled) return true;
  const b = berlin(now);
  return w.days.includes(b.dow) && b.hm >= w.from && b.hm < w.to;
}
/** Nächster Fensterbeginn (Europe/Berlin) ab jetzt; im Fenster: jetzt. */
export function nextWindowStart(w: ExternalWindow, now: Date): Date {
  if (inWindow(w, now)) return now;
  for (let i = 0; i < 8; i++) {
    const day = new Date(now.getTime() + i * 86400_000);
    const b = berlin(day);
    if (!w.days.includes(b.dow)) continue;
    if (i === 0 && b.hm >= w.from) continue;
    // lokale Uhrzeit from an diesem Tag in UTC umrechnen (Versatz des Tages)
    const probe = new Date(`${b.ymd}T${w.from}:00Z`);
    const off = offsetMinutes(probe);
    return new Date(probe.getTime() - off * 60_000);
  }
  return new Date(now.getTime() + 86400_000);
}
function offsetMinutes(d: Date): number {
  const z = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT+1';
  const m = z.match(/GMT([+-])(\d+)(?::(\d+))?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 60;
}
export const windowText = (w: ExternalWindow) => `${w.days.map((d) => ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'][d]).join(', ')} ${w.from}–${w.to}`;

import type { FastifyInstance } from 'fastify';

/**
 * Einfache Drosselung sensibler Endpunkte (gleitendes Fenster im Speicher, je Prozess): Anmeldung, Passwort vergessen,
 * Zweiter Faktor, Einladung annehmen, Freigabe-Links. Zähler je Client-Adresse und zusätzlich je Konto (E-Mail bzw.
 * TOTP-Challenge, kleingeschrieben), damit ein verteilter Angreifer ein Konto nicht aus vielen Adressen durchprobiert.
 * Antwort 429 bei Überschreitung. Hinter einem Proxy zählt req.ip nur mit passendem TRUST_PROXY (siehe .env.example).
 */
interface Rule { test: (method: string, url: string) => boolean; limit: number; windowMs: number; /** Kontoschlüssel aus dem Body (Zähler je Konto) */ account?: (body: any) => string | null; accountLimit?: number }
const RULES: Rule[] = [
  { test: (m, u) => m === 'POST' && (u === '/api/auth/login' || u === '/api/auth/forgot'), limit: 10, windowMs: 60_000, account: (b) => (typeof b?.email === 'string' && b.email.trim() ? b.email.trim().toLowerCase() : null), accountLimit: 10 },
  { test: (m, u) => m === 'POST' && u === '/api/auth/login/totp', limit: 10, windowMs: 60_000, account: (b) => (typeof b?.challenge === 'string' && b.challenge ? `totp:${b.challenge}` : null), accountLimit: 10 },
  { test: (m, u) => m === 'POST' && u.startsWith('/api/auth/reset/'), limit: 10, windowMs: 60_000 },
  { test: (m, u) => m === 'POST' && u.startsWith('/api/invitations/accept/'), limit: 10, windowMs: 60_000 },
  { test: (m, u) => u.startsWith('/api/share/') || u.startsWith('/api/ics/'), limit: 120, windowMs: 60_000 }
];
const hits = new Map<string, number[]>();

/** Zählt einen Treffer; true = Limit überschritten (der Treffer wird dann nicht gezählt). */
function exceeded(key: string, limit: number, windowMs: number, now: number): boolean {
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) return true;
  arr.push(now); hits.set(key, arr);
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
  return false;
}
/** Nur für Tests: Zähler leeren. */
export function resetRateLimit(): void { hits.clear(); }

export function registerRateLimit(app: FastifyInstance) {
  const tooMany = (reply: any, windowMs: number) => {
    reply.header('retry-after', String(Math.ceil(windowMs / 1000)));
    reply.status(429).send({ error: 'Zu viele Versuche, bitte kurz warten' });
    return reply;
  };
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    const rule = RULES.find((r) => r.test(req.method, url));
    if (!rule) return;
    // Tests melden sich viele Male von localhost an; dort nur drosseln, wenn eine fremde Adresse simuliert wird
    if (process.env.NODE_ENV === 'test' && (req.ip === '127.0.0.1' || req.ip === '::1')) return;
    if (exceeded(`${RULES.indexOf(rule)}:ip:${req.ip}`, rule.limit, rule.windowMs, Date.now())) return tooMany(reply, rule.windowMs);
  });
  // Zähler je Konto braucht den Body (erst nach dem Parsen verfügbar)
  app.addHook('preHandler', async (req, reply) => {
    const url = req.url.split('?')[0];
    const rule = RULES.find((r) => r.test(req.method, url));
    if (!rule?.account) return;
    if (process.env.NODE_ENV === 'test' && (req.ip === '127.0.0.1' || req.ip === '::1')) return;
    const acct = rule.account(req.body);
    if (!acct) return;
    if (exceeded(`${RULES.indexOf(rule)}:acct:${acct}`, rule.accountLimit ?? rule.limit, rule.windowMs, Date.now())) return tooMany(reply, rule.windowMs);
  });
  // Schutz-Header für alle Antworten
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (process.env.COOKIE_SECURE === 'true') reply.header('strict-transport-security', 'max-age=31536000');
    // Nur eigene Skripte (keine Inline-Handler; Anhänge setzen eine strengere eigene): zweite Schutzschicht gegen eingeschleustes HTML, z. B. aus Mails.
    // img-src nur eigene, data: und blob: (keine Tracking-Pixel aus Doku-Seiten; externe Bilder entfernt der Sanitizer; Mail-HTML läuft im
    // Sandbox-iframe mit eigener CSP). style-src 'unsafe-inline' bleibt: TipTap setzt Schriftgrößen/Ausrichtung als Inline-Stile.
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  });
}

import type { FastifyInstance } from 'fastify';

/**
 * Einfache Drosselung sensibler Endpunkte je Client-Adresse (gleitendes Fenster im Speicher):
 * Anmeldung, Passwort vergessen, Zweiter Faktor, Einladung annehmen, Freigabe-Links. Antwort 429 bei Überschreitung.
 */
const RULES: { test: (method: string, url: string) => boolean; limit: number; windowMs: number }[] = [
  { test: (m, u) => m === 'POST' && (u.startsWith('/api/auth/login') || u.startsWith('/api/auth/forgot') || u.startsWith('/api/auth/reset/')), limit: 10, windowMs: 60_000 },
  { test: (m, u) => m === 'POST' && u.startsWith('/api/invitations/accept/'), limit: 10, windowMs: 60_000 },
  { test: (m, u) => u.startsWith('/api/share/') || u.startsWith('/api/ics/'), limit: 120, windowMs: 60_000 }
];
const hits = new Map<string, number[]>();

export function registerRateLimit(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    const rule = RULES.find((r) => r.test(req.method, url));
    if (!rule) return;
    // Tests melden sich viele Male von localhost an; dort nur drosseln, wenn eine fremde Adresse simuliert wird
    if (process.env.NODE_ENV === 'test' && (req.ip === '127.0.0.1' || req.ip === '::1')) return;
    const key = `${RULES.indexOf(rule)}:${req.ip}`;
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < rule.windowMs);
    if (arr.length >= rule.limit) {
      reply.header('retry-after', String(Math.ceil(rule.windowMs / 1000)));
      reply.status(429).send({ error: 'Zu viele Versuche, bitte kurz warten' });
      return reply;
    }
    arr.push(now); hits.set(key, arr);
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((t) => now - t >= rule.windowMs)) hits.delete(k);
  });
  // Schutz-Header für alle Antworten
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    // Nur eigene Skripte (keine Inline-Handler): zweite Schutzschicht gegen eingeschleustes HTML, z. B. aus Mails
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  });
}

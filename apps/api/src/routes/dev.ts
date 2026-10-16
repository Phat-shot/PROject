import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { badRequest, notFound } from '../errors.js';

/** Nur außerhalb der Produktion: Dev-Postfächer befüllen, Sync anstoßen. */
export async function devRoutes(app: FastifyInstance) {
  app.post<{ Body: { accountId: string; from: string; fromName?: string; to?: string[]; subject: string; text?: string; folder?: string; inReplyTo?: string } }>('/dev/mail/inject', async (req) => {
    requireUser(req);
    const b = req.body ?? ({} as any);
    if (!b.accountId || !b.from || !b.subject) throw badRequest('accountId, from, subject erforderlich');
    const a = await app.db.maybeOne(`select * from mail_accounts where id = $1 and provider = 'dev'`, [b.accountId]);
    if (!a) throw notFound('Dev-Konto nicht gefunden');
    app.mail.dev.inject(a.id, {
      from: { address: b.from, name: b.fromName ?? null },
      to: b.to ?? [a.address],
      subject: b.subject,
      text: b.text ?? '',
      folder: b.folder ?? 'INBOX',
      inReplyTo: b.inReplyTo ?? null
    });
    const result = await app.mail.syncAccount(a.id);
    return { result };
  });

  app.post('/dev/mail/sync-all', async (req) => {
    requireUser(req);
    const accounts = await app.db.query(`select id from mail_accounts`);
    const results = [];
    for (const a of accounts.rows) results.push(await app.mail.syncAccount(a.id));
    return { results };
  });

  app.get('/dev/mail/sent', async (req) => {
    requireUser(req);
    return { sent: app.mail.dev.sent };
  });
}

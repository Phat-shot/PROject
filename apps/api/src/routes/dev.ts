import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { badRequest, notFound } from '../errors.js';

/** Nur außerhalb der Produktion: Dev-Postfächer befüllen, Sync anstoßen. Alles auf die Org der angemeldeten Person begrenzt. */
export async function devRoutes(app: FastifyInstance) {
  app.post<{ Body: { accountId: string; from: string; fromName?: string; to?: string[]; subject: string; text?: string; html?: string; folder?: string; inReplyTo?: string } }>('/dev/mail/inject', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? ({} as any);
    if (!b.accountId || !b.from || !b.subject) throw badRequest('accountId, from, subject erforderlich');
    const a = await app.db.maybeOne(`select * from mail_accounts where id = $1 and provider = 'dev' and org_id = $2`, [b.accountId, user.orgId]);
    if (!a) throw notFound('Dev-Konto nicht gefunden');
    app.mail.dev.inject(a.id, {
      from: { address: b.from, name: b.fromName ?? null },
      to: b.to ?? [a.address],
      subject: b.subject,
      text: b.text ?? '',
      ...(b.html ? { html: b.html } : {}),
      folder: b.folder ?? 'INBOX',
      inReplyTo: b.inReplyTo ?? null
    });
    const result = await app.mail.syncAccount(a.id);
    return { result };
  });

  app.post('/dev/mail/sync-all', async (req) => {
    const user = requireUser(req);
    const accounts = await app.db.query(`select id from mail_accounts where org_id = $1`, [user.orgId]);
    const results = [];
    for (const a of accounts.rows) results.push(await app.mail.syncAccount(a.id));
    return { results };
  });

  app.get('/dev/mail/sent', async (req) => {
    const user = requireUser(req);
    // Nur Versand aus Konten der eigenen Org
    const own = new Set((await app.db.query(`select id from mail_accounts where org_id = $1`, [user.orgId])).rows.map((r: any) => String(r.id)));
    return { sent: app.mail.dev.sent.filter((s: any) => own.has(String(s.accountId))) };
  });
}

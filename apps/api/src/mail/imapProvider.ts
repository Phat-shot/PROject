import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { AccountRow, IncomingMessage, MailProvider, MessageEnvelope, OutgoingMessage, SyncContext } from './types.js';

/**
 * IMAP/SMTP-Adapter. Kopfdaten werden zuerst geholt (ENVELOPE), nur Treffer
 * werden vollständig geladen. OAuth2 (XOAUTH2) folgt; alpha: Passwort.
 */
export class ImapMailProvider implements MailProvider {
  async fetchNew(account: AccountRow, ctx: SyncContext) {
    const client = new ImapFlow({
      host: account.imap_host!,
      port: account.imap_port ?? 993,
      secure: account.imap_secure ?? true,
      auth: { user: account.imap_user ?? account.address, pass: account.imap_password ?? '' },
      logger: false
    });
    const cursor: Record<string, unknown> = { ...(account.sync_cursor ?? {}) };
    const messages: IncomingMessage[] = [];
    await client.connect();
    try {
      for (const folder of ctx.folders) {
        const lock = await client.getMailboxLock(folder);
        try {
          const last = Number(cursor[folder] ?? 0);
          const range = `${last + 1}:*`;
          const candidates: { uid: number; env: MessageEnvelope }[] = [];
          for await (const msg of client.fetch(range, { uid: true, envelope: true }, { uid: true })) {
            if (msg.uid <= last) continue;
            const e = msg.envelope!;
            const env: MessageEnvelope = {
              folder,
              uid: String(msg.uid),
              messageId: e.messageId ?? null,
              inReplyTo: e.inReplyTo ?? null,
              references: null,
              from: { address: e.from?.[0]?.address ?? '', name: e.from?.[0]?.name ?? null },
              to: (e.to ?? []).map((a: any) => a.address).filter(Boolean),
              cc: (e.cc ?? []).map((a: any) => a.address).filter(Boolean),
              subject: e.subject ?? '',
              date: e.date ? new Date(e.date) : new Date()
            };
            candidates.push({ uid: msg.uid, env });
          }
          let max = last;
          for (const c of candidates) {
            max = Math.max(max, c.uid);
            if (!ctx.headerMatches(c.env)) continue;
            const dl = await client.download(String(c.uid), undefined, { uid: true });
            const parsed = await simpleParser(dl.content);
            messages.push({
              ...c.env,
              references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references ?? null,
              text: parsed.text ?? null,
              html: typeof parsed.html === 'string' ? parsed.html : null,
              hasAttachments: (parsed.attachments?.length ?? 0) > 0
            });
          }
          cursor[folder] = max;
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return { messages, cursor };
  }

  async send(account: AccountRow, msg: OutgoingMessage) {
    const transport = nodemailer.createTransport({
      host: account.smtp_host!,
      port: account.smtp_port ?? 587,
      secure: account.smtp_secure ?? false,
      auth: account.smtp_user ? { user: account.smtp_user, pass: account.smtp_password ?? '' } : undefined
    });
    const info = await transport.sendMail({
      from: msg.from.name ? { name: msg.from.name, address: msg.from.address } : msg.from.address,
      to: msg.to,
      cc: msg.cc,
      replyTo: msg.replyTo,
      subject: msg.subject,
      text: msg.text,
      inReplyTo: msg.inReplyTo ?? undefined,
      references: msg.references ?? undefined,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
    });
    return { messageId: info.messageId };
  }
}

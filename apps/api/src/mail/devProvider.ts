import { randomUUID } from 'node:crypto';
import type { AccountRow, IncomingMessage, MailProvider, OutgoingMessage, SyncContext } from './types.js';

/**
 * Entwicklungs-Adapter: Postfach im Speicher je Konto. Mails werden über
 * POST /api/dev/mail/inject eingespielt; Versand landet im Ordner "Sent".
 */
export class DevMailProvider implements MailProvider {
  private boxes = new Map<string, IncomingMessage[]>();
  public sent: { accountId: string; msg: OutgoingMessage; messageId: string }[] = [];

  inject(accountId: string, m: Partial<IncomingMessage> & { from: IncomingMessage['from']; subject: string }): IncomingMessage {
    const box = this.boxes.get(accountId) ?? [];
    const msg: IncomingMessage = {
      folder: m.folder ?? 'INBOX',
      uid: m.uid ?? String(box.filter((x) => x.folder === (m.folder ?? 'INBOX')).length + 1),
      messageId: m.messageId ?? `<${randomUUID()}@dev.local>`,
      inReplyTo: m.inReplyTo ?? null,
      references: m.references ?? null,
      from: m.from,
      to: m.to ?? [],
      cc: m.cc ?? [],
      subject: m.subject,
      date: m.date ?? new Date(),
      text: m.text ?? null,
      html: m.html ?? null,
      hasAttachments: m.hasAttachments ?? false
    };
    box.push(msg);
    this.boxes.set(accountId, box);
    return msg;
  }

  async fetchNew(account: AccountRow, ctx: SyncContext) {
    const box = this.boxes.get(account.id) ?? [];
    const cursor: Record<string, unknown> = { ...(account.sync_cursor ?? {}) };
    const out: IncomingMessage[] = [];
    for (const folder of ctx.folders) {
      const last = Number(cursor[folder] ?? 0);
      const inFolder = box.filter((m) => m.folder === folder && Number(m.uid) > last);
      for (const m of inFolder) {
        if (ctx.headerMatches(m)) out.push(m);
      }
      const max = inFolder.reduce((a, m) => Math.max(a, Number(m.uid)), last);
      cursor[folder] = max;
    }
    return { messages: out, cursor };
  }

  async send(account: AccountRow, msg: OutgoingMessage) {
    const messageId = `<${randomUUID()}@dev.local>`;
    this.sent.push({ accountId: account.id, msg, messageId });
    this.inject(account.id, {
      folder: 'Sent',
      messageId,
      from: { address: msg.from.address, name: msg.from.name ?? null },
      to: msg.to,
      cc: msg.cc ?? [],
      subject: msg.subject,
      text: msg.text,
      inReplyTo: msg.inReplyTo ?? null,
      hasAttachments: (msg.attachments?.length ?? 0) > 0
    });
    return { messageId };
  }
}

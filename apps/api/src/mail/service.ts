import type { MailViewFilter } from '@projekttool/shared';
import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { DevMailProvider } from './devProvider.js';
import { ImapMailProvider } from './imapProvider.js';
import { headerMatches, matches, plusAddress, snippetOf, taskCodeFromAddresses } from './filter.js';
import type { AccountRow, IncomingMessage, MailProvider, OutgoingMessage, SyncContext } from './types.js';

export interface SyncResult {
  accountId: string;
  fetched: number;
  stored: number;
  error?: string;
}

/**
 * Mail-Fachlogik: Synchronisation (nur Treffer einer Ansicht werden gespeichert),
 * Versand über das Konto, Zuordnung eingehender Antworten per Plus-Adresse.
 */
export class MailService {
  readonly dev = new DevMailProvider();
  private imap = new ImapMailProvider();

  constructor(private db: Db) {}

  provider(account: AccountRow): MailProvider {
    return account.provider === 'dev' ? this.dev : this.imap;
  }

  async syncAccount(accountId: string): Promise<SyncResult> {
    const account = await this.db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1`, [accountId]);
    if (!account) return { accountId, fetched: 0, stored: 0, error: 'Konto nicht gefunden' };
    const views = await this.db.query(`select * from mail_views where account_id = $1`, [accountId]);
    if (views.rows.length === 0) {
      await this.db.query(`update mail_accounts set last_sync_at = now(), sync_error = null where id = $1`, [accountId]);
      return { accountId, fetched: 0, stored: 0 };
    }
    const filters: { id: string; filter: MailViewFilter }[] = views.rows.map((v: any) => ({ id: v.id, filter: v.filter ?? {} }));
    const folders = new Set<string>();
    for (const f of filters) (f.filter.folders?.length ? f.filter.folders : ['INBOX']).forEach((x) => folders.add(x));
    const ctx: SyncContext = {
      folders: [...folders],
      headerMatches: (env) => filters.some((f) => headerMatches(f.filter, env)),
      needsBody: filters.some((f) => (f.filter.keyword?.length ?? 0) > 0)
    };
    try {
      const { messages, cursor } = await this.provider(account).fetchNew(account, ctx);
      let stored = 0;
      for (const m of messages) {
        const hit = filters.filter((f) => matches(f.filter, m)).map((f) => f.id);
        if (hit.length === 0) continue; // Nichttreffer: sofort verwerfen, kein Zwischenspeicher
        const id = await this.storeMail(account, m, hit);
        if (id) stored++;
      }
      await this.db.query(`update mail_accounts set sync_cursor = $2, last_sync_at = now(), sync_error = null where id = $1`, [accountId, JSON.stringify(cursor)]);
      return { accountId, fetched: messages.length, stored };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      await this.db.query(`update mail_accounts set sync_error = $2 where id = $1`, [accountId, msg]);
      await audit(this.db, { orgId: account.org_id, projectId: account.project_id, action: 'mail.sync_failed', objectType: 'mail_account', objectId: accountId, details: { error: msg } });
      return { accountId, fetched: 0, stored: 0, error: msg };
    }
  }

  private async storeMail(account: AccountRow, m: IncomingMessage, viewIds: string[]): Promise<string | null> {
    const r = await this.db.maybeOne(
      `insert into mails (account_id, folder, uid, message_id, in_reply_to, references_header, from_addr, from_name, to_json, cc_json, subject, date, text_body, html_body, snippet, has_attachments, outgoing)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       on conflict (account_id, folder, uid) do nothing returning id`,
      [account.id, m.folder, m.uid, m.messageId, m.inReplyTo, m.references, m.from.address, m.from.name, JSON.stringify(m.to), JSON.stringify(m.cc), m.subject, m.date,
        m.text, m.html, snippetOf(m), m.hasAttachments, m.folder.toLowerCase() === 'sent']
    );
    if (!r) return null;
    for (const v of viewIds) {
      await this.db.query(`insert into mail_view_matches (mail_id, view_id) values ($1,$2) on conflict do nothing`, [r.id, v]);
    }
    await this.linkByPlusAddress(account, r.id, m);
    return r.id;
  }

  /** Antwort eines Externen: Plus-Adresse → Aufgabe; Fallback In-Reply-To auf eine gesendete Mail mit Aufgabenbezug. */
  private async linkByPlusAddress(account: AccountRow, mailId: string, m: IncomingMessage) {
    const code = taskCodeFromAddresses([...m.to, ...m.cc]);
    let taskId: string | null = null;
    if (code) {
      const t = await this.db.maybeOne(`select id from tasks where mail_code = $1`, [code]);
      taskId = t?.id ?? null;
    }
    if (!taskId && m.inReplyTo) {
      const t = await this.db.maybeOne(
        `select l.task_id from mails x join mail_task_links l on l.mail_id = x.id where x.account_id = $1 and x.message_id = $2 limit 1`,
        [account.id, m.inReplyTo]
      );
      taskId = t?.task_id ?? null;
    }
    if (taskId) {
      await this.db.query(`insert into mail_task_links (mail_id, task_id, copied) values ($1,$2,false) on conflict do nothing`, [mailId, taskId]);
      await audit(this.db, { orgId: account.org_id, projectId: account.project_id, action: 'mail.auto_linked', objectType: 'mail', objectId: mailId, details: { taskId, via: code ? 'plus-address' : 'in-reply-to' } });
    }
  }

  async sendFromAccount(
    account: AccountRow,
    input: { to: string[]; cc?: string[]; subject: string; text: string; taskId?: string | null; inReplyTo?: string | null; references?: string | null; userId: string; projectId?: string | null; attachments?: { filename: string; content: Buffer; contentType: string }[] }
  ): Promise<{ messageId: string; mailId: string | null }> {
    let replyTo: string | undefined;
    if (input.taskId) {
      const t = await this.db.maybeOne(`select mail_code from tasks where id = $1`, [input.taskId]);
      if (t && account.type === 'project') replyTo = plusAddress(account.address, t.mail_code);
    }
    const msg: OutgoingMessage = {
      from: { address: account.address, name: account.name },
      to: input.to,
      cc: input.cc,
      replyTo,
      subject: input.subject,
      text: input.text,
      inReplyTo: input.inReplyTo,
      references: input.references,
      attachments: input.attachments
    };
    const { messageId } = await this.provider(account).send(account, msg);
    const user = await this.db.maybeOne(`select name from users where id = $1`, [input.userId]);
    const r = await this.db.one(
      `insert into mails (account_id, folder, uid, message_id, in_reply_to, from_addr, from_name, to_json, cc_json, subject, date, text_body, snippet, outgoing, has_attachments)
       values ($1,'Sent',$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,true,$12) returning id`,
      [account.id, messageId, messageId, input.inReplyTo ?? null, account.address, `${account.name} (gesendet von ${user?.name ?? '?'} über Tool)`,
        JSON.stringify(input.to), JSON.stringify(input.cc ?? []), input.subject, input.text, snippetOf({ text: input.text, html: null }), (input.attachments?.length ?? 0) > 0]
    );
    // Gesendete Mails erscheinen in allen Ansichten des Kontos, die 'Sent' nennen oder keinen Ordnerfilter haben.
    const views = await this.db.query(`select id, filter from mail_views where account_id = $1`, [account.id]);
    for (const v of views.rows) {
      const f: MailViewFilter = v.filter ?? {};
      if (!f.folders?.length || f.folders.map((x) => x.toLowerCase()).includes('sent')) {
        await this.db.query(`insert into mail_view_matches (mail_id, view_id) values ($1,$2) on conflict do nothing`, [r.id, v.id]);
      }
    }
    if (input.taskId) {
      await this.db.query(`insert into mail_task_links (mail_id, task_id, copied, linked_by) values ($1,$2,false,$3) on conflict do nothing`, [r.id, input.taskId, input.userId]);
    }
    await audit(this.db, { orgId: account.org_id, projectId: input.projectId ?? account.project_id, userId: input.userId, action: 'mail.send', objectType: 'mail', objectId: r.id, details: { to: input.to, subject: input.subject, account: account.address } });
    return { messageId, mailId: r.id };
  }
}

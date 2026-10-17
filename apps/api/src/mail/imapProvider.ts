import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { unseal } from '../secrets.js';
import type { MailFolder, AccountRow, IncomingMessage, MailProvider, MessageEnvelope, OutgoingMessage, SyncContext } from './types.js';

/**
 * IMAP/SMTP-Adapter. Kopfdaten werden zuerst geholt (ENVELOPE), nur Treffer
 * werden vollständig geladen. Anmeldung per Passwort oder XOAUTH2 (OAuth2-Konten); Geheimnisse liegen verschlüsselt.
 */
function specialOf(box: { path: string; specialUse?: string | null; name: string }): MailFolder['specialUse'] {
  const su = (box.specialUse ?? '').toLowerCase();
  const n = box.name.toLowerCase();
  if (box.path.toUpperCase() === 'INBOX') return 'inbox';
  if (su === '\\sent' || n === 'sent' || n === 'gesendet' || n === 'sent items') return 'sent';
  if (su === '\\trash' || n === 'trash' || n === 'papierkorb' || n === 'deleted' || n === 'deleted items' || n === 'gelöscht') return 'trash';
  if (su === '\\archive' || n === 'archive' || n === 'archiv') return 'archive';
  if (su === '\\drafts' || n === 'drafts' || n === 'entwürfe') return 'drafts';
  if (su === '\\junk' || n === 'junk' || n === 'spam') return 'junk';
  return null;
}

export class ImapMailProvider implements MailProvider {
  private client(account: AccountRow) {
    return new ImapFlow({
      host: account.imap_host!, port: account.imap_port ?? 993, secure: account.imap_secure ?? true,
      auth: imapAuth(account), logger: false
    });
  }

  async listFolders(account: AccountRow): Promise<MailFolder[]> {
    const client = this.client(account);
    await client.connect();
    try {
      const boxes = await client.list();
      return boxes.map((b) => ({ path: b.path, name: b.name, specialUse: specialOf(b as any) }));
    } finally { await client.logout().catch(() => undefined); }
  }

  async createFolder(account: AccountRow, path: string): Promise<MailFolder> {
    const client = this.client(account);
    await client.connect();
    try {
      const r = await client.mailboxCreate(path);
      return { path: r.path, name: path.split(/[./]/).pop() ?? path, specialUse: null };
    } finally { await client.logout().catch(() => undefined); }
  }

  async move(account: AccountRow, mail: { folder: string; uid: string | null }, target: string): Promise<{ uid: string | null }> {
    if (!mail.uid) throw new Error('Nachricht ohne UID kann beim Anbieter nicht verschoben werden');
    const client = this.client(account);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(mail.folder);
      try {
        const r = await client.messageMove(mail.uid, target, { uid: true });
        const newUid = r && typeof r === 'object' && 'uidMap' in r && r.uidMap ? r.uidMap.get(Number(mail.uid)) : undefined;
        return { uid: newUid ? String(newUid) : null };
      } finally { lock.release(); }
    } finally { await client.logout().catch(() => undefined); }
  }

  async fetchNew(account: AccountRow, ctx: SyncContext) {
    const client = new ImapFlow({
      host: account.imap_host!,
      port: account.imap_port ?? 993,
      secure: account.imap_secure ?? true,
      auth: imapAuth(account),
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

  /** Prüft IMAP-Login und SMTP-Verbindung getrennt und liefert verständliche Fehler. */
  async test(account: AccountRow): Promise<{ imap: { ok: boolean; error?: string; folders?: string[] }; smtp: { ok: boolean; error?: string } }> {
    const result = { imap: { ok: false } as { ok: boolean; error?: string; folders?: string[] }, smtp: { ok: false } as { ok: boolean; error?: string } };
    const client = new ImapFlow({
      host: account.imap_host!, port: account.imap_port ?? 993, secure: account.imap_secure ?? true,
      auth: imapAuth(account), logger: false, connectionTimeout: 15000, greetingTimeout: 15000
    });
    try {
      await client.connect();
      const list = await client.list();
      result.imap = { ok: true, folders: list.map((f) => f.path).slice(0, 30) };
      await client.logout().catch(() => undefined);
    } catch (e: any) {
      result.imap = { ok: false, error: friendlyError(e) };
    }
    try {
      const transport = nodemailer.createTransport(smtpOptions(account));
      await transport.verify();
      result.smtp = { ok: true };
    } catch (e: any) {
      result.smtp = { ok: false, error: friendlyError(e) };
    }
    return result;
  }

  async send(account: AccountRow, msg: OutgoingMessage) {
    const transport = nodemailer.createTransport(smtpOptions(account));
    let info;
    try {
      info = await transport.sendMail({
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
    } catch (e: any) {
      throw new Error(friendlyError(e));
    }
    return { messageId: info.messageId };
  }
}


/**
 * SMTP-Optionen: Port 465 ist implizites TLS, 587/25 ist STARTTLS. Ein falsch gesetzter SSL-Haken führt sonst zu
 * „Greeting never received“ oder „wrong version number“, deshalb wird die Verschlüsselung am Port festgemacht.
 */
function smtpOptions(account: AccountRow) {
  const port = account.smtp_port ?? 587;
  const secure = port === 465 ? true : port === 587 || port === 25 ? false : (account.smtp_secure ?? false);
  return {
    host: account.smtp_host!, port, secure, requireTLS: !secure && port === 587,
    auth: account.oauth_refresh_token
      ? { type: 'OAuth2' as const, user: account.smtp_user ?? account.imap_user ?? account.address, accessToken: unseal(account.oauth_access_token) ?? '' }
      : account.smtp_user ? { user: account.smtp_user, pass: unseal(account.smtp_password) ?? '' } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
  };
}

/** Passwort oder, bei OAuth2-Konten, XOAUTH2 mit dem (vom MailService aufgefrischten) Zugriffstoken. */
function imapAuth(account: AccountRow) {
  const user = account.imap_user ?? account.address;
  return account.oauth_refresh_token ? { user, accessToken: unseal(account.oauth_access_token) ?? '' } : { user, pass: unseal(account.imap_password) ?? '' };
}

export function friendlyError(e: any): string {
  const msg = String(e?.responseText ?? e?.response ?? e?.message ?? e);
  if (/Greeting never received/i.test(msg)) return 'SMTP-Server antwortet nicht (Greeting never received): Port und Verschlüsselung prüfen, 465 = SSL, 587 = STARTTLS. Manche Anbieter blockieren SMTP aus Rechenzentren.';
  if (/AUTHENTICATIONFAILED|Invalid credentials|535|authentication failed/i.test(msg)) return 'Anmeldung abgelehnt: Benutzername oder Passwort falsch (bei App-Passwörtern das App-Passwort verwenden).';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'Host nicht gefunden: Servername prüfen.';
  if (/ECONNREFUSED/i.test(msg)) return 'Verbindung abgelehnt: Port oder Verschlüsselung prüfen (IMAP 993/SSL, SMTP 587/STARTTLS oder 465/SSL).';
  if (/timeout|ETIMEDOUT/i.test(msg)) return 'Zeitüberschreitung: Server nicht erreichbar oder Port blockiert.';
  if (/certificate|self signed|CERT/i.test(msg)) return 'TLS-Zertifikat ungültig.';
  if (/wrong version number|ssl3_get_record/i.test(msg)) return 'Verschlüsselung passt nicht zum Port: SSL/TLS-Haken prüfen.';
  return msg.slice(0, 300);
}

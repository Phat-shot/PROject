import type { AccountRow, IncomingMessage, MailFolder, MailProvider, MessageEnvelope, OutgoingMessage, SyncContext } from './types.js';

const BASE = 'https://graph.microsoft.com/v1.0/me';
const SPECIAL: Record<string, MailFolder['specialUse']> = { inbox: 'inbox', sentitems: 'sent', deleteditems: 'trash', archive: 'archive', drafts: 'drafts', junkemail: 'junk' };

/**
 * Microsoft-Graph-Adapter: Ordner, neue Nachrichten je Ordner ab Zeitstempel (Kopfdaten zuerst, Body nur für Treffer),
 * Versand über sendMail, Verschieben. Das Zugriffstoken liefert tokenFor (mit Refresh).
 */
export class GraphMailProvider implements MailProvider {
  constructor(private tokenFor: (account: AccountRow) => Promise<string>, private fetchFn: typeof fetch = fetch) {}

  private async call(account: AccountRow, path: string, init: RequestInit = {}): Promise<any> {
    const token = await this.tokenFor(account);
    const r = await this.fetchFn(path.startsWith('http') ? path : `${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (r.status === 202 || r.status === 204) return null;
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Graph ${init.method ?? 'GET'} ${path}: ${j.error?.message ?? r.status}`);
    return j;
  }

  async listFolders(account: AccountRow): Promise<MailFolder[]> {
    const j = await this.call(account, '/mailFolders?$top=100&$select=id,displayName,wellKnownName');
    return (j.value as any[]).map((f) => ({ path: f.id, name: f.displayName, specialUse: SPECIAL[(f.wellKnownName ?? '').toLowerCase()] ?? null }));
  }

  async createFolder(account: AccountRow, path: string): Promise<MailFolder> {
    const j = await this.call(account, '/mailFolders', { method: 'POST', body: JSON.stringify({ displayName: path }) });
    return { path: j.id, name: j.displayName, specialUse: null };
  }

  async move(account: AccountRow, mail: { folder: string; uid: string | null }, target: string): Promise<{ uid: string | null }> {
    if (!mail.uid) throw new Error('Nachricht ohne ID kann nicht verschoben werden');
    const j = await this.call(account, `/messages/${encodeURIComponent(mail.uid)}/move`, { method: 'POST', body: JSON.stringify({ destinationId: target }) });
    return { uid: j?.id ?? null };
  }

  async fetchNew(account: AccountRow, ctx: SyncContext): Promise<{ messages: IncomingMessage[]; cursor: Record<string, unknown> }> {
    const cursor: Record<string, unknown> = { ...(account.sync_cursor ?? {}) };
    const messages: IncomingMessage[] = [];
    const folders = await this.listFolders(account);
    for (const name of ctx.folders) {
      const folder = folders.find((f) => f.path === name || f.name.toLowerCase() === name.toLowerCase() || (name.toUpperCase() === 'INBOX' && f.specialUse === 'inbox'));
      if (!folder) continue;
      const since = String(cursor[name] ?? '1970-01-01T00:00:00Z');
      let url: string | null = `/mailFolders/${encodeURIComponent(folder.path)}/messages?$top=50&$orderby=receivedDateTime asc&$filter=receivedDateTime gt ${since}&$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,internetMessageHeaders`;
      let latest = since;
      while (url) {
        const j: any = await this.call(account, url);
        for (const m of j.value as any[]) {
          const headers: Record<string, string> = Object.fromEntries(((m.internetMessageHeaders ?? []) as any[]).map((h) => [String(h.name).toLowerCase(), h.value]));
          const env: MessageEnvelope = {
            folder: name, uid: m.id, messageId: m.internetMessageId ?? null, inReplyTo: headers['in-reply-to'] ?? null, references: headers['references'] ?? null,
            from: { address: String(m.from?.emailAddress?.address ?? '').toLowerCase(), name: m.from?.emailAddress?.name ?? null },
            to: (m.toRecipients ?? []).map((r: any) => String(r.emailAddress?.address ?? '').toLowerCase()), cc: (m.ccRecipients ?? []).map((r: any) => String(r.emailAddress?.address ?? '').toLowerCase()),
            subject: m.subject ?? '', date: new Date(m.receivedDateTime)
          };
          if (m.receivedDateTime > latest) latest = m.receivedDateTime;
          if (!ctx.headerMatches(env)) continue;
          const full: any = await this.call(account, `/messages/${encodeURIComponent(m.id)}?$select=body,uniqueBody`);
          const isHtml = full.body?.contentType === 'html';
          messages.push({ ...env, text: isHtml ? null : full.body?.content ?? null, html: isHtml ? full.body?.content ?? null : null, hasAttachments: Boolean(m.hasAttachments) });
        }
        url = j['@odata.nextLink'] ?? null;
      }
      cursor[name] = latest;
    }
    return { messages, cursor };
  }

  async send(account: AccountRow, msg: OutgoingMessage): Promise<{ messageId: string }> {
    const rcpt = (list: string[] | undefined) => (list ?? []).map((address) => ({ emailAddress: { address } }));
    const message: any = {
      subject: msg.subject, body: { contentType: 'Text', content: msg.text },
      toRecipients: rcpt(msg.to), ccRecipients: rcpt(msg.cc),
      replyTo: msg.replyTo ? [{ emailAddress: { address: msg.replyTo } }] : undefined,
      internetMessageHeaders: msg.inReplyTo ? [{ name: 'x-pt-in-reply-to', value: msg.inReplyTo }] : undefined,
      attachments: (msg.attachments ?? []).map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType, contentBytes: a.content.toString('base64') }))
    };
    await this.call(account, '/sendMail', { method: 'POST', body: JSON.stringify({ message, saveToSentItems: true }) });
    return { messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@graph.${account.address.split('@')[1] ?? 'local'}>` };
  }
}

import type { FastifyInstance } from 'fastify';
import type { MailAccount, MailDraft, MailSummary, MailView, MailViewFilter, MailViewRights, ProjectRole, User } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { ALL_RIGHTS, getMembership, getViewRights, requireProject } from '../rights.js';
import { loadTask, newMailCode } from '../tasks/service.js';
import type { AccountRow } from '../mail/types.js';
import { AI_ACTIONS, loadMailRow, mailToLogEntry, mailToMarkdown } from '../mail/actions.js';
import { mapPage } from '../docs/service.js';
import { htmlToMd, mdToHtml } from '../docs/html.js';
import { notifyMany } from '../notify.js';

function mapAccount(r: any): MailAccount {
  return {
    id: r.id, type: r.type, name: r.name, address: r.address, provider: r.provider, ownerUserId: r.owner_user_id, projectId: r.project_id,
    imapHost: r.imap_host, imapPort: r.imap_port, imapUser: r.imap_user, imapSecure: r.imap_secure, smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpUser: r.smtp_user, smtpSecure: r.smtp_secure,
    hasImapPassword: Boolean(r.imap_password), hasSmtpPassword: Boolean(r.smtp_password), viewCount: r.view_count ?? 0,
    lastSyncAt: r.last_sync_at, syncError: r.sync_error
  };
}

function mapSummary(r: any): MailSummary {
  return {
    id: r.id, accountId: r.account_id, folder: r.folder, messageId: r.message_id, fromAddr: r.from_addr, fromName: r.from_name,
    toJson: r.to_json ?? [], subject: r.subject, date: r.date, snippet: r.snippet, hasAttachments: r.has_attachments,
    linkedTaskIds: (typeof r.linked_task_ids === 'string' ? JSON.parse(r.linked_task_ids) : r.linked_task_ids) ?? []
  };
}

function mapDraft(r: any): MailDraft {
  return {
    id: r.id, accountId: r.account_id, viewId: r.view_id, taskId: r.task_id, userId: r.user_id, userName: r.user_name ?? '',
    toAddrs: r.to_addrs ?? [], ccAddrs: r.cc_addrs ?? [], subject: r.subject, body: r.body, status: r.status, error: r.error, sentAt: r.sent_at, createdAt: r.created_at
  };
}

const LINKED = `coalesce((select json_agg(l.task_id) from mail_task_links l where l.mail_id = m.id), '[]'::json) as linked_task_ids`;

export async function mailRoutes(app: FastifyInstance) {
  const db = app.db;

  async function canManageAccount(user: User, account: AccountRow): Promise<boolean> {
    if (account.type === 'personal') return account.owner_user_id === user.id;
    if (account.type === 'org') return user.globalRole === 'org_admin';
    const m = await getMembership(db, account.project_id!, user.id);
    return m?.role === 'pl';
  }

  async function loadView(viewId: string) {
    return db.maybeOne(
      `select v.*, a.name as account_name, a.address as account_address, a.type as account_type, a.owner_user_id from mail_views v join mail_accounts a on a.id = v.account_id where v.id = $1`,
      [viewId]
    );
  }

  function mapView(v: any, rights: MailViewRights): MailView {
    return { id: v.id, accountId: v.account_id, accountName: v.account_name, accountAddress: v.account_address, accountType: v.account_type, projectId: v.project_id, name: v.name, filter: v.filter ?? {}, myRights: rights };
  }

  /** Darf der Benutzer diese Mail lesen? Über eine Ansicht mit Leserecht oder als Kopie in einer lesbaren Aufgabe. */
  async function mailReadable(user: User, mailId: string): Promise<{ ok: boolean; viewIds: string[]; rights: MailViewRights }> {
    const views = await db.query(`select view_id, (select project_id from mail_views where id = view_id) as project_id from mail_view_matches where mail_id = $1`, [mailId]);
    const merged: MailViewRights = { canRead: false, canDraft: false, canSend: false, canAi: false, canCreateTask: false };
    const readable: string[] = [];
    for (const v of views.rows) {
      const m = await getMembership(db, v.project_id, user.id);
      const r = await getViewRights(db, v.view_id, user, m);
      if (r.canRead) {
        readable.push(v.view_id);
        merged.canDraft ||= r.canDraft; merged.canSend ||= r.canSend; merged.canAi ||= r.canAi; merged.canCreateTask ||= r.canCreateTask;
      }
    }
    if (readable.length) return { ok: true, viewIds: readable, rights: { ...merged, canRead: true } };
    const copied = await db.query(
      `select t.project_id from mail_task_links l join tasks t on t.id = l.task_id where l.mail_id = $1 and l.copied`,
      [mailId]
    );
    for (const c of copied.rows) {
      if (await getMembership(db, c.project_id, user.id)) return { ok: true, viewIds: [], rights: { ...merged, canRead: true } };
    }
    return { ok: false, viewIds: [], rights: merged };
  }

  // Konten
  app.get('/mail/accounts', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select a.*, (select count(*)::int from mail_views v where v.account_id = a.id) as view_count from mail_accounts a
       where a.org_id = $1 and (a.owner_user_id = $2 or a.project_id in (select project_id from project_members where user_id = $2 and role = 'pl') or (a.type = 'org' and $3)) order by a.type, a.name`,
      [user.orgId, user.id, user.globalRole === 'org_admin']
    );
    return { accounts: rows.rows.map(mapAccount) };
  });

  app.post<{ Body: Partial<AccountRow> & { type: 'personal' | 'project' | 'org'; projectId?: string; provider?: 'imap' | 'dev'; imapHost?: string; imapPort?: number; imapUser?: string; imapPassword?: string; imapSecure?: boolean; smtpHost?: string; smtpPort?: number; smtpUser?: string; smtpPassword?: string; smtpSecure?: boolean } }>(
    '/mail/accounts',
    async (req) => {
      const user = requireUser(req);
      const b = req.body ?? ({} as any);
      if (!b.name || !b.address) throw badRequest('Name und Adresse erforderlich');
      const provider = b.provider ?? 'imap';
      if (provider === 'imap' && (!b.imapHost || !b.smtpHost)) throw badRequest('IMAP- und SMTP-Host erforderlich');
      if (provider === 'dev' && process.env.NODE_ENV === 'production') throw badRequest('Dev-Konten nur außerhalb der Produktion');
      let projectId: string | null = null;
      if (b.type === 'project') {
        if (!b.projectId) throw badRequest('projectId erforderlich');
        await requireProject(db, user, b.projectId, 'pl');
        projectId = b.projectId;
      } else if (b.type === 'org') {
        if (user.globalRole !== 'org_admin') throw forbidden('Org-Postfach legt der Org-Admin an');
        if (await db.maybeOne(`select 1 from mail_accounts where org_id = $1 and type = 'org'`, [user.orgId])) throw badRequest('Es gibt bereits ein Org-Postfach');
      } else if (b.type !== 'personal') throw badRequest('Typ personal, project oder org');
      const r = await db.one(
        `insert into mail_accounts (org_id, type, owner_user_id, project_id, name, address, provider, imap_host, imap_port, imap_user, imap_password, imap_secure, smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
        [user.orgId, b.type, b.type === 'personal' ? user.id : null, projectId, b.name, b.address.toLowerCase(), provider,
          b.imapHost ?? null, b.imapPort ?? null, b.imapUser ?? null, b.imapPassword ?? null, b.imapSecure ?? true,
          b.smtpHost ?? null, b.smtpPort ?? null, b.smtpUser ?? null, b.smtpPassword ?? null, b.smtpSecure ?? false]
      );
      if (projectId) await db.query(`update projects set mail_address = coalesce(mail_address, $2) where id = $1`, [projectId, r.address]);
      await audit(db, { orgId: user.orgId, projectId, userId: user.id, action: 'mail_account.create', objectType: 'mail_account', objectId: r.id, details: { type: b.type, address: b.address, provider } });
      return { account: mapAccount(r) };
    }
  );

  // Konto bearbeiten (leeres Passwortfeld = unverändert)
  app.patch<{ Params: { id: string }; Body: Record<string, any> }>('/mail/accounts/:id', async (req) => {
    const user = requireUser(req);
    const a = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!a) throw notFound('Konto nicht gefunden');
    if (!(await canManageAccount(user, a))) throw forbidden();
    const b = req.body ?? {};
    const r = await db.one(
      `update mail_accounts set name = coalesce($2, name), address = coalesce($3, address),
         imap_host = coalesce($4, imap_host), imap_port = coalesce($5, imap_port), imap_user = coalesce($6, imap_user), imap_password = coalesce(nullif($7, ''), imap_password), imap_secure = coalesce($8, imap_secure),
         smtp_host = coalesce($9, smtp_host), smtp_port = coalesce($10, smtp_port), smtp_user = coalesce($11, smtp_user), smtp_password = coalesce(nullif($12, ''), smtp_password), smtp_secure = coalesce($13, smtp_secure),
         sync_error = null
       where id = $1 returning *`,
      [a.id, b.name ?? null, b.address ? String(b.address).toLowerCase() : null, b.imapHost ?? null, b.imapPort ?? null, b.imapUser ?? null, b.imapPassword ?? null, b.imapSecure ?? null,
        b.smtpHost ?? null, b.smtpPort ?? null, b.smtpUser ?? null, b.smtpPassword ?? null, b.smtpSecure ?? null]
    );
    if (a.project_id && r.address !== a.address) await db.query(`update projects set mail_address = $2 where id = $1 and (mail_address = $3 or mail_address is null)`, [a.project_id, r.address, a.address]);
    await audit(db, { orgId: user.orgId, projectId: a.project_id, userId: user.id, action: 'mail_account.update', objectType: 'mail_account', objectId: a.id, details: Object.fromEntries(Object.entries(b).filter(([k]) => !/password/i.test(k))) });
    return { account: mapAccount(r) };
  });

  // Verbindung testen: gespeichertes Konto (accountId) oder noch ungespeicherte Konfiguration
  app.post<{ Body: Record<string, any> }>('/mail/accounts/test', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    let cfg: AccountRow;
    if (b.accountId) {
      const a = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1 and org_id = $2`, [b.accountId, user.orgId]);
      if (!a) throw notFound('Konto nicht gefunden');
      if (!(await canManageAccount(user, a))) throw forbidden();
      cfg = { ...a, imap_password: b.imapPassword || a.imap_password, smtp_password: b.smtpPassword || a.smtp_password, imap_host: b.imapHost ?? a.imap_host, imap_port: b.imapPort ?? a.imap_port, imap_user: b.imapUser ?? a.imap_user, imap_secure: b.imapSecure ?? a.imap_secure, smtp_host: b.smtpHost ?? a.smtp_host, smtp_port: b.smtpPort ?? a.smtp_port, smtp_user: b.smtpUser ?? a.smtp_user, smtp_secure: b.smtpSecure ?? a.smtp_secure, address: b.address ?? a.address };
    } else {
      if (!b.imapHost || !b.smtpHost) throw badRequest('IMAP- und SMTP-Host erforderlich');
      cfg = { id: '', org_id: user.orgId, type: 'personal', owner_user_id: user.id, project_id: null, name: b.name ?? '', address: b.address ?? '', provider: 'imap', imap_host: b.imapHost, imap_port: b.imapPort ?? 993, imap_user: b.imapUser ?? b.address, imap_password: b.imapPassword ?? '', imap_secure: b.imapSecure ?? true, smtp_host: b.smtpHost, smtp_port: b.smtpPort ?? 587, smtp_user: b.smtpUser ?? null, smtp_password: b.smtpPassword ?? '', smtp_secure: b.smtpSecure ?? false, sync_cursor: {} };
    }
    if (cfg.provider === 'dev') return { imap: { ok: true, folders: ['INBOX', 'Sent'] }, smtp: { ok: true } };
    const { ImapMailProvider } = await import('../mail/imapProvider.js');
    const result = await new ImapMailProvider().test(cfg);
    return result;
  });

  app.delete<{ Params: { id: string } }>('/mail/accounts/:id', async (req) => {
    const user = requireUser(req);
    const a = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!a) throw notFound('Konto nicht gefunden');
    if (!(await canManageAccount(user, a))) throw forbidden();
    await db.query(`delete from mail_accounts where id = $1`, [a.id]);
    if (a.project_id) await db.query(`update projects set mail_address = null where id = $1 and mail_address = $2`, [a.project_id, a.address]);
    await audit(db, { orgId: user.orgId, projectId: a.project_id, userId: user.id, action: 'mail_account.delete', objectType: 'mail_account', objectId: a.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/mail/accounts/:id/sync', async (req) => {
    const user = requireUser(req);
    const a = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!a) throw notFound('Konto nicht gefunden');
    if (!(await canManageAccount(user, a))) throw forbidden();
    const result = await app.mail.syncAccount(a.id);
    const views = await db.one(`select count(*)::int as c from mail_views where account_id = $1`, [a.id]);
    return { result, viewCount: views.c, hint: views.c === 0 ? 'Noch keine Ansicht auf diesem Konto. Lege im Projekt unter Mail eine Ansicht an; erst dann werden Mails geladen (nur Treffer werden gespeichert).' : null };
  });

  // Ansichten
  app.get<{ Params: { id: string } }>('/projects/:id/mail/views', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    const rows = await db.query(
      `select v.*, a.name as account_name, a.address as account_address, a.type as account_type, a.owner_user_id from mail_views v join mail_accounts a on a.id = v.account_id where v.project_id = $1 order by a.type desc, v.name`,
      [req.params.id]
    );
    const views: MailView[] = [];
    for (const v of rows.rows) {
      const rights = await getViewRights(db, v.id, user, m);
      const manage = v.account_type === 'personal' ? v.owner_user_id === user.id : m.role === 'pl';
      if (rights.canRead || manage) views.push({ ...mapView(v, rights), ...(manage ? { canManage: true } : {}) } as MailView);
    }
    return { views };
  });

  app.post<{ Params: { id: string }; Body: { accountId: string; name: string; filter?: MailViewFilter; roleRights?: Partial<Record<ProjectRole, Partial<MailViewRights>>> } }>('/projects/:id/mail/views', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? ({} as any);
    if (!b.accountId || !b.name) throw badRequest('Konto und Name erforderlich');
    const a = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1 and org_id = $2`, [b.accountId, user.orgId]);
    if (!a) throw notFound('Konto nicht gefunden');
    if (a.type === 'personal' && a.owner_user_id !== user.id) throw forbidden('Persönliche Konten teilt nur der Eigentümer');
    if (a.type === 'project' && (a.project_id !== req.params.id || m.role !== 'pl')) throw forbidden('Projektkonten verwaltet der PL des Projekts');
    const v = await db.one(
      `insert into mail_views (account_id, project_id, name, filter, created_by) values ($1,$2,$3,$4,$5) returning *`,
      [a.id, req.params.id, b.name, JSON.stringify(normalizeFilter(b.filter)), user.id]
    );
    await db.query(`insert into mail_view_rights (view_id, user_id, can_read, can_draft, can_send, can_ai, can_create_task) values ($1,$2,true,true,$3,true,true)`, [v.id, user.id, a.type === 'project']);
    for (const role of ['pl', 'member', 'reader'] as ProjectRole[]) {
      const rr = b.roleRights?.[role];
      if (!rr) continue;
      await db.query(
        `insert into mail_view_rights (view_id, role, can_read, can_draft, can_send, can_ai, can_create_task) values ($1,$2,$3,$4,$5,$6,$7)`,
        [v.id, role, rr.canRead ?? true, Boolean(rr.canDraft), Boolean(rr.canSend) && a.type === 'project', Boolean(rr.canAi), Boolean(rr.canCreateTask)]
      );
    }
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'mail_view.create', objectType: 'mail_view', objectId: v.id, details: { name: b.name, account: a.address, filter: b.filter ?? {} } });
    // Sofort synchronisieren, damit bestehende Treffer sichtbar werden.
    await app.mail.syncAccount(a.id);
    const full = await loadView(v.id);
    return { view: mapView(full, await getViewRights(db, v.id, user, m)) };
  });

  app.patch<{ Params: { vid: string }; Body: { name?: string; filter?: MailViewFilter } }>('/mail/views/:vid', async (req) => {
    const user = requireUser(req);
    const v = await loadView(req.params.vid);
    if (!v) throw notFound('Ansicht nicht gefunden');
    const a = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [v.account_id]);
    if (!(await canManageAccount(user, a))) throw forbidden();
    const b = req.body ?? {};
    await db.query(`update mail_views set name = coalesce($2, name), filter = coalesce($3::jsonb, filter) where id = $1`, [v.id, b.name ?? null, b.filter ? JSON.stringify(normalizeFilter(b.filter)) : null]);
    if (b.filter) {
      // Filter geändert: bestehende Treffer neu bewerten, Cursor zurücksetzen und neu laden.
      await db.query(`delete from mail_view_matches where view_id = $1`, [v.id]);
      await db.query(`update mail_accounts set sync_cursor = '{}'::jsonb where id = $1`, [a.id]);
      await app.mail.syncAccount(a.id);
      await purgeOrphanMails(a.id);
    }
    await audit(db, { orgId: user.orgId, projectId: v.project_id, userId: user.id, action: 'mail_view.update', objectType: 'mail_view', objectId: v.id, details: b });
    const full = await loadView(v.id);
    return { view: mapView(full, await getViewRights(db, v.id, user, await getMembership(db, v.project_id, user.id))) };
  });

  app.delete<{ Params: { vid: string } }>('/mail/views/:vid', async (req) => {
    const user = requireUser(req);
    const v = await loadView(req.params.vid);
    if (!v) throw notFound('Ansicht nicht gefunden');
    const a = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [v.account_id]);
    if (!(await canManageAccount(user, a))) throw forbidden();
    await db.query(`delete from mail_views where id = $1`, [v.id]);
    await purgeOrphanMails(a.id);
    await audit(db, { orgId: user.orgId, projectId: v.project_id, userId: user.id, action: 'mail_view.delete', objectType: 'mail_view', objectId: v.id, details: { name: v.name } });
    return { ok: true };
  });

  /** Mails ohne Ansicht verschwinden; Kopien in Aufgaben bleiben. */
  async function purgeOrphanMails(accountId: string) {
    await db.query(
      `delete from mails m where m.account_id = $1 and not m.outgoing
         and not exists (select 1 from mail_view_matches x where x.mail_id = m.id)
         and not exists (select 1 from mail_task_links l where l.mail_id = m.id and l.copied)`,
      [accountId]
    );
  }

  app.get<{ Params: { vid: string } }>('/mail/views/:vid/rights', async (req) => {
    const user = requireUser(req);
    const v = await loadView(req.params.vid);
    if (!v) throw notFound('Ansicht nicht gefunden');
    const a = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [v.account_id]);
    if (!(await canManageAccount(user, a))) throw forbidden();
    const rows = await db.query(`select r.*, u.name as user_name, g.name as group_name from mail_view_rights r left join users u on u.id = r.user_id left join groups g on g.id = r.group_id where r.view_id = $1`, [v.id]);
    return { rights: rows.rows.map(mapRight) };
  });

  app.put<{ Params: { vid: string }; Body: { rights: { userId?: string | null; role?: ProjectRole | null; groupId?: string | null; canRead?: boolean; canDraft?: boolean; canSend?: boolean; canAi?: boolean; canCreateTask?: boolean }[] } }>('/mail/views/:vid/rights', async (req) => {
    const user = requireUser(req);
    const v = await loadView(req.params.vid);
    if (!v) throw notFound('Ansicht nicht gefunden');
    const a = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [v.account_id]);
    if (!(await canManageAccount(user, a))) throw forbidden();
    await db.query(`delete from mail_view_rights where view_id = $1`, [v.id]);
    for (const r of req.body?.rights ?? []) {
      if (!r.userId && !r.role && !r.groupId) continue;
      if (r.groupId && !(await db.maybeOne(`select 1 from groups where id = $1 and org_id = $2`, [r.groupId, user.orgId]))) continue;
      await db.query(
        `insert into mail_view_rights (view_id, user_id, role, group_id, can_read, can_draft, can_send, can_ai, can_create_task) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [v.id, r.userId ?? null, r.userId || r.groupId ? null : r.role, r.userId ? null : r.groupId ?? null, r.canRead ?? true, Boolean(r.canDraft), Boolean(r.canSend) && a.type === 'project', Boolean(r.canAi), Boolean(r.canCreateTask)]
      );
    }
    await audit(db, { orgId: user.orgId, projectId: v.project_id, userId: user.id, action: 'mail_view.rights', objectType: 'mail_view', objectId: v.id, details: { rights: req.body?.rights } });
    const rows = await db.query(`select r.*, u.name as user_name, g.name as group_name from mail_view_rights r left join users u on u.id = r.user_id left join groups g on g.id = r.group_id where r.view_id = $1`, [v.id]);
    return { rights: rows.rows.map(mapRight) };
  });

  // Mails einer Ansicht
  app.get<{ Params: { vid: string }; Querystring: { folder?: string } }>('/mail/views/:vid/mails', async (req) => {
    const user = requireUser(req);
    const v = await loadView(req.params.vid);
    if (!v) throw notFound('Ansicht nicht gefunden');
    const m = await getMembership(db, v.project_id, user.id);
    const rights = await getViewRights(db, v.id, user, m);
    if (!rights.canRead) throw forbidden('Kein Leserecht an dieser Ansicht');
    const rows = await db.query(
      `select m.*, ${LINKED} from mails m join mail_view_matches x on x.mail_id = m.id where x.view_id = $1 ${req.query.folder ? 'and lower(m.folder) = lower($2)' : ''} order by m.date desc limit 500`,
      req.query.folder ? [v.id, req.query.folder] : [v.id]
    );
    return { view: mapView(v, rights), mails: rows.rows.map(mapSummary) };
  });

  // Gemeinsames Postfach: alle Mails aus Ansichten mit Leserecht, über alle aktiven Projekte
  app.get<{ Querystring: { folder?: string; projectId?: string } }>('/mail/inbox', async (req) => {
    const user = requireUser(req);
    const views = await db.query(
      `select v.id, v.name, v.project_id, p.key as project_key from mail_views v join projects p on p.id = v.project_id
       where p.org_id = $1 and p.status = 'active' ${req.query.projectId ? 'and p.id = $2' : ''}`,
      req.query.projectId ? [user.orgId, req.query.projectId] : [user.orgId]
    );
    const readable: { id: string; name: string; projectId: string; projectKey: string }[] = [];
    for (const v of views.rows) {
      const m = await getMembership(db, v.project_id, user.id);
      const r = await getViewRights(db, v.id, user, m);
      if (r.canRead) readable.push({ id: v.id, name: v.name, projectId: v.project_id, projectKey: v.project_key });
    }
    if (readable.length === 0) return { mails: [], views: [] };
    const ids = readable.map((v) => v.id);
    const rows = await db.query(
      `select distinct on (m.id) m.*, x.view_id, ${LINKED} from mails m join mail_view_matches x on x.mail_id = m.id
       where x.view_id = any($1::uuid[]) ${req.query.folder ? 'and lower(m.folder) = lower($2)' : ''} order by m.id, x.view_id`,
      req.query.folder ? [ids, req.query.folder] : [ids]
    );
    const byView = new Map(readable.map((v) => [v.id, v]));
    const mails = rows.rows
      .map((r: any) => { const v = byView.get(r.view_id)!; return { ...mapSummary(r), projectId: v.projectId, projectKey: v.projectKey, viewId: v.id, viewName: v.name }; })
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 500);
    return { mails, views: readable };
  });

  app.get<{ Params: { mid: string } }>('/mail/mails/:mid', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select m.*, ${LINKED} from mails m where m.id = $1`, [req.params.mid]);
    if (!r) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, r.id);
    if (!access.ok) throw forbidden('Verknüpfte Mail, keine Berechtigung');
    const links = await db.query(`select l.*, t.title, t.project_id from mail_task_links l join tasks t on t.id = l.task_id where l.mail_id = $1`, [r.id]);
    return {
      mail: { ...mapSummary(r), ccJson: r.cc_json ?? [], textBody: r.text_body, htmlBody: r.html_body, inReplyTo: r.in_reply_to },
      rights: access.rights,
      links: links.rows.map((l: any) => ({ taskId: l.task_id, title: l.title, projectId: l.project_id, copied: l.copied }))
    };
  });

  // Mail ↔ Aufgabe: verknüpfen oder kopieren
  app.post<{ Params: { mid: string }; Body: { taskId: string; copy?: boolean; confirmed?: boolean } }>('/mail/mails/:mid/link', async (req) => {
    const user = requireUser(req);
    const mail = await db.maybeOne(`select m.*, a.type as account_type, a.owner_user_id from mails m join mail_accounts a on a.id = m.account_id where m.id = $1`, [req.params.mid]);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok || !access.rights.canCreateTask) throw forbidden('Erfordert das Recht „Aufgabe erzeugen“ an der Ansicht');
    const task = await db.maybeOne(`select * from tasks where id = $1`, [req.body?.taskId]);
    if (!task) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, task.project_id, 'member');
    const copy = Boolean(req.body?.copy);
    if (copy) {
      if (mail.account_type === 'personal' && mail.owner_user_id !== user.id) throw forbidden('Aus persönlichen Konten kopiert nur der Eigentümer');
      const members = await db.query(`select u.name, m.role from project_members m join users u on u.id = m.user_id where m.project_id = $1 order by u.name`, [task.project_id]);
      if (!req.body?.confirmed) {
        return { needsConfirmation: true, willSee: members.rows.map((x: any) => ({ name: x.name, role: x.role })) };
      }
    }
    await db.query(
      `insert into mail_task_links (mail_id, task_id, copied, linked_by) values ($1,$2,$3,$4) on conflict (mail_id, task_id) do update set copied = mail_task_links.copied or excluded.copied`,
      [mail.id, task.id, copy, user.id]
    );
    await audit(db, { orgId: user.orgId, projectId: task.project_id, userId: user.id, action: copy ? 'mail.copy_to_task' : 'mail.link_task', objectType: 'mail', objectId: mail.id, details: { taskId: task.id, subject: mail.subject, viewIds: access.viewIds } });
    return { ok: true };
  });

  // W3: Mail → Aufgabe (vorbefüllt, ohne KI)
  app.post<{ Params: { mid: string }; Body: { projectId: string; title?: string; subprojectId?: string | null; dueDate?: string | null; responsibleUserId?: string | null; responsibleEmail?: string | null; copy?: boolean } }>('/mail/mails/:mid/create-task', async (req) => {
    const user = requireUser(req);
    const mail = await db.maybeOne(`select m.*, a.type as account_type, a.owner_user_id from mails m join mail_accounts a on a.id = m.account_id where m.id = $1`, [req.params.mid]);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok || !access.rights.canCreateTask) throw forbidden('Erfordert das Recht „Aufgabe erzeugen“ an der Ansicht');
    const b = req.body ?? ({} as any);
    await requireProject(db, user, b.projectId, 'member');
    const col = await db.one(`select id from board_columns where project_id = $1 order by position limit 1`, [b.projectId]);
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1`, [col.id]);
    const desc = `Aus Mail von ${mail.from_name ?? mail.from_addr} (${new Date(mail.date).toLocaleDateString('de-DE')}):\n\n${(mail.text_body ?? mail.snippet ?? '').slice(0, 4000)}`;
    const t = await db.one(
      `insert into tasks (project_id, subproject_id, column_id, title, description, due_date, responsible_user_id, responsible_email, position, mail_code, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [b.projectId, b.subprojectId ?? null, col.id, (b.title ?? mail.subject ?? 'Neue Aufgabe').slice(0, 200), desc, b.dueDate ?? null, b.responsibleUserId ?? null, b.responsibleEmail ?? null, pos.p, newMailCode(), user.id]
    );
    const copy = Boolean(b.copy) && !(mail.account_type === 'personal' && mail.owner_user_id !== user.id);
    await db.query(`insert into mail_task_links (mail_id, task_id, copied, linked_by) values ($1,$2,$3,$4)`, [mail.id, t.id, copy, user.id]);
    await audit(db, { orgId: user.orgId, projectId: b.projectId, userId: user.id, action: 'task.create_from_mail', objectType: 'task', objectId: t.id, details: { mailId: mail.id, subject: mail.subject, copied: copy } });
    return { task: await loadTask(db, t.id) };
  });

  // Mail → Aufgaben-Log (1:1-Zitat als Log-Eintrag, ohne KI)
  app.post<{ Params: { mid: string }; Body: { taskId: string; note?: string } }>('/mail/mails/:mid/to-task-log', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok) throw forbidden('Kein Leserecht an dieser Mail');
    const task = await db.maybeOne(`select * from tasks where id = $1`, [req.body?.taskId]);
    if (!task) throw notFound('Aufgabe nicht gefunden');
    await requireProject(db, user, task.project_id, 'member');
    const body = (req.body?.note?.trim() ? req.body.note.trim() + '\n\n' : '') + mailToLogEntry(mail);
    const c = await db.one(`insert into task_comments (task_id, user_id, body, source, mail_id) values ($1,$2,$3,'mail',$4) returning *`, [task.id, user.id, body, mail.id]);
    await db.query(`insert into mail_task_links (mail_id, task_id, copied, linked_by) values ($1,$2,false,$3) on conflict do nothing`, [mail.id, task.id, user.id]);
    await audit(db, { orgId: user.orgId, projectId: task.project_id, userId: user.id, action: 'mail.to_task_log', objectType: 'task', objectId: task.id, details: { mailId: mail.id, subject: mail.subject } });
    return { comment: { id: c.id, taskId: c.task_id, userId: c.user_id, userName: user.name, body: c.body, source: c.source, mailId: c.mail_id, createdAt: c.created_at } };
  });

  // Mail → Doku: als eigene Seite ablegen (1:1). Inhalt wird für alle Projektmitglieder sichtbar → Bestätigung.
  app.post<{ Params: { mid: string }; Body: { projectId: string; folderId?: string | null; parentPageId?: string | null; title?: string; confirmed?: boolean } }>('/mail/mails/:mid/to-page', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok) throw forbidden('Kein Leserecht an dieser Mail');
    if (mail.account_type === 'personal' && mail.owner_user_id !== user.id) throw forbidden('Aus persönlichen Konten legt nur der Eigentümer ab');
    const b = req.body ?? ({} as any);
    await requireProject(db, user, b.projectId, 'member');
    if (!b.confirmed) {
      const members = await db.query(`select u.name, m.role from project_members m join users u on u.id = m.user_id where m.project_id = $1 order by u.name`, [b.projectId]);
      return { needsConfirmation: true, willSee: members.rows.map((x: any) => ({ name: x.name, role: x.role })) };
    }
    if (b.folderId) {
      const f = await db.maybeOne(`select id from doc_folders where id = $1 and project_id = $2`, [b.folderId, b.projectId]);
      if (!f) throw badRequest('Ordner gehört nicht zum Projekt');
    }
    const title = (b.title?.trim() || `Mail: ${mail.subject || '(kein Betreff)'}`).slice(0, 200);
    const md = mailToMarkdown(mail, { heading: 1 });
    const html = mdToHtml(md);
    const page = await db.one(
      `insert into doc_pages (project_id, folder_id, parent_page_id, title, content_md, content_html, status, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,'draft',$7,$7) returning *`,
      [b.projectId, b.folderId ?? null, b.parentPageId ?? null, title, md, html, user.id]
    );
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,1,$2,$3,$4,'draft',$5)`, [page.id, page.title, page.content_md, page.content_html, user.id]);
    await db.query(`insert into mail_page_links (mail_id, page_id, kind, linked_by) values ($1,$2,'page',$3)`, [mail.id, page.id, user.id]);
    await audit(db, { orgId: user.orgId, projectId: b.projectId, userId: user.id, action: 'mail.copy_to_page', objectType: 'doc_page', objectId: page.id, details: { mailId: mail.id, subject: mail.subject, viewIds: access.viewIds } });
    return { page: mapPage(page) };
  });

  // Mail → Doku: an bestehende Seite anhängen (1:1-Abschnitt, z. B. unter ein Protokoll oder einen Report)
  app.post<{ Params: { mid: string }; Body: { pageId: string; confirmed?: boolean; withBody?: boolean } }>('/mail/mails/:mid/append-to-page', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok) throw forbidden('Kein Leserecht an dieser Mail');
    if (mail.account_type === 'personal' && mail.owner_user_id !== user.id) throw forbidden('Aus persönlichen Konten legt nur der Eigentümer ab');
    const page = await db.maybeOne(`select * from doc_pages where id = $1`, [req.body?.pageId]);
    if (!page) throw notFound('Seite nicht gefunden');
    await requireProject(db, user, page.project_id, 'member');
    if (page.status === 'final') throw badRequest('Finale Seite ist gesperrt. Erst wieder öffnen.');
    if (!req.body?.confirmed) {
      const members = await db.query(`select u.name, m.role from project_members m join users u on u.id = m.user_id where m.project_id = $1 order by u.name`, [page.project_id]);
      return { needsConfirmation: true, willSee: members.rows.map((x: any) => ({ name: x.name, role: x.role })) };
    }
    const section = mailToMarkdown(mail, { heading: 2, withBody: req.body?.withBody !== false });
    const html = `${(page.content_html ?? mdToHtml(page.content_md)).replace(/\s+$/, '')}\n${mdToHtml(section)}`;
    const u = await db.one(`update doc_pages set content_html = $2, content_md = $3, version = version + 1, updated_by = $4, updated_at = now() where id = $1 returning *`, [page.id, html, htmlToMd(html), user.id]);
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,$2,$3,$4,$5,$6,$7)`, [u.id, u.version, u.title, u.content_md, u.content_html, u.status, user.id]);
    await db.query(`insert into mail_page_links (mail_id, page_id, kind, linked_by) values ($1,$2,'section',$3) on conflict do nothing`, [mail.id, page.id, user.id]);
    await audit(db, { orgId: user.orgId, projectId: page.project_id, userId: user.id, action: 'mail.append_to_page', objectType: 'doc_page', objectId: page.id, details: { mailId: mail.id, subject: mail.subject, version: u.version } });
    return { page: mapPage(u) };
  });

  // Aktionskatalog je Mail: regelbasierte Aktionen sofort, KI-Aktionen als Platzhalter
  app.get<{ Params: { mid: string } }>('/mail/mails/:mid/actions', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok) throw forbidden();
    const canCopy = !(mail.account_type === 'personal' && mail.owner_user_id !== user.id);
    const pages = await db.query(`select l.page_id, l.kind, p.title, p.project_id from mail_page_links l join doc_pages p on p.id = l.page_id where l.mail_id = $1`, [mail.id]);
    return {
      rule: [
        { key: 'link_task', target: 'task', label: 'Mit Aufgabe verknüpfen', enabled: access.rights.canCreateTask },
        { key: 'copy_task', target: 'task', label: 'In Aufgabe kopieren', enabled: access.rights.canCreateTask && canCopy },
        { key: 'task_log', target: 'task', label: 'Ins Aufgaben-Log übernehmen', enabled: true },
        { key: 'task_adjust', target: 'task', label: 'Aufgabe anpassen (Mail als Beleg)', enabled: true },
        { key: 'create_task', target: 'task', label: 'Aufgabe erstellen', enabled: access.rights.canCreateTask },
        { key: 'to_page', target: 'doc', label: 'In Doku ablegen (eigene Seite)', enabled: canCopy },
        { key: 'append_page', target: 'doc', label: 'An Seite anhängen (Protokoll, Report)', enabled: canCopy }
      ],
      ai: AI_ACTIONS.map((a) => ({ ...a, enabled: false, reason: 'KI ist das letzte Modul; läuft später als Vorschlag in der Freigabe-Liste.' })),
      pages: pages.rows.map((p: any) => ({ pageId: p.page_id, kind: p.kind, title: p.title, projectId: p.project_id }))
    };
  });

  // W4: Entwürfe und Versand
  app.get<{ Params: { id: string } }>('/projects/:id/mail/drafts', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    const rows = await db.query(
      `select d.*, u.name as user_name from mail_drafts d join users u on u.id = d.user_id where d.project_id = $1 order by d.created_at desc limit 200`,
      [req.params.id]
    );
    const out: MailDraft[] = [];
    for (const d of rows.rows) {
      if (d.user_id === user.id) { out.push(mapDraft(d)); continue; }
      if (d.view_id) {
        const r = await getViewRights(db, d.view_id, user, m);
        if (r.canSend) out.push(mapDraft(d));
      } else if (m.role === 'pl') out.push(mapDraft(d));
    }
    return { drafts: out };
  });

  app.post<{ Body: { viewId?: string; accountId?: string; projectId: string; taskId?: string | null; to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string | null; references?: string | null; send?: boolean } }>('/mail/drafts', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? ({} as any);
    if (!b.projectId || !Array.isArray(b.to) || b.to.length === 0 || !b.subject) throw badRequest('Projekt, Empfänger und Betreff erforderlich');
    const m = await requireProject(db, user, b.projectId, 'member');
    let account: AccountRow | null = null;
    let rights: MailViewRights;
    if (b.viewId) {
      const v = await loadView(b.viewId);
      if (!v || v.project_id !== b.projectId) throw notFound('Ansicht nicht gefunden');
      account = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [v.account_id]);
      rights = await getViewRights(db, v.id, user, m);
    } else if (b.accountId) {
      account = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1 and org_id = $2`, [b.accountId, user.orgId]);
      if (!account) throw notFound('Konto nicht gefunden');
      const manage = await canManageAccount(user, account);
      rights = manage ? ALL_RIGHTS : { canRead: false, canDraft: false, canSend: false, canAi: false, canCreateTask: false };
    } else throw badRequest('viewId oder accountId erforderlich');
    if (!rights.canDraft && !rights.canSend) throw forbidden('Kein Entwurfsrecht an dieser Ansicht');
    if (b.taskId) {
      const t = await db.maybeOne(`select project_id from tasks where id = $1`, [b.taskId]);
      if (!t || t.project_id !== b.projectId) throw badRequest('Aufgabe gehört nicht zum Projekt');
    }
    const d = await db.one(
      `insert into mail_drafts (account_id, view_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, in_reply_to, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft') returning *`,
      [account!.id, b.viewId ?? null, b.taskId ?? null, b.projectId, user.id, JSON.stringify(b.to), JSON.stringify(b.cc ?? []), b.subject, b.body ?? '', b.inReplyTo ?? null]
    );
    if (b.send) {
      if (rights.canSend) {
        await doSend(d.id, user, account!, b.references ?? null);
      } else {
        await db.query(`update mail_drafts set status = 'pending_approval', updated_at = now() where id = $1`, [d.id]);
        await audit(db, { orgId: user.orgId, projectId: b.projectId, userId: user.id, action: 'mail.draft_submitted', objectType: 'mail_draft', objectId: d.id, details: { to: b.to, subject: b.subject } });
        await notifyApprovers(b.viewId ?? null, b.projectId, user, b.subject);
      }
    }
    const row = await db.one(`select d.*, u.name as user_name from mail_drafts d join users u on u.id = d.user_id where d.id = $1`, [d.id]);
    return { draft: mapDraft(row) };
  });

  app.patch<{ Params: { did: string }; Body: { to?: string[]; cc?: string[]; subject?: string; body?: string } }>('/mail/drafts/:did', async (req) => {
    const user = requireUser(req);
    const d = await db.maybeOne(`select * from mail_drafts where id = $1`, [req.params.did]);
    if (!d) throw notFound('Entwurf nicht gefunden');
    if (d.status === 'sent') throw badRequest('Bereits gesendet');
    const m = await requireProject(db, user, d.project_id, 'member');
    let allowed = d.user_id === user.id;
    if (!allowed && d.view_id) allowed = (await getViewRights(db, d.view_id, user, m)).canSend;
    if (!allowed) throw forbidden();
    const b = req.body ?? {};
    await db.query(
      `update mail_drafts set to_addrs = coalesce($2::jsonb, to_addrs), cc_addrs = coalesce($3::jsonb, cc_addrs), subject = coalesce($4, subject), body = coalesce($5, body), updated_at = now() where id = $1`,
      [d.id, b.to ? JSON.stringify(b.to) : null, b.cc ? JSON.stringify(b.cc) : null, b.subject ?? null, b.body ?? null]
    );
    const row = await db.one(`select d.*, u.name as user_name from mail_drafts d join users u on u.id = d.user_id where d.id = $1`, [d.id]);
    return { draft: mapDraft(row) };
  });

  app.post<{ Params: { did: string } }>('/mail/drafts/:did/send', async (req) => {
    const user = requireUser(req);
    const d = await db.maybeOne(`select * from mail_drafts where id = $1`, [req.params.did]);
    if (!d) throw notFound('Entwurf nicht gefunden');
    if (d.status === 'sent') throw badRequest('Bereits gesendet');
    const m = await requireProject(db, user, d.project_id, 'member');
    const account = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [d.account_id]);
    const rights = d.view_id ? await getViewRights(db, d.view_id, user, m) : (await canManageAccount(user, account)) ? ALL_RIGHTS : null;
    if (!rights?.canSend) {
      if (d.user_id === user.id && rights?.canDraft) {
        await db.query(`update mail_drafts set status = 'pending_approval', updated_at = now() where id = $1`, [d.id]);
        const row = await db.one(`select d.*, u.name as user_name from mail_drafts d join users u on u.id = d.user_id where d.id = $1`, [d.id]);
        return { draft: mapDraft(row), submitted: true };
      }
      throw forbidden('Kein Senderecht an dieser Ansicht');
    }
    await doSend(d.id, user, account, null);
    const row = await db.one(`select d.*, u.name as user_name from mail_drafts d join users u on u.id = d.user_id where d.id = $1`, [d.id]);
    return { draft: mapDraft(row) };
  });

  app.delete<{ Params: { did: string } }>('/mail/drafts/:did', async (req) => {
    const user = requireUser(req);
    const d = await db.maybeOne(`select * from mail_drafts where id = $1`, [req.params.did]);
    if (!d) throw notFound('Entwurf nicht gefunden');
    const m = await requireProject(db, user, d.project_id, 'member');
    let allowed = d.user_id === user.id;
    if (!allowed && d.view_id) allowed = (await getViewRights(db, d.view_id, user, m)).canSend;
    if (!allowed) throw forbidden();
    await db.query(`delete from mail_drafts where id = $1`, [d.id]);
    await audit(db, { orgId: user.orgId, projectId: d.project_id, userId: user.id, action: 'mail.draft_rejected', objectType: 'mail_draft', objectId: d.id, details: { subject: d.subject, by: user.id === d.user_id ? 'author' : 'approver' } });
    return { ok: true };
  });

  /** Wer an der Ansicht senden darf, erfährt von wartenden Entwürfen. */
  async function notifyApprovers(viewId: string | null, projectId: string, author: User, subject: string) {
    const members = await db.query(`select user_id, role from project_members where project_id = $1`, [projectId]);
    const targets: string[] = [];
    for (const m of members.rows) {
      if (!viewId) { if (m.role === 'pl') targets.push(m.user_id); continue; }
      const u = await db.maybeOne(`select id from users where id = $1`, [m.user_id]);
      const r = await getViewRights(db, viewId, { ...author, id: m.user_id, orgId: author.orgId } as User, { ...(await getMembership(db, projectId, m.user_id))! });
      if (u && r.canSend) targets.push(m.user_id);
    }
    await notifyMany(db, targets, { projectId, type: 'mail.approval', title: `Freigabe wartet: ${subject}`, body: `Entwurf von ${author.name}`, link: `/projekte/${projectId}/mail/freigaben` }, author.id);
  }

  async function doSend(draftId: string, user: User, account: AccountRow, references: string | null) {
    const d = await db.one(`select * from mail_drafts where id = $1`, [draftId]);
    try {
      const res = await app.mail.sendFromAccount(account, {
        to: d.to_addrs, cc: d.cc_addrs, subject: d.subject, text: d.body, taskId: d.task_id, inReplyTo: d.in_reply_to, references, userId: user.id, projectId: d.project_id
      });
      await db.query(`update mail_drafts set status = 'sent', sent_at = now(), sent_by = $2, error = null, updated_at = now() where id = $1`, [draftId, user.id]);
      return res;
    } catch (e: any) {
      await db.query(`update mail_drafts set status = 'failed', error = $2, updated_at = now() where id = $1`, [draftId, String(e?.message ?? e)]);
      await audit(db, { orgId: user.orgId, projectId: d.project_id, userId: user.id, action: 'mail.send_failed', objectType: 'mail_draft', objectId: draftId, details: { error: String(e?.message ?? e) } });
      throw badRequest(`Versand fehlgeschlagen: ${e?.message ?? e}`);
    }
  }
}

function mapRight(r: any) {
  return { id: r.id, userId: r.user_id, userName: r.user_name, role: r.role, groupId: r.group_id ?? null, groupName: r.group_name ?? null, canRead: r.can_read, canDraft: r.can_draft, canSend: r.can_send, canAi: r.can_ai, canCreateTask: r.can_create_task };
}

function normalizeFilter(f?: MailViewFilter): MailViewFilter {
  const list = (v: unknown): string[] | undefined => {
    if (!v) return undefined;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const out = arr.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : undefined;
  };
  return { folders: list(f?.folders), from: list(f?.from), to: list(f?.to), subject: list(f?.subject), keyword: list(f?.keyword), since: f?.since || null };
}

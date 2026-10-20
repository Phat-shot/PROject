import type { FastifyInstance } from 'fastify';
import type { MailAccount, MailAiRun, MailDraft, MailSummary, MailView, MailViewFilter, MailViewRights, OutboundCheck, ProjectRole, User } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { ALL_RIGHTS, canSeeSubproject, effectiveMembership, getMembership, getViewRights, requireProject, requireTask, requireTaskRef } from '../rights.js';
import { assertResponsible, loadTask, newMailCode } from '../tasks/service.js';
import { aiConfigFor } from '../ai/client.js';
import { aiAllowed, aiError } from '../ai/policy.js';
import type { AccountRow } from '../mail/types.js';
import { AI_ACTIONS, loadMailRow, mailToLogEntry, mailToMarkdown } from '../mail/actions.js';
import { PERSONAL_MAIL_ONLY, accountAllowedInProject, mailAccess, mailAllowedInProject } from '../mail/access.js';
import { linkMailToTask } from '../mail/link.js';
import { aiFinalReply, finalReplyText, originMails, reSubject } from '../mail/origin.js';
import { decideProposals } from '../ai/mailAi.js';
import { seal } from '../secrets.js';
import { queueAgentRun, queueMailAi } from '../ai/agentEvents.js';
import { mapPage } from '../docs/service.js';
import { htmlToMd, mdToHtml } from '../docs/html.js';
import { dispatch, notifyMany } from '../notify.js';
import { checkHint } from '../outbound.js';
import { newShareToken } from '../docs/share.js';
import { pagePdf, storePagePdf } from '../docs/layout.js';
import { projectPolicy, SQL } from '../projectPolicy.js';

function mapAccount(r: any): MailAccount {
  return {
    id: r.id, type: r.type, name: r.name, address: r.address, provider: r.provider, ownerUserId: r.owner_user_id, projectId: r.project_id,
    imapHost: r.imap_host, imapPort: r.imap_port, imapUser: r.imap_user, imapSecure: r.imap_secure, smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpUser: r.smtp_user, smtpSecure: r.smtp_secure,
    hasImapPassword: Boolean(r.imap_password), hasSmtpPassword: Boolean(r.smtp_password), oauthProvider: r.oauth_provider ?? null, viewCount: r.view_count ?? 0,
    lastSyncAt: r.last_sync_at, syncError: r.sync_error
  };
}

function mapSummary(r: any): MailSummary {
  return {
    id: r.id, accountId: r.account_id, folder: r.folder, messageId: r.message_id, fromAddr: r.from_addr, fromName: r.from_name,
    toJson: r.to_json ?? [], subject: r.subject, date: r.date, snippet: r.snippet, hasAttachments: r.has_attachments, outgoing: Boolean(r.outgoing),
    linkedTaskIds: (typeof r.linked_task_ids === 'string' ? JSON.parse(r.linked_task_ids) : r.linked_task_ids) ?? []
  };
}

function mapDraft(r: any): MailDraft {
  const c = r.outbound;
  return {
    id: r.id, accountId: r.account_id, viewId: r.view_id, taskId: r.task_id, userId: r.user_id, userName: r.user_name ?? '',
    toAddrs: r.to_addrs ?? [], ccAddrs: r.cc_addrs ?? [], subject: r.subject, body: r.body, status: r.status, error: r.error, sentAt: r.sent_at, createdAt: r.created_at,
    pageId: r.page_id ?? null,
    outbound: c ? { checkId: c.id, channel: c.channel, audience: c.audience, result: c.result, findings: c.findings ?? [], withheld: c.withheld ?? [], decided: Boolean(c.decided_at) } : null
  };
}

/** Entwurf mit verfassender Person und letzter Außenprüfung. */
const DRAFT_SELECT = `select d.*, u.name as user_name, (select row_to_json(c) from outbound_checks c where c.mail_draft_id = d.id order by c.created_at desc limit 1) as outbound from mail_drafts d join users u on u.id = d.user_id`;

function mapCheck(r: any): OutboundCheck {
  return {
    id: r.id, projectId: r.project_id, taskId: r.task_id, taskRef: r.task_id && r.number ? `${r.key}-${r.number}` : null, taskTitle: r.task_title ?? null, channel: r.channel,
    recipients: r.recipients ?? [], audience: r.audience, result: r.result, findings: r.findings ?? [], withheld: r.withheld ?? [], mailDraftId: r.mail_draft_id,
    draft: r.mail_draft_id && r.subject !== null ? { subject: r.subject, body: r.body, toAddrs: r.to_addrs ?? [], ccAddrs: r.cc_addrs ?? [], userName: r.draft_user_name ?? '', status: r.draft_status, pageId: r.page_id ?? null, pageTitle: r.page_title ?? null } : null,
    decidedBy: r.decided_by_name ?? null, decidedAt: r.decided_at, createdAt: r.created_at
  };
}

const LINKED = `coalesce((select json_agg(l.task_id) from mail_task_links l where l.mail_id = m.id), '[]'::json) as linked_task_ids`;

export async function mailRoutes(app: FastifyInstance) {
  const db = app.db;

  /** Konto verwalten: persönlich der Eigentümer, Org-Postfach der Org-Admin, Projektkonto die PL und der Org-Admin (soweit projectPolicy.adminAccess.accounts). */
  async function canManageAccount(user: User, account: AccountRow): Promise<boolean> {
    if (account.type === 'personal') return account.owner_user_id === user.id;
    if (account.type === 'org') return user.globalRole === 'org_admin';
    const m = await getMembership(db, account.project_id!, user.id);
    if (m?.role === 'pl') return true;
    return user.globalRole === 'org_admin' && projectPolicy(await db.one(`select personal from projects where id = $1`, [account.project_id])).adminAccess.accounts;
  }

  async function loadView(viewId: string) {
    return db.maybeOne(
      `select v.*, a.name as account_name, a.address as account_address, a.type as account_type, a.owner_user_id, (select name from users where id = v.agent_user_id) as agent_name from mail_views v join mail_accounts a on a.id = v.account_id where v.id = $1`,
      [viewId]
    );
  }

  function mapView(v: any, rights: MailViewRights): MailView {
    return { id: v.id, accountId: v.account_id, accountName: v.account_name, accountAddress: v.account_address, accountType: v.account_type, projectId: v.project_id, name: v.name, filter: v.filter ?? {}, myRights: rights, aiProcess: Boolean(v.ai_process), agentUserId: v.agent_user_id ?? null, agentName: v.agent_name ?? null };
  }

  /** Darf der Benutzer diese Mail lesen? Über eine Ansicht mit Leserecht oder als Kopie in einer lesbaren Arbeitspaket. */
  const mailReadable = (user: User, mailId: string) => mailAccess(db, user, mailId);

  /**
   * Wer im Projekt sieht den Mailinhalt erst durch diese Aktion? Mitglieder ohne Leserecht an der Mail (Personen, ohne
   * den Handelnden). Aktionen, die Inhalt ins Projekt kopieren (Log-Zitat, Beschreibung, Kopie), fragen dann nach.
   */
  async function newlyExposed(projectId: string, mailId: string, actorId: string) {
    const members = await db.query(`select m.user_id, m.role, u.name from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.kind = 'person' and u.active and m.user_id <> $2 order by u.name`, [projectId, actorId]);
    const out: { name: string; role: string }[] = [];
    for (const m of members.rows) if (!(await mailAccess(db, { id: m.user_id } as User, mailId)).ok) out.push({ name: m.name, role: m.role });
    return out;
  }

  // Konten
  app.get('/mail/accounts', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select a.*, (select count(*)::int from mail_views v where v.account_id = a.id) as view_count from mail_accounts a
       where a.org_id = $1 and (a.owner_user_id = $2 or a.project_id in (select project_id from project_members where user_id = $2 and role = 'pl')
         or (a.type <> 'personal' and $3 and not exists (select 1 from projects p where p.id = a.project_id and ${SQL.isPersonal('p')}))) order by a.type, a.name`,
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
          b.imapHost ?? null, b.imapPort ?? null, b.imapUser ?? null, seal(b.imapPassword), b.imapSecure ?? true,
          b.smtpHost ?? null, b.smtpPort ?? null, b.smtpUser ?? null, seal(b.smtpPassword), b.smtpSecure ?? false]
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
      [a.id, b.name ?? null, b.address ? String(b.address).toLowerCase() : null, b.imapHost ?? null, b.imapPort ?? null, b.imapUser ?? null, seal(b.imapPassword) ?? '', b.imapSecure ?? null,
        b.smtpHost ?? null, b.smtpPort ?? null, b.smtpUser ?? null, seal(b.smtpPassword) ?? '', b.smtpSecure ?? null]
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
    if (cfg.provider === 'graph' || cfg.oauth_refresh_token) {
      // OAuth2-Konto: Token auffrischen und Ordner lesen; der Versand nutzt dasselbe Token
      try {
        const folders = await app.mail.provider(cfg).listFolders(cfg);
        return { imap: { ok: true, folders: folders.map((f) => f.name).slice(0, 30) }, smtp: { ok: true } };
      } catch (e: any) {
        return { imap: { ok: false, error: String(e?.message ?? e).slice(0, 300) }, smtp: { ok: false, error: 'OAuth2-Zugriff fehlgeschlagen, Konto neu verbinden' } };
      }
    }
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
      `select v.*, a.name as account_name, a.address as account_address, a.type as account_type, a.owner_user_id, (select name from users where id = v.agent_user_id) as agent_name from mail_views v join mail_accounts a on a.id = v.account_id where v.project_id = $1 order by a.type desc, v.name`,
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
    if (!(await accountAllowedInProject(db, a, req.params.id))) throw forbidden(PERSONAL_MAIL_ONLY);
    if (a.type === 'org' && !(await canManageAccount(user, a))) throw forbidden('Das Organisationspostfach teilt nur der Org-Admin');
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

  app.patch<{ Params: { vid: string }; Body: { name?: string; filter?: MailViewFilter; aiProcess?: boolean; agentUserId?: string | null } }>('/mail/views/:vid', async (req) => {
    const user = requireUser(req);
    const v = await loadView(req.params.vid);
    if (!v) throw notFound('Ansicht nicht gefunden');
    const a = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [v.account_id]);
    const b = req.body ?? {};
    // Nur Mail-KI: entscheidet setViewAi (Eigentümer bzw. PL des Projekts, auch bei Organisationskonten); sonst Kontoverwaltung
    const aiOnly = Object.keys(b).length > 0 && Object.keys(b).every((k) => k === 'aiProcess' || k === 'agentUserId');
    if (!aiOnly && !(await canManageAccount(user, a))) throw forbidden();
    if ('aiProcess' in b || 'agentUserId' in b) await setViewAi(user, v, a, b);
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

  /**
   * Mail-KI an einer Ansicht: einschalten darf, wer sie inhaltlich verantwortet (persönliches Konto: Eigentümer;
   * Projekt-/Organisationskonto: PL des Projekts, nicht der Org-Admin allein). Die Projekt-KI handelt dann im Auftrag
   * dieser Person (KI-Freigabe mail.process: „KI nutzen“, Rechte „KI“ und „Arbeitspaket erzeugen“ an der Ansicht);
   * der Agent muss Mitglied des Projekts und für mail.triage freigegeben sein.
   */
  async function setViewAi(user: User, v: any, a: AccountRow, b: { aiProcess?: boolean; agentUserId?: string | null }) {
    const m = await getMembership(db, v.project_id, user.id);
    const owner = a.type === 'personal' ? a.owner_user_id === user.id && Boolean(m) : m?.role === 'pl';
    if (!owner) throw forbidden(a.type === 'personal' ? 'Mail-KI am persönlichen Konto schaltet nur der Eigentümer (als Projektmitglied)' : 'Mail-KI an Projekt- und Organisationskonten schaltet die PL des Projekts');
    if (b.aiProcess) {
      const { cfg, decision } = await aiConfigFor(db, { userId: user.id, projectId: v.project_id, feature: 'mail.process', viewId: v.id, budget: false });
      if (!cfg) throw aiError(decision);
    }
    if (b.agentUserId && !(await db.maybeOne(`select 1 from project_members pm join users u on u.id = pm.user_id where pm.project_id = $1 and pm.user_id = $2 and u.kind = 'agent' and u.active`, [v.project_id, b.agentUserId]))) throw badRequest('Agent ist kein aktives Mitglied des Projekts');
    if (b.agentUserId) {
      const d = await aiAllowed(db, { userId: b.agentUserId, projectId: v.project_id, feature: 'mail.triage', budget: false });
      if (!d.allowed && !d.missing) throw aiError(d, true);
    }
    if ('aiProcess' in b) await db.query(`update mail_views set ai_process = $2, ai_process_by = case when $2 then $3::uuid else null end where id = $1`, [v.id, Boolean(b.aiProcess), user.id]);
    if ('agentUserId' in b) await db.query(`update mail_views set agent_user_id = $2 where id = $1`, [v.id, b.agentUserId || null]);
    await audit(db, { orgId: user.orgId, projectId: v.project_id, userId: user.id, action: 'mail_view.ai', objectType: 'mail_view', objectId: v.id, details: { aiProcess: b.aiProcess, agentUserId: b.agentUserId } });
  }

  // Ordner „KI Bearbeiten“ einrichten: Ordner im Konto, Ansicht darauf, Projekt-KI bearbeitet direkt im Auftrag der einrichtenden Person
  app.post<{ Params: { id: string }; Body: { accountId: string } }>('/projects/:id/mail/ai-folder', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    const a = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1 and org_id = $2`, [req.body?.accountId, user.orgId]);
    if (!a) throw notFound('Konto nicht gefunden');
    if (a.type === 'personal' ? a.owner_user_id !== user.id : !(a.type === 'project' && a.project_id === req.params.id && m.role === 'pl')) throw forbidden('Einrichten darf der Eigentümer des persönlichen Kontos oder die PL für das Projektkonto');
    // Die Ansicht entsteht mit den Rechten „KI“ und „Arbeitspaket erzeugen“ für die einrichtende Person
    const gate = await aiConfigFor(db, { userId: user.id, projectId: req.params.id, feature: 'mail.process', budget: false });
    if (!gate.cfg) throw aiError(gate.decision);
    const p = app.mail.providerFor(a);
    const list = await p.listFolders(a);
    const folder = list.find((f) => f.name.toLowerCase() === 'ki bearbeiten')?.path ?? (await p.createFolder(a, 'KI Bearbeiten')).path;
    const existing = await db.maybeOne(`select id from mail_views where project_id = $1 and account_id = $2 and filter->'folders' = $3::jsonb`, [req.params.id, a.id, JSON.stringify([folder])]);
    const vid = existing?.id ?? (await db.one(`insert into mail_views (account_id, project_id, name, filter, created_by) values ($1,$2,'KI Bearbeiten',$3,$4) returning id`, [a.id, req.params.id, JSON.stringify(normalizeFilter({ folders: [folder] })), user.id])).id;
    if (!existing) await db.query(`insert into mail_view_rights (view_id, user_id, can_read, can_draft, can_send, can_ai, can_create_task) values ($1,$2,true,true,$3,true,true)`, [vid, user.id, a.type === 'project']);
    await db.query(`update mail_views set ai_process = true, ai_process_by = $2 where id = $1`, [vid, user.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'mail_view.ai_folder', objectType: 'mail_view', objectId: vid, details: { account: a.address, folder } });
    await app.mail.syncAccount(a.id);
    return { view: mapView(await loadView(vid), await getViewRights(db, vid, user, m)), folder };
  });

  // „KI bearbeiten“ an einer Mail: in den KI-Ordner des Kontos legen und sofort bearbeiten (im eigenen Auftrag)
  app.post<{ Params: { mid: string }; Body: { projectId: string } }>('/mail/mails/:mid/ai-process', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok || !access.rights.canCreateTask) throw forbidden('Erfordert das Recht „Arbeitspaket erzeugen“ an der Ansicht');
    if (mail.outgoing) throw badRequest('Gesendete Mails bearbeitet die KI nicht');
    const m = await requireProject(db, user, req.body?.projectId, 'member');
    if (!(await mailAllowedInProject(db, mail.id, m.projectId))) throw forbidden(PERSONAL_MAIL_ONLY);
    const v = await db.maybeOne(`select * from mail_views where project_id = $1 and account_id = $2 and ai_process order by created_at limit 1`, [m.projectId, mail.account_id]);
    if (!v) throw badRequest('Für dieses Konto gibt es im Projekt keinen Ordner „KI Bearbeiten“ (Einstellungen › Mail)');
    const rights = await getViewRights(db, v.id, user, m);
    if (!rights.canCreateTask || !(rights.canDraft || rights.canSend)) throw forbidden('Erfordert an der KI-Ansicht die Rechte „Arbeitspaket erzeugen“ und Entwurf');
    if (mail.account_type === 'personal' && mail.owner_user_id !== user.id) throw forbidden('Mails aus persönlichen Konten gibt nur der Eigentümer an die KI');
    // Freigabe jetzt; das Tagesbudget hält den Lauf nur zurück
    const gate = await aiConfigFor(db, { userId: user.id, projectId: m.projectId, feature: 'mail.process', viewId: v.id, budget: false });
    if (!gate.cfg) throw aiError(gate.decision);
    const target = (v.filter?.folders ?? [])[0];
    if (target && String(mail.folder).toLowerCase() !== String(target).toLowerCase()) {
      const account = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [mail.account_id]);
      const moved = await app.mail.providerFor(account).move(account, { folder: mail.folder, uid: mail.uid }, target);
      await db.query(`update mails set folder = $2, uid = coalesce($3, uid) where id = $1`, [mail.id, target, moved.uid]);
    }
    await db.query(`insert into mail_view_matches (mail_id, view_id) values ($1,$2) on conflict do nothing`, [mail.id, v.id]);
    const run = await db.maybeOne(`insert into mail_ai_runs (org_id, project_id, view_id, mail_id, mode, actor_user_id) values ($1,$2,$3,$4,'process',$5) on conflict do nothing returning id`, [user.orgId, m.projectId, v.id, mail.id, user.id]);
    if (!run) throw badRequest('Diese Mail hat die KI im Projekt schon bearbeitet');
    await audit(db, { orgId: user.orgId, projectId: m.projectId, userId: user.id, action: 'mail.ai_request', objectType: 'mail', objectId: mail.id, details: { runId: run.id } });
    queueMailAi(run.id);
    return { runId: run.id };
  });

  /** Läufe der Mail-KI für Ausgabe: nur in Projekten, in denen man Mitglied ist, und zu Mails, die man lesen darf. */
  async function mapAiRuns(user: User, rows: any[]): Promise<MailAiRun[]> {
    const out: MailAiRun[] = [];
    const readable = new Map<string, boolean>();
    for (const r of rows) {
      if (!(await getMembership(db, r.project_id, user.id))) continue;
      if (!readable.has(r.mail_id)) readable.set(r.mail_id, (await mailReadable(user, r.mail_id)).ok);
      if (!readable.get(r.mail_id)) continue;
      out.push({ id: r.id, mode: r.mode, status: r.status, summary: r.summary, error: r.error, agentName: r.agent_name ?? null, actorName: r.actor_name ?? null, createdAt: r.created_at, actions: r.actions ?? [],
        ...(r.subject !== undefined ? { mail: { id: r.mail_id, subject: r.subject, fromAddr: r.from_addr, fromName: r.from_name, date: r.date } } : {}) });
    }
    return out;
  }
  const AI_RUN_SELECT = `select r.*, ua.name as agent_name, uc.name as actor_name from mail_ai_runs r left join users ua on ua.id = r.agent_user_id left join users uc on uc.id = r.actor_user_id`;
  app.get<{ Params: { mid: string } }>('/mail/mails/:mid/ai', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(`${AI_RUN_SELECT} where r.mail_id = $1 order by r.created_at desc`, [req.params.mid]);
    return { runs: await mapAiRuns(user, rows.rows) };
  });
  app.get<{ Params: { id: string } }>('/projects/:id/mail-ai', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const rows = await db.query(`select r.*, ua.name as agent_name, uc.name as actor_name, m.subject, m.from_addr, m.from_name, m.date from mail_ai_runs r join mails m on m.id = r.mail_id left join users ua on ua.id = r.agent_user_id left join users uc on uc.id = r.actor_user_id
      where r.project_id = $1 order by (r.mode = 'triage' and exists (select 1 from jsonb_array_elements(r.actions) x where x->>'status' = 'pending')) desc, r.created_at desc limit 60`, [req.params.id]);
    return { runs: await mapAiRuns(user, rows.rows) };
  });
  app.post<{ Params: { id: string }; Body: { index: number | 'all'; approve: boolean } }>('/mail/ai-runs/:id/decide', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select * from mail_ai_runs where id = $1 and mode = 'triage'`, [req.params.id]);
    if (!r) throw notFound('Vorschläge nicht gefunden');
    await requireProject(db, user, r.project_id, 'member');
    if (!(await mailReadable(user, r.mail_id)).ok) throw forbidden('Kein Leserecht an dieser Mail');
    const index = req.body?.index === 'all' ? 'all' : Number(req.body?.index);
    if (index !== 'all' && !Number.isInteger(index)) throw badRequest('index: Nummer oder all');
    await decideProposals(db, app.mail, r.id, user, index, Boolean(req.body?.approve));
    return { runs: await mapAiRuns(user, (await db.query(`${AI_RUN_SELECT} where r.id = $1`, [r.id])).rows) };
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

  /** Mails ohne Ansicht verschwinden; Kopien in Arbeitspaketen bleiben. */
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

  // Alle Ansichten mit Leserecht über alle aktiven Projekte (globales Postfach)
  app.get('/mail/views', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select v.*, a.name as account_name, a.address as account_address, a.type as account_type, a.owner_user_id, p.key as project_key, p.personal as project_personal
       from mail_views v join mail_accounts a on a.id = v.account_id join projects p on p.id = v.project_id where p.org_id = $1 and p.status = 'active' order by p.key, a.type desc, v.name`,
      [user.orgId]
    );
    const views: MailView[] = [];
    for (const v of rows.rows) {
      const m = await getMembership(db, v.project_id, user.id);
      const rights = await getViewRights(db, v.id, user, m);
      const manage = v.account_type === 'personal' ? v.owner_user_id === user.id : m?.role === 'pl' || (user.globalRole === 'org_admin' && projectPolicy({ personal: v.project_personal }).adminAccess.accounts);
      if (rights.canRead || manage) views.push({ ...mapView(v, rights), projectKey: v.project_key, canManage: manage });
    }
    return { views };
  });

  // Gemeinsames Postfach: alle Mails aus Ansichten mit Leserecht, über alle aktiven Projekte
  app.get<{ Querystring: { folder?: string; projectId?: string; viewId?: string } }>('/mail/inbox', async (req) => {
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
    const ids = readable.filter((v) => !req.query.viewId || v.id === req.query.viewId).map((v) => v.id);
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
    // Abgeleitete Arbeitspakete/Aufgaben (auch in anderen Projekten), nur soweit man sie sehen darf
    const linkRows = await db.query(`select l.*, t.title, t.number, t.project_id, t.subproject_id, t.parent_id, p.key, p.visibility from mail_task_links l join tasks t on t.id = l.task_id join projects p on p.id = t.project_id where l.mail_id = $1 and t.deleted_at is null and p.org_id = $2 order by l.origin desc, t.created_at`, [r.id, user.orgId]);
    const links: any[] = [];
    for (const l of linkRows.rows) if ((await effectiveMembership(db, user, l.project_id, l.visibility)) && (await canSeeSubproject(db, user.id, l.subproject_id))) links.push(l);
    return {
      mail: { ...mapSummary(r), ccJson: r.cc_json ?? [], textBody: r.text_body, htmlBody: r.html_body, inReplyTo: r.in_reply_to },
      rights: access.rights,
      viewIds: access.viewIds,
      canModify: await canModifyMail(user, r),
      links: links.map((l: any) => ({ taskId: l.task_id, title: l.title, code: `${l.key}-${l.number}`, projectId: l.project_id, copied: l.copied, origin: Boolean(l.origin), isSubtask: Boolean(l.parent_id) }))
    };
  });

  // ---- Ordner und Verschieben: Löschen = Papierkorb, Archivieren = Archiv, Unterordner anlegen
  /** Verschieben/Löschen darf, wer das Konto verwaltet oder an einer lesbaren Ansicht Entwurfs- oder Senderecht hat. */
  async function canModifyMail(user: User, mail: any): Promise<boolean> {
    const a = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [mail.account_id]);
    if (await canManageAccount(user, a)) return true;
    const access = await mailReadable(user, mail.id);
    return access.ok && (access.rights.canDraft || access.rights.canSend);
  }
  async function foldersOf(account: AccountRow) {
    const list = await app.mail.providerFor(account).listFolders(account);
    const known = await db.query(`select distinct folder from mails where account_id = $1`, [account.id]);
    for (const k of known.rows) if (!list.some((f) => f.path.toLowerCase() === String(k.folder).toLowerCase())) list.push({ path: k.folder, name: k.folder, specialUse: k.folder.toUpperCase() === 'INBOX' ? 'inbox' : k.folder.toLowerCase() === 'sent' ? 'sent' : null });
    return list;
  }
  async function specialFolder(account: AccountRow, kind: 'trash' | 'archive'): Promise<string> {
    const list = await foldersOf(account);
    const hit = list.find((f) => f.specialUse === kind);
    if (hit) return hit.path;
    const created = await app.mail.providerFor(account).createFolder(account, kind === 'trash' ? 'Trash' : 'Archive');
    return created.path;
  }
  async function moveMail(user: User, mailId: string, target: string, action: string) {
    const r = await db.maybeOne(`select * from mails where id = $1`, [mailId]);
    if (!r) throw notFound('Mail nicht gefunden');
    if (!(await canModifyMail(user, r))) throw forbidden('Verschieben erfordert Entwurfs- oder Senderecht an der Ansicht');
    const account = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [r.account_id]);
    if (r.folder.toLowerCase() === target.toLowerCase()) return { folder: r.folder };
    const moved = await app.mail.providerFor(account).move(account, { folder: r.folder, uid: r.uid }, target);
    await db.query(`update mails set folder = $2, uid = coalesce($3, uid) where id = $1`, [r.id, target, moved.uid]);
    const views = await db.query(`select project_id from mail_views v join mail_view_matches x on x.view_id = v.id where x.mail_id = $1 limit 1`, [r.id]);
    await audit(db, { orgId: user.orgId, projectId: views.rows[0]?.project_id ?? account.project_id, userId: user.id, action, objectType: 'mail', objectId: r.id, details: { from: r.folder, to: target } });
    return { folder: target };
  }

  app.get<{ Params: { id: string } }>('/mail/accounts/:id/folders', async (req) => {
    const user = requireUser(req);
    const a = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!a) throw notFound('Konto nicht gefunden');
    const readable = (await canManageAccount(user, a)) || (await db.maybeOne(`select 1 from mail_views v where v.account_id = $1 and exists (select 1 from project_members pm where pm.project_id = v.project_id and pm.user_id = $2)`, [a.id, user.id]));
    if (!readable) throw forbidden();
    return { folders: await foldersOf(a) };
  });
  app.post<{ Params: { id: string }; Body: { name: string; parent?: string | null } }>('/mail/accounts/:id/folders', async (req) => {
    const user = requireUser(req);
    const a = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!a) throw notFound('Konto nicht gefunden');
    if (!(await canManageAccount(user, a))) throw forbidden('Ordner legt an, wer das Konto verwaltet');
    const name = String(req.body?.name ?? '').trim().replace(/[\\/.]/g, '-');
    if (!name) throw badRequest('Ordnername erforderlich');
    const path = req.body?.parent ? `${req.body.parent}/${name}` : name;
    const folder = await app.mail.providerFor(a).createFolder(a, path);
    await audit(db, { orgId: user.orgId, projectId: a.project_id, userId: user.id, action: 'mail.folder_create', objectType: 'mail_account', objectId: a.id, details: { path: folder.path } });
    return { folder };
  });
  app.post<{ Params: { mid: string }; Body: { folder: string } }>('/mail/mails/:mid/move', async (req) => {
    const user = requireUser(req);
    if (!req.body?.folder) throw badRequest('Zielordner erforderlich');
    return moveMail(user, req.params.mid, req.body.folder, 'mail.move');
  });
  app.post<{ Params: { mid: string } }>('/mail/mails/:mid/archive', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select account_id from mails where id = $1`, [req.params.mid]);
    if (!r) throw notFound('Mail nicht gefunden');
    const a = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [r.account_id]);
    return moveMail(user, req.params.mid, await specialFolder(a, 'archive'), 'mail.archive');
  });
  app.post<{ Params: { mid: string } }>('/mail/mails/:mid/trash', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select account_id from mails where id = $1`, [req.params.mid]);
    if (!r) throw notFound('Mail nicht gefunden');
    const a = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [r.account_id]);
    return moveMail(user, req.params.mid, await specialFolder(a, 'trash'), 'mail.trash');
  });

  // Mail ↔ Arbeitspaket: verknüpfen oder kopieren
  app.post<{ Params: { mid: string }; Body: { taskId: string; copy?: boolean; confirmed?: boolean } }>('/mail/mails/:mid/link', async (req) => {
    const user = requireUser(req);
    const mail = await db.maybeOne(`select m.*, a.type as account_type, a.owner_user_id from mails m join mail_accounts a on a.id = m.account_id where m.id = $1`, [req.params.mid]);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok || !access.rights.canCreateTask) throw forbidden('Erfordert das Recht „Arbeitspaket erzeugen“ an der Ansicht');
    const { task } = await requireTask(db, user, req.body?.taskId, 'member');
    if (!(await mailAllowedInProject(db, mail.id, task.project_id))) throw forbidden(PERSONAL_MAIL_ONLY);
    const copy = Boolean(req.body?.copy);
    if (copy) {
      if (mail.account_type === 'personal' && mail.owner_user_id !== user.id) throw forbidden('Aus persönlichen Konten kopiert nur der Eigentümer');
      const members = await db.query(`select u.name, m.role from project_members m join users u on u.id = m.user_id where m.project_id = $1 order by u.name`, [task.project_id]);
      if (!req.body?.confirmed) {
        return { needsConfirmation: true, willSee: members.rows.map((x: any) => ({ name: x.name, role: x.role })) };
      }
    }
    await linkMailToTask(db, { mailId: mail.id, taskId: task.id, copied: copy, linkedBy: user.id, actorId: user.id });
    await audit(db, { orgId: user.orgId, projectId: task.project_id, userId: user.id, action: copy ? 'mail.copy_to_task' : 'mail.link_task', objectType: 'mail', objectId: mail.id, details: { taskId: task.id, subject: mail.subject, viewIds: access.viewIds } });
    return { ok: true };
  });

  // W3: Mail → Arbeitspaket (vorbefüllt, ohne KI)
  app.post<{ Params: { mid: string }; Body: { projectId: string; title?: string; subprojectId?: string | null; dueDate?: string | null; responsibleUserId?: string | null; responsibleEmail?: string | null; copy?: boolean; confirmed?: boolean } }>('/mail/mails/:mid/create-task', async (req) => {
    const user = requireUser(req);
    const mail = await db.maybeOne(`select m.*, a.type as account_type, a.owner_user_id from mails m join mail_accounts a on a.id = m.account_id where m.id = $1`, [req.params.mid]);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok || !access.rights.canCreateTask) throw forbidden('Erfordert das Recht „Arbeitspaket erzeugen“ an der Ansicht');
    const b = req.body ?? ({} as any);
    const pm = await requireProject(db, user, b.projectId, 'member');
    if (!(await mailAllowedInProject(db, mail.id, b.projectId))) throw forbidden(PERSONAL_MAIL_ONLY);
    await assertResponsible(db, b.projectId, pm, b.responsibleUserId);
    if (b.subprojectId) {
      const s = await db.maybeOne(`select id from subprojects where id = $1 and project_id = $2`, [b.subprojectId, b.projectId]);
      if (!s) throw badRequest('Teilprojekt gehört nicht zum Projekt');
      if (!(await canSeeSubproject(db, user.id, b.subprojectId))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    }
    // Inhalt aus persönlichen Konten übernimmt nur der Eigentümer; sonst nur Absender, Datum und Betreff
    const ownContent = !(mail.account_type === 'personal' && mail.owner_user_id !== user.id);
    const copy = Boolean(b.copy) && ownContent;
    if (ownContent && !b.confirmed) {
      const willSee = await newlyExposed(b.projectId, mail.id, user.id);
      if (willSee.length) return { needsConfirmation: true, willSee };
    }
    const col = await db.one(`select id from board_columns where project_id = $1 order by position limit 1`, [b.projectId]);
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1`, [col.id]);
    const desc = `Aus Mail von ${mail.from_name ?? mail.from_addr} (${new Date(mail.date).toLocaleDateString('de-DE')}):\n\n${ownContent ? (mail.text_body ?? mail.snippet ?? '').slice(0, 4000) : `Betreff: ${mail.subject ?? '–'} (Inhalt aus einem persönlichen Konto, nur für den Kontoinhaber sichtbar)`}`;
    const t = await db.one(
      `insert into tasks (project_id, subproject_id, column_id, title, description, due_date, responsible_user_id, responsible_email, position, mail_code, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [b.projectId, b.subprojectId ?? null, col.id, (b.title ?? mail.subject ?? 'Neues Arbeitspaket').slice(0, 200), desc, b.dueDate ?? null, b.responsibleUserId ?? null, b.responsibleEmail ?? null, pos.p, newMailCode(), user.id]
    );
    await linkMailToTask(db, { mailId: mail.id, taskId: t.id, copied: copy, linkedBy: user.id, origin: !mail.outgoing, actorId: user.id });
    if (b.responsibleEmail) await db.query(`insert into project_contacts (project_id, email) values ($1, lower($2)) on conflict do nothing`, [b.projectId, String(b.responsibleEmail).trim()]);
    queueAgentRun(t.id, 'mail');
    await audit(db, { orgId: user.orgId, projectId: b.projectId, userId: user.id, action: 'task.create_from_mail', objectType: 'task', objectId: t.id, details: { mailId: mail.id, subject: mail.subject, copied: copy, confirmed: Boolean(b.confirmed) } });
    if (b.responsibleUserId && b.responsibleUserId !== user.id) await dispatch(db, { event: 'assigned', projectId: b.projectId, taskId: t.id, type: 'task.assigned', title: `Dir zugewiesen: ${(b.title ?? mail.subject ?? 'Neues Arbeitspaket').slice(0, 200)}`, body: `von ${user.name} (aus Mail)`, link: `/projekte/${b.projectId}/board?task=${t.id}`, ref: { type: 'task', id: t.id }, actorId: user.id });
    return { task: await loadTask(db, t.id) };
  });

  // Mail → Arbeitspaket-Log (1:1-Zitat als Log-Eintrag, ohne KI)
  app.post<{ Params: { mid: string }; Body: { taskId: string; note?: string; confirmed?: boolean } }>('/mail/mails/:mid/to-task-log', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailReadable(user, mail.id);
    if (!access.ok || !access.rights.canCreateTask) throw forbidden('Erfordert das Recht „Arbeitspaket erzeugen“ an der Ansicht');
    if (mail.account_type === 'personal' && mail.owner_user_id !== user.id) throw forbidden('Aus persönlichen Konten übernimmt nur der Eigentümer');
    const task = await db.maybeOne(`select * from tasks where id = $1`, [req.body?.taskId]);
    if (!task) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, task.project_id, 'member');
    if (!(await mailAllowedInProject(db, mail.id, task.project_id))) throw forbidden(PERSONAL_MAIL_ONLY);
    if (!(await canSeeSubproject(db, user.id, task.subproject_id))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    if (!req.body?.confirmed) {
      const willSee = await newlyExposed(task.project_id, mail.id, user.id);
      if (willSee.length) return { needsConfirmation: true, willSee };
    }
    const body = (req.body?.note?.trim() ? req.body.note.trim() + '\n\n' : '') + mailToLogEntry(mail);
    const c = await db.one(`insert into task_comments (task_id, user_id, body, source, mail_id) values ($1,$2,$3,'mail',$4) returning *`, [task.id, user.id, body, mail.id]);
    await linkMailToTask(db, { mailId: mail.id, taskId: task.id, linkedBy: user.id, actorId: user.id, logged: true });
    queueAgentRun(task.id, 'mail');
    await audit(db, { orgId: user.orgId, projectId: task.project_id, userId: user.id, action: 'mail.to_task_log', objectType: 'task', objectId: task.id, details: { mailId: mail.id, subject: mail.subject, confirmed: Boolean(req.body?.confirmed) } });
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
    if (!(await mailAllowedInProject(db, mail.id, b.projectId))) throw forbidden(PERSONAL_MAIL_ONLY);
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
    if (!(await mailAllowedInProject(db, mail.id, page.project_id))) throw forbidden(PERSONAL_MAIL_ONLY);
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
    // Schreibende Aktionen brauchen eine Mitgliedschaft über Leser hinaus im Projekt der Ansicht (bzw. der Kopie)
    const projectIds = access.viewIds.length
      ? (await db.query(`select distinct project_id from mail_views where id = any($1::uuid[])`, [access.viewIds])).rows.map((r: any) => r.project_id as string)
      : (await db.query(`select distinct t.project_id from mail_task_links l join tasks t on t.id = l.task_id where l.mail_id = $1 and l.copied`, [mail.id])).rows.map((r: any) => r.project_id as string);
    let writer = false;
    // KI-Aktionen: Freigabe je Funktion (assist.summarize, assist.essence) in einem der Projekte, sonst deren Begründung
    const aiReasons: Record<string, string | undefined> = { summarize: undefined, essence_task: undefined, essence_page: undefined };
    for (const [key, feature] of [['summarize', 'assist.summarize'], ['essence_task', 'assist.essence'], ['essence_page', 'assist.essence']] as const) {
      let reason: string | undefined = projectIds.length ? undefined : 'Mail gehört zu keiner Projektansicht';
      for (const [i, pid] of projectIds.entries()) {
        const d = await aiAllowed(db, { userId: user.id, projectId: pid, feature });
        if (d.allowed) { reason = undefined; break; }
        if (i === 0) reason = d.reason;
      }
      aiReasons[key] = reason ?? (!access.rights.canAi ? 'Kein KI-Recht in dieser Ansicht' : undefined);
    }
    for (const pid of projectIds) {
      const m = await getMembership(db, pid, user.id);
      if (m && m.role !== 'reader') writer = true;
    }
    const noWrite = writer ? undefined : 'Leser dürfen keine Arbeitspakete ändern';
    return {
      rule: [
        { key: 'link_task', target: 'task', label: 'Mit Arbeitspaket verknüpfen', enabled: writer && access.rights.canCreateTask },
        { key: 'copy_task', target: 'task', label: 'In Arbeitspaket kopieren', enabled: writer && access.rights.canCreateTask && canCopy },
        { key: 'task_log', target: 'task', label: 'Ins Arbeitspaket-Log übernehmen', enabled: writer && access.rights.canCreateTask && canCopy, reason: noWrite ?? (!canCopy ? 'Aus persönlichen Konten übernimmt nur der Eigentümer' : !access.rights.canCreateTask ? 'Erfordert das Recht „Arbeitspaket erzeugen“ an der Ansicht' : undefined) },
        { key: 'task_adjust', target: 'task', label: 'Arbeitspaket anpassen (Mail als Beleg)', enabled: writer, reason: noWrite },
        { key: 'create_task', target: 'task', label: 'Arbeitspaket erstellen', enabled: writer && access.rights.canCreateTask },
        { key: 'to_page', target: 'doc', label: 'In Doku ablegen (eigene Seite)', enabled: writer && canCopy, reason: noWrite ?? (!canCopy ? 'Aus persönlichen Konten legt nur der Eigentümer ab' : undefined) },
        { key: 'append_page', target: 'doc', label: 'An Seite anhängen (Protokoll, Report)', enabled: writer && canCopy, reason: noWrite ?? (!canCopy ? 'Aus persönlichen Konten legt nur der Eigentümer ab' : undefined) }
      ],
      ai: AI_ACTIONS.map((a) => ({ ...a, enabled: !aiReasons[a.key], reason: aiReasons[a.key] })),
      pages: pages.rows.map((p: any) => ({ pageId: p.page_id, kind: p.kind, title: p.title, projectId: p.project_id }))
    };
  });

  // W4: Entwürfe und Versand
  // Ursprungsmail markieren/aufheben (Mitglied mit Sicht auf das Arbeitspaket, Verknüpfung muss bestehen)
  app.post<{ Params: { id: string; mid: string }; Body: { origin: boolean } }>('/tasks/:id/mails/:mid/origin', async (req) => {
    const user = requireUser(req);
    const t = await db.maybeOne(`select * from tasks where id = $1 and deleted_at is null`, [req.params.id]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    await requireProject(db, user, t.project_id, 'member');
    if (!(await canSeeSubproject(db, user.id, t.subproject_id))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    const l = await db.maybeOne(`update mail_task_links l set origin = $3 from mails m where m.id = l.mail_id and l.task_id = $1 and l.mail_id = $2 and not m.outgoing returning l.mail_id`, [t.id, req.params.mid, Boolean(req.body?.origin)]);
    if (!l) throw notFound('Eingehende Mail ist nicht mit dem Arbeitspaket verknüpft');
    await audit(db, { orgId: user.orgId, projectId: t.project_id, userId: user.id, action: 'mail.origin', objectType: 'task', objectId: t.id, details: { mailId: req.params.mid, origin: Boolean(req.body?.origin) } });
    return { ok: true };
  });

  // Abschluss: Antwort auf die Ursprungsmail vorbereiten (aufbereitetes Ergebnis, optional mit der Projekt-KI); gesendet wird über den normalen Entwurf
  app.get<{ Params: { id: string }; Querystring: { ai?: string } }>('/tasks/:id/final-reply', async (req) => {
    const user = requireUser(req);
    const task = await db.maybeOne(`select t.*, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.id = $1 and t.deleted_at is null`, [req.params.id]);
    if (!task) throw notFound('Arbeitspaket nicht gefunden');
    const m = await requireProject(db, user, task.project_id, 'member');
    if (!(await canSeeSubproject(db, user.id, task.subproject_id))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    let mail: any = null;
    for (const o of await originMails(db, task.id)) if ((await mailReadable(user, o.id)).ok) { mail = o; break; }
    if (!mail) throw badRequest('Keine Ursprungsmail, die du lesen darfst');
    // Antwort aus dem Konto der Mail: eine Ansicht dieses Projekts mit Entwurfs- oder Senderecht
    let viewId: string | null = null;
    const views = await db.query(`select v.id from mail_view_matches x join mail_views v on v.id = x.view_id where x.mail_id = $1 and v.project_id = $2 order by v.created_at`, [mail.id, task.project_id]);
    for (const v of views.rows) { const r = await getViewRights(db, v.id, user, m); if (r.canDraft || r.canSend) { viewId = v.id; break; } }
    let body = await finalReplyText(db, task, mail, user.name);
    if (req.query.ai === '1') {
      const { cfg, decision } = await aiConfigFor(db, { userId: user.id, projectId: task.project_id, feature: 'assist.final_reply' });
      if (!cfg) throw aiError(decision);
      const r = await aiFinalReply(db, cfg, app.fetchFn, task, mail, user.name);
      body = r.text || body;
      await audit(db, { orgId: user.orgId, projectId: task.project_id, userId: user.id, action: 'ai.final_reply', objectType: 'task', objectId: task.id, details: { mailId: mail.id, profile: cfg.name, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens } });
    }
    // KI-Text an Nicht-Interne: Außenprüfung nur als Hinweis, die Person entscheidet selbst
    const outbound = req.query.ai === '1' ? await checkHint(db, { orgId: user.orgId, projectId: task.project_id, taskId: task.id, recipients: [mail.from_addr], subject: reSubject(mail.subject), text: body, userId: user.id }) : null;
    return { mailId: mail.id, viewId, to: [mail.from_addr], subject: reSubject(mail.subject), inReplyTo: mail.message_id ?? null, body, answered: Boolean(mail.answered), draftOpen: Boolean(mail.draft_open), outbound };
  });

  // Vorschau der Außenprüfung vor dem Senden (Neue Mail, Antwort): nur Hinweise, nichts wird protokolliert oder blockiert
  app.post<{ Params: { id: string }; Body: { taskId?: string | null; to?: string[]; cc?: string[]; subject?: string; body?: string } }>('/projects/:id/outbound-hint', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? {};
    const task = b.taskId ? await db.maybeOne(`select id, project_id, subproject_id from tasks where id = $1 and deleted_at is null`, [b.taskId]) : null;
    if (b.taskId && (!task || task.project_id !== req.params.id)) throw badRequest('Arbeitspaket gehört nicht zum Projekt');
    if (task && !(await canSeeSubproject(db, user.id, task.subproject_id))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    const recipients = [...(Array.isArray(b.to) ? b.to : []), ...(Array.isArray(b.cc) ? b.cc : [])].map(String).slice(0, 50);
    const hint = await checkHint(db, { orgId: user.orgId, projectId: req.params.id, taskId: task?.id ?? null, recipients, subject: String(b.subject ?? ''), text: String(b.body ?? ''), userId: user.id, record: false });
    return { outbound: hint };
  });

  app.get<{ Params: { id: string } }>('/projects/:id/mail/drafts', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    const rows = await db.query(
      `${DRAFT_SELECT} where d.project_id = $1 order by d.created_at desc limit 200`,
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

  app.post<{ Body: { viewId?: string; accountId?: string; projectId: string; taskId?: string | null; checklistItemId?: string | null; to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string | null; references?: string | null; send?: boolean } }>('/mail/drafts', async (req) => {
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
    if (!(await accountAllowedInProject(db, account!, b.projectId))) throw forbidden(PERSONAL_MAIL_ONLY);
    if (!rights.canDraft && !rights.canSend) throw forbidden('Kein Entwurfsrecht an dieser Ansicht');
    if (b.taskId) await requireTaskRef(db, user, b.projectId, b.taskId);
    const d = await db.one(
      `insert into mail_drafts (account_id, view_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, in_reply_to, status, checklist_item_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11) returning *`,
      [account!.id, b.viewId ?? null, b.taskId ?? null, b.projectId, user.id, JSON.stringify(b.to), JSON.stringify(b.cc ?? []), b.subject, b.body ?? '', b.inReplyTo ?? null, b.checklistItemId ?? null]
    );
    if (b.send) {
      await hintOnSend(d.id, user);
      if (rights.canSend) {
        await doSend(d.id, user, account!, b.references ?? null);
      } else {
        await db.query(`update mail_drafts set status = 'pending_approval', updated_at = now() where id = $1`, [d.id]);
        await audit(db, { orgId: user.orgId, projectId: b.projectId, userId: user.id, action: 'mail.draft_submitted', objectType: 'mail_draft', objectId: d.id, details: { to: b.to, subject: b.subject } });
        await notifyApprovers(b.viewId ?? null, b.projectId, user, b.subject);
      }
    }
    const row = await db.one(`${DRAFT_SELECT} where d.id = $1`, [d.id]);
    return { draft: mapDraft(row) };
  });

  app.patch<{ Params: { did: string }; Body: { to?: string[]; cc?: string[]; subject?: string; body?: string } }>('/mail/drafts/:did', async (req) => {
    const user = requireUser(req);
    const d = await db.maybeOne(`select * from mail_drafts where id = $1`, [req.params.did]);
    if (!d) throw notFound('Entwurf nicht gefunden');
    if (d.status === 'sent') throw badRequest('Bereits gesendet');
    const m = await requireProject(db, user, d.project_id, 'member');
    if (!(await mayDecideDraft(d, user, m))) throw forbidden();
    const b = req.body ?? {};
    await db.query(
      `update mail_drafts set to_addrs = coalesce($2::jsonb, to_addrs), cc_addrs = coalesce($3::jsonb, cc_addrs), subject = coalesce($4, subject), body = coalesce($5, body), updated_at = now() where id = $1`,
      [d.id, b.to ? JSON.stringify(b.to) : null, b.cc ? JSON.stringify(b.cc) : null, b.subject ?? null, b.body ?? null]
    );
    const row = await db.one(`${DRAFT_SELECT} where d.id = $1`, [d.id]);
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
    if (rights?.canSend || (d.user_id === user.id && rights?.canDraft)) await hintOnSend(d.id, user);
    if (!rights?.canSend) {
      if (d.user_id === user.id && rights?.canDraft) {
        await db.query(`update mail_drafts set status = 'pending_approval', updated_at = now() where id = $1`, [d.id]);
        const row = await db.one(`${DRAFT_SELECT} where d.id = $1`, [d.id]);
        return { draft: mapDraft(row), submitted: true };
      }
      throw forbidden('Kein Senderecht an dieser Ansicht');
    }
    await doSend(d.id, user, account, null);
    const row = await db.one(`${DRAFT_SELECT} where d.id = $1`, [d.id]);
    return { draft: mapDraft(row) };
  });

  app.delete<{ Params: { did: string } }>('/mail/drafts/:did', async (req) => {
    const user = requireUser(req);
    const d = await db.maybeOne(`select * from mail_drafts where id = $1`, [req.params.did]);
    if (!d) throw notFound('Entwurf nicht gefunden');
    const m = await requireProject(db, user, d.project_id, 'member');
    if (!(await mayDecideDraft(d, user, m))) throw forbidden();
    await db.query(`update outbound_checks set decided_by = $2, decided_at = now() where mail_draft_id = $1 and decided_at is null`, [d.id, user.id]);
    await db.query(`delete from mail_drafts where id = $1`, [d.id]);
    await audit(db, { orgId: user.orgId, projectId: d.project_id, userId: user.id, action: 'mail.draft_rejected', objectType: 'mail_draft', objectId: d.id, details: { subject: d.subject, by: user.id === d.user_id ? 'author' : 'approver' } });
    // Entwurf eines Agenten abgelehnt: steht im Log des Arbeitspakets, der Agent läuft daraufhin erneut
    const author = d.user_id !== user.id && d.status !== 'sent' && d.task_id ? await db.maybeOne(`select name from users where id = $1 and kind = 'agent'`, [d.user_id]) : null;
    if (author) {
      await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [d.task_id, user.id, `Mail-Entwurf von ${author.name} an ${(d.to_addrs ?? []).join(', ')} abgelehnt (nicht gesendet): „${d.subject}“`]);
      queueAgentRun(d.task_id, 'rejected');
    }
    return { ok: true };
  });

  // Außenprüfung (Informationsgrenze): angehaltene Agenten-Mails mit Fundstellen; sehen und entscheiden darf, wer den Entwurf senden darf
  // (Senderecht der Ansicht bzw. Konto verwalten, auch für die verfassende Person); Hinweise zu Entwürfen von Menschen (Kanal draft) gehören nicht dazu
  app.get<{ Params: { id: string }; Querystring: { result?: string } }>('/projects/:id/outbound-checks', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    const result = ['pass', 'held', 'blocked'].includes(String(req.query.result)) ? String(req.query.result) : null;
    const rows = await db.query(
      `select c.*, t.number, t.title as task_title, t.subproject_id, p.key, d.subject, d.body, d.to_addrs, d.cc_addrs, d.status as draft_status, d.page_id, d.user_id as draft_user_id, d.view_id, d.account_id,
         du.name as draft_user_name, pg.title as page_title, dby.name as decided_by_name
       from outbound_checks c join projects p on p.id = c.project_id left join tasks t on t.id = c.task_id left join mail_drafts d on d.id = c.mail_draft_id
         left join users du on du.id = d.user_id left join doc_pages pg on pg.id = d.page_id left join users dby on dby.id = c.decided_by
       where c.project_id = $1 and ($2::text is null or c.result = $2) and ($2::text is distinct from 'held' or (c.decided_at is null and c.channel in ('mail','reply_origin','pdf') and d.status in ('pending_approval','failed')))
       order by c.created_at desc limit 100`, [req.params.id, result]);
    const out: OutboundCheck[] = [];
    for (const r of rows.rows as any[]) {
      if (r.subproject_id && !(await canSeeSubproject(db, user.id, r.subproject_id))) continue;
      const draft = { user_id: r.draft_user_id, view_id: r.view_id, account_id: r.account_id };
      if (r.mail_draft_id ? !(await (result === 'held' ? maySendDraft(draft, user, m) : mayDecideDraft(draft, user, m))) : m.role !== 'pl') continue;
      out.push(mapCheck(r));
    }
    return { checks: out };
  });

  /**
   * Angehaltene Mail entscheiden: release sendet unverändert, edit speichert Betreff und Text und sendet, block lehnt ab
   * (Log, der Agent läuft erneut). sharePageIds gibt dabei Seiten aus den Fundstellen für die externen Empfänger frei
   * (doc_shares, nur lesen; PL oder „Final setzen / Versand“). Menschen werden von Fundstellen nicht blockiert.
   */
  app.post<{ Params: { cid: string }; Body: { action: 'release' | 'edit' | 'block'; subject?: string; body?: string; sharePageIds?: string[] } }>('/outbound-checks/:cid/decide', async (req) => {
    const user = requireUser(req);
    const c = await db.maybeOne(`select * from outbound_checks where id = $1 and org_id = $2`, [req.params.cid, user.orgId]);
    if (!c || !c.project_id) throw notFound('Prüfung nicht gefunden');
    const m = await requireProject(db, user, c.project_id, 'member');
    const t = c.task_id ? await db.maybeOne(`select t.id, t.number, t.subproject_id, p.key from tasks t join projects p on p.id = t.project_id where t.id = $1`, [c.task_id]) : null;
    if (t && !(await canSeeSubproject(db, user.id, t.subproject_id))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    const d = c.mail_draft_id ? await db.maybeOne(`select * from mail_drafts where id = $1`, [c.mail_draft_id]) : null;
    if (!d || c.decided_at || !['pending_approval', 'failed'].includes(d.status)) throw badRequest('Bereits entschieden oder ohne wartenden Entwurf');
    // Echtes Senderecht, auch für die verfassende Person (sonst ginge ein Entwurf ohne Senderecht an der Freigabe vorbei)
    if (!(await maySendDraft(d, user, m))) throw forbidden('Freigeben darf, wer den Entwurf senden darf (Senderecht der Ansicht bzw. PL)');
    if (!['mail', 'reply_origin', 'pdf'].includes(c.channel)) throw badRequest('Nur Agenten-Mails werden hier entschieden; Hinweise zu eigenen Entwürfen gelten beim normalen Senden');
    const b = req.body ?? ({} as any);
    if (!['release', 'edit', 'block'].includes(b.action)) throw badRequest('action: release, edit oder block');
    const author = await db.maybeOne(`select name, kind from users where id = $1`, [d.user_id]);
    const to = (d.to_addrs ?? []).join(', ');
    const log = (body: string) => d.task_id ? db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [d.task_id, user.id, body]) : null;
    if (b.action === 'block') {
      await db.query(`update outbound_checks set decided_by = $2, decided_at = now() where mail_draft_id = $1 and decided_at is null`, [d.id, user.id]);
      await db.query(`delete from mail_drafts where id = $1`, [d.id]);
      await audit(db, { orgId: user.orgId, projectId: c.project_id, userId: user.id, action: 'ai.outbound', objectType: 'mail_draft', objectId: d.id, details: { checkId: c.id, decision: 'block', subject: d.subject } });
      await log(`Außenprüfung: Mail${author?.kind === 'agent' ? ` von ${author.name}` : ''} an ${to} abgelehnt (nicht gesendet): „${d.subject}“`);
      if (author?.kind === 'agent' && d.task_id) queueAgentRun(d.task_id, 'rejected');
      return { ok: true };
    }
    // Vor jeder Änderung prüfen: Seitenfreigabe nur PL oder „Final setzen / Versand“, angehaltenes PDF nur, solange die Seite final ist
    const share = (Array.isArray(b.sharePageIds) ? b.sharePageIds : []).filter((pid: string) => (c.findings ?? []).some((f: any) => f.pageId === pid));
    if (share.length && m.role !== 'pl' && !m.canFinalize) throw forbidden('Seiten gibt die PL frei oder wer „Final setzen / Versand“ darf');
    if (d.page_id && (await db.maybeOne(`select status from doc_pages where id = $1 and deleted_at is null`, [d.page_id]))?.status !== 'final') throw badRequest('Die Seite des PDF-Anhangs ist nicht mehr final: Seite final setzen oder Entwurf ablehnen');
    if (b.action === 'edit') {
      if (!String(b.subject ?? d.subject).trim()) throw badRequest('Betreff erforderlich');
      await db.query(`update mail_drafts set subject = coalesce($2, subject), body = coalesce($3, body), updated_at = now() where id = $1`, [d.id, b.subject?.trim() || null, b.body ?? null]);
    }
    // Seite in der Außenprüfung freigeben: Lesefreigabe für die externen Empfänger, danach Teil ihres Außenkontexts
    if (share.length) {
      const externals: string[] = (c.recipients ?? []).filter((r: any) => r.audience !== 'internal').map((r: any) => r.email);
      for (const pid of share) {
        const page = await db.maybeOne(`select id, title from doc_pages where id = $1 and project_id = $2 and deleted_at is null`, [pid, c.project_id]);
        if (!page) continue;
        for (const email of externals) {
          if (await db.maybeOne(`select 1 from doc_shares where page_id = $1 and lower(email) = $2 and revoked_at is null and (expires_at is null or expires_at > now())`, [page.id, email])) continue;
          await db.query(`insert into doc_shares (page_id, project_id, token, email, mode, include_children, created_by) values ($1,$2,$3,$4,'read',false,$5)`, [page.id, c.project_id, newShareToken(), email, user.id]);
          await audit(db, { orgId: user.orgId, projectId: c.project_id, userId: user.id, action: 'page.share', objectType: 'doc_page', objectId: page.id, details: { email, mode: 'read', via: 'outbound_check', checkId: c.id } });
        }
      }
    }
    const account = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [d.account_id]);
    await doSend(d.id, user, account, null);
    await audit(db, { orgId: user.orgId, projectId: c.project_id, userId: user.id, action: 'ai.outbound', objectType: 'mail_draft', objectId: d.id, details: { checkId: c.id, decision: b.action, shared: share } });
    const sent = await db.one(`select subject from mail_drafts where id = $1`, [d.id]);
    await log(`Nach außen an ${to} (Außenprüfung): von ${user.name} ${b.action === 'edit' ? 'bearbeitet und ' : ''}freigegeben, gesendet: „${sent.subject}“`);
    const row = await db.one(`${DRAFT_SELECT} where d.id = $1`, [d.id]);
    return { ok: true, draft: mapDraft(row) };
  });

  /** Entwurf ändern oder ablehnen: die verfassende Person, sonst wer ihn senden darf. */
  async function mayDecideDraft(d: { user_id: string; view_id: string | null; account_id: string }, user: User, m: Awaited<ReturnType<typeof requireProject>>): Promise<boolean> {
    return d.user_id === user.id || maySendDraft(d, user, m);
  }

  /** Senderecht an einem Entwurf: an einer Ansicht wer dort senden darf, ohne Ansicht (Entwürfe von Agenten am Projektkonto) wer das Konto verwaltet. */
  async function maySendDraft(d: { view_id: string | null; account_id: string }, user: User, m: Awaited<ReturnType<typeof requireProject>>): Promise<boolean> {
    if (d.view_id) return (await getViewRights(db, d.view_id, user, m)).canSend;
    return canManageAccount(user, await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [d.account_id]));
  }

  /** Mail, die eine Person selbst sendet oder zur Freigabe einreicht: Außenprüfung als Hinweis (protokolliert, blockiert nie). */
  async function hintOnSend(draftId: string, user: User) {
    const d = await db.one(`select d.*, u.kind as author_kind from mail_drafts d join users u on u.id = d.user_id where d.id = $1`, [draftId]);
    if (d.author_kind === 'agent') return;
    await checkHint(db, { orgId: user.orgId, projectId: d.project_id, taskId: d.task_id, recipients: [...(d.to_addrs ?? []), ...(d.cc_addrs ?? [])], subject: d.subject, text: d.body ?? '', mailDraftId: d.id, userId: user.id });
  }

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
    // Angehaltener PDF-Versand: das PDF der Seite wird beim Senden erzeugt, nur solange die Seite final ist
    const page = d.page_id ? await db.maybeOne(`select * from doc_pages where id = $1 and deleted_at is null`, [d.page_id]) : null;
    if (d.page_id && page?.status !== 'final') throw badRequest('Die Seite des PDF-Anhangs ist nicht mehr final: Seite final setzen oder Entwurf ablehnen');
    try {
      const pdf = page ? await pagePdf(db, page, (await db.one(`select name from users where id = $1`, [d.user_id])).name) : null;
      const res = await app.mail.sendFromAccount(account, {
        to: d.to_addrs, cc: d.cc_addrs, subject: d.subject, text: d.body, taskId: d.task_id, checklistItemId: d.checklist_item_id ?? null, inReplyTo: d.in_reply_to, references, userId: user.id, projectId: d.project_id, ...(pdf ? { attachments: [pdf] } : {})
      });
      if (page && pdf) await storePagePdf(db, page, pdf, user.id);
      await db.query(`update mail_drafts set status = 'sent', sent_at = now(), sent_by = $2, error = null, updated_at = now() where id = $1`, [draftId, user.id]);
      await db.query(`update outbound_checks set decided_by = $2, decided_at = now() where mail_draft_id = $1 and decided_at is null`, [draftId, user.id]);
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

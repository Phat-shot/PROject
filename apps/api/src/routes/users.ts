import type { FastifyInstance } from 'fastify';
import { hashPassword, mapUser, requireUser, verifyPassword, withManagedGroups } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, HttpError, notFound } from '../errors.js';
import { randomBytes } from 'node:crypto';
import { createSession, setSessionCookie } from '../auth.js';
import { publicBase } from '../docs/share.js';
import type { Group, Invitation, MailInquiry, User } from '@projekttool/shared';
import { DEFAULT_INQUIRY, parseInquiry } from '../ai/mailInquiry.js';
import { ORG_RIGHTS } from '@projekttool/shared';
import { hasOrgRight, requireProject, syncProjectGroups } from '../rights.js';
import { newSecret, otpauthUrl, verifyTotp } from '../totp.js';
import { setRules } from '../rules.js';
import { projectPolicy, SQL, TEXT } from '../projectPolicy.js';
import { orgAccount as orgAccountOf, releaseUserAccounts } from '../mail/accounts.js';

export async function userRoutes(app: FastifyInstance) {
  // Alle Benutzer des Mandanten (für Einladungen, Zuweisungen); ?all=1 mit Deaktivierten (Org-Admin, zum Reaktivieren)
  app.get<{ Querystring: { all?: string } }>('/users', async (req) => {
    const user = requireUser(req);
    const all = req.query.all === '1' && user.globalRole === 'org_admin';
    const rows = await app.db.query(`select * from users where org_id = $1 ${all ? '' : 'and active'} order by active desc, name`, [user.orgId]);
    return { users: rows.rows.map(mapUser) };
  });

  app.post<{ Body: { email: string; name: string; password: string; globalRole?: string } }>('/users', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const { email, name, password, globalRole = 'user' } = req.body ?? ({} as any);
    if (!email || !name || !password) throw badRequest('E-Mail, Name und Passwort erforderlich');
    if (!['org_admin', 'project_creator', 'user'].includes(globalRole)) throw badRequest('Ungültige Rolle');
    const row = await app.db.one(
      `insert into users (org_id, email, name, password_hash, global_role) values ($1, $2, $3, $4, $5) returning *`,
      [user.orgId, email.toLowerCase(), name, hashPassword(password), globalRole]
    );
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'user.create', objectType: 'user', objectId: row.id, details: { email, globalRole } });
    return { user: mapUser(row) };
  });

  /**
   * Schutz der Verwaltung: niemand deaktiviert den eigenen Zugang, und der letzte aktive Org-Admin bleibt erhalten
   * (weder herabgestuft noch deaktiviert).
   */
  const assertKeepsAccess = async (user: User, target: any, next: { globalRole: string; active: boolean }) => {
    if (target.id === user.id && !next.active) throw forbidden('Den eigenen Zugang deaktiviert man nicht selbst');
    const losesAdmin = target.global_role === 'org_admin' && target.active && (next.globalRole !== 'org_admin' || !next.active);
    if (!losesAdmin) return;
    const others = await app.db.one(`select count(*)::int as c from users where org_id = $1 and id <> $2 and global_role = 'org_admin' and active and kind = 'person'`, [target.org_id, target.id]);
    if (!others.c) throw badRequest('Der letzte aktive Org-Admin bleibt erhalten. Erst eine weitere Person zum Org-Admin machen.');
  };

  /** Deaktivieren: Login endet, persönliche Konten werden getrennt, Zuständigkeiten fallen zurück, Gruppenzeilen in Projekten entfallen. */
  const deactivate = async (user: User, target: any) => {
    const plOf = await app.db.query(
      `select p.key from project_members m join projects p on p.id = m.project_id
       where m.user_id = $1 and m.role = 'pl' and not m.is_deputy and p.status = 'active'`,
      [target.id]
    );
    if (plOf.rows.length) throw badRequest(`Benutzer ist PL in: ${plOf.rows.map((r: any) => r.key).join(', ')}. Erst eine neue PL bestimmen (Verwaltung › Projekte).`);
    await app.db.query(`update users set active = false where id = $1`, [target.id]);
    await app.db.query(`delete from sessions where user_id = $1`, [target.id]);
    // Konten der Person: ohne weitere Bindung löschen (Ansichten verschwinden, Kopien in Arbeitspaketen bleiben), sonst Verwaltung an Projekt oder Org
    await releaseUserAccounts(app.db, user.orgId, target.id, user.id);
    // Ausdrückliche Zuständigkeiten fallen zurück auf die Ebene darüber.
    const tasks = await app.db.query(`update tasks set responsible_user_id = null where responsible_user_id = $1 returning id, project_id, title`, [target.id]);
    await app.db.query(`update subprojects set responsible_user_id = null where responsible_user_id = $1`, [target.id]);
    await app.db.query(`update checklist_items set responsible_user_id = null where responsible_user_id = $1`, [target.id]);
    await syncProjectGroups(app.db, { userId: target.id });
    await audit(app.db, {
      orgId: user.orgId, userId: user.id, action: 'user.deactivate', objectType: 'user', objectId: target.id,
      details: { releasedTasks: tasks.rows.map((t: any) => t.id) }
    });
    return tasks.rows;
  };

  // Org-Admin: globale Rolle, Org-Rechte (ai_admin, groups_admin, resources_admin) und Aktiv-Status (auch reaktivieren); KI-Agenten haben keine Org-Rechte
  app.patch<{ Params: { id: string }; Body: { globalRole?: string; orgRights?: string[]; active?: boolean } }>('/users/:id', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const b = req.body ?? {};
    const keys = Object.keys(b);
    if (!keys.length || keys.some((k) => !['globalRole', 'orgRights', 'active'].includes(k))) throw badRequest('Änderbar: globalRole, orgRights, active');
    const target = await app.db.maybeOne(`select * from users where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!target) throw notFound('Benutzer nicht gefunden');
    let rights: string[] | null = null;
    if ('orgRights' in b) {
      if (!Array.isArray(b.orgRights)) throw badRequest('Org-Rechte als Liste');
      rights = [...new Set(b.orgRights.map(String))];
      if (rights.some((r) => !ORG_RIGHTS.some((x) => x.key === r))) throw badRequest(`Org-Rechte: ${ORG_RIGHTS.map((x) => x.key).join(', ')}`);
      if (target.kind === 'agent' && rights.length) throw badRequest('KI-Agenten haben keine Org-Rechte');
    }
    if ('globalRole' in b && !['org_admin', 'project_creator', 'user'].includes(String(b.globalRole))) throw badRequest('Globale Rolle: org_admin, project_creator oder user');
    if ('active' in b && typeof b.active !== 'boolean') throw badRequest('active: true oder false');
    if (target.kind === 'agent' && ('globalRole' in b || 'active' in b)) throw badRequest('KI-Agenten verwaltet man unter KI-Agenten');
    const next = { globalRole: String(b.globalRole ?? target.global_role), active: b.active ?? target.active };
    await assertKeepsAccess(user, target, next);
    let releasedTasks: unknown[] = [];
    if (next.active && !target.active) {
      await app.db.query(`update users set active = true where id = $1`, [target.id]);
      await syncProjectGroups(app.db, { userId: target.id });
      await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'user.reactivate', objectType: 'user', objectId: target.id });
    }
    // Deaktivieren zuerst: scheitert es (verantwortliche PL), bleibt alles unverändert
    if (!next.active && target.active) releasedTasks = await deactivate(user, target);
    if (next.globalRole !== target.global_role || rights) {
      await app.db.query(`update users set global_role = $2, org_rights = coalesce($3::text[], org_rights) where id = $1`, [target.id, next.globalRole, rights]);
      await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'user.role', objectType: 'user', objectId: target.id, details: { globalRole: next.globalRole, orgRights: rights ?? target.org_rights ?? [], before: { globalRole: target.global_role, orgRights: target.org_rights ?? [] } } });
    }
    return { user: mapUser(await app.db.one(`select * from users where id = $1`, [target.id])), releasedTasks };
  });

  // Eigene Einstellungen: Name, Sprache, Theme, Passwort
  app.patch<{ Body: { name?: string; settings?: Record<string, unknown>; password?: string; currentPassword?: string } }>('/me', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    const row = await app.db.one(`select * from users where id = $1`, [user.id]);
    if (b.password !== undefined) {
      if (!b.currentPassword || !verifyPassword(b.currentPassword, row.password_hash)) throw badRequest('Aktuelles Passwort stimmt nicht');
      if (b.password.length < 10) throw badRequest('Passwort mit mindestens 10 Zeichen');
      await app.db.query(`update users set password_hash = $2 where id = $1`, [user.id, hashPassword(b.password)]);
      await app.db.query(`delete from sessions where user_id = $1 and token <> $2`, [user.id, req.cookies.pt_session ?? '']);
    }
    const settings = { ...(row.settings ?? {}), ...(b.settings ?? {}) };
    if (settings.theme && !['light', 'dark', 'system'].includes(String(settings.theme))) throw badRequest('Theme: light, dark oder system');
    if (settings.language && !['de', 'en'].includes(String(settings.language))) throw badRequest('Sprache: de oder en');
    if (settings.mailNotifications && !['off', 'immediate', 'daily'].includes(String(settings.mailNotifications))) throw badRequest('Mail-Benachrichtigung: off, immediate oder daily');
    if (settings.chatCards && !['needed', 'all'].includes(String(settings.chatCards))) throw badRequest('Bestätigungskarten: needed oder all');
    if (settings.pinnedProjects !== undefined) {
      const ids = settings.pinnedProjects;
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string' || !/^[0-9a-f-]{36}$/.test(x))) throw badRequest('Angeheftete Projekte: Liste von Projekt-IDs');
      if (new Set(ids).size > 5) throw badRequest('Höchstens 5 Projekte anheften');
      settings.pinnedProjects = [...new Set(ids as string[])];
    }
    const r = await app.db.one(`update users set name = coalesce($2, name), settings = $3 where id = $1 returning *`, [user.id, b.name?.trim() || null, JSON.stringify(settings)]);
    // Übergang (eine Version lang): der alte Mail-Modus schreibt in die Benutzerregel „*“ der Benachrichtigungsregeln
    if (b.settings && 'mailNotifications' in b.settings && settings.mailNotifications) {
      const mode = ({ immediate: 'now', daily: 'digest', off: 'off' } as const)[settings.mailNotifications as 'immediate' | 'daily' | 'off'];
      const star = await app.db.maybeOne(`select channels from notification_rules where org_id = $1 and user_id = $2 and project_id is null and task_id is null and event = '*'`, [user.orgId, user.id]);
      const channels = typeof star?.channels === 'string' ? JSON.parse(star.channels) : star?.channels ?? {};
      // Sperrt die Org den Mail-Modus, bleibt es bei der Einstellung (die Regel würde ohnehin nicht gelten)
      try { await setRules(app.db, user, 'user', { orgId: user.orgId, userId: user.id }, [{ event: '*', channels: { ...channels, mail: mode } }]); } catch (e) { if (!(e instanceof HttpError)) throw e; }
    }
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'user.settings', objectType: 'user', objectId: user.id, details: { name: b.name, settings: b.settings, passwordChanged: b.password !== undefined } });
    // Die Web-App ersetzt damit den angemeldeten Benutzer: managesGroups wie bei /auth/me (Menüpunkt Verwaltung)
    return { user: await withManagedGroups(app.db, mapUser(r)) };
  });

  // ---- Zweiter Faktor (TOTP): einrichten → Code bestätigen → aktiv; abschalten mit Passwort
  app.post('/me/totp/setup', async (req) => {
    const user = requireUser(req);
    const row = await app.db.one(`select totp_enabled from users where id = $1`, [user.id]);
    if (row.totp_enabled) throw badRequest('Zweiter Faktor ist bereits aktiv');
    const secret = newSecret();
    await app.db.query(`update users set totp_secret = $2 where id = $1`, [user.id, secret]);
    return { secret, otpauth: otpauthUrl(secret, user.email) };
  });
  app.post<{ Body: { code: string } }>('/me/totp/enable', async (req) => {
    const user = requireUser(req);
    const row = await app.db.one(`select totp_secret, totp_enabled from users where id = $1`, [user.id]);
    if (!row.totp_secret) throw badRequest('Erst einrichten');
    if (!verifyTotp(row.totp_secret, String(req.body?.code ?? ''))) throw badRequest('Code falsch, bitte den aktuellen Code aus der App eingeben');
    await app.db.query(`update users set totp_enabled = true where id = $1`, [user.id]);
    await app.db.query(`delete from sessions where user_id = $1 and token <> $2`, [user.id, req.cookies.pt_session ?? '']);
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'user.totp_enabled', objectType: 'user', objectId: user.id });
    return { ok: true };
  });
  app.post<{ Body: { password: string } }>('/me/totp/disable', async (req) => {
    const user = requireUser(req);
    const row = await app.db.one(`select password_hash from users where id = $1`, [user.id]);
    if (!verifyPassword(String(req.body?.password ?? ''), row.password_hash)) throw badRequest('Passwort stimmt nicht');
    await app.db.query(`update users set totp_enabled = false, totp_secret = null where id = $1`, [user.id]);
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'user.totp_disabled', objectType: 'user', objectId: user.id });
    return { ok: true };
  });
  // Org-Admin: zweiten Faktor zurücksetzen (Gerät verloren)
  app.post<{ Params: { id: string } }>('/users/:id/totp/reset', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const r = await app.db.query(`update users set totp_enabled = false, totp_secret = null where id = $1 and org_id = $2 returning id`, [req.params.id, user.orgId]);
    if (!r.rows.length) throw notFound('Benutzer nicht gefunden');
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'user.totp_reset', objectType: 'user', objectId: req.params.id });
    return { ok: true };
  });

  // ---- Einladungen per Mail über das Org-Postfach; manuelles Anlegen (POST /users) bleibt als Fallback
  const mapInvitation = (r: any): Invitation => ({ id: r.id, email: r.email, name: r.name, globalRole: r.global_role, projectId: r.project_id ?? null, projectRole: r.project_role ?? null, createdAt: r.created_at, expiresAt: r.expires_at, sentAt: r.sent_at, sendError: r.send_error, acceptedAt: r.accepted_at, link: `${publicBase()}/einladung/${r.token}` });
  /** Org-Admin darf alles; ein PL darf Einladungen seines Projekts anlegen, erneut senden und löschen. */
  const mayManage = async (user: any, inv: { project_id: string | null }) => {
    if (user.globalRole === 'org_admin') return true;
    if (!inv.project_id) return false;
    try { await requireProject(app.db, user, inv.project_id, 'pl'); return true; } catch { return false; }
  };
  const orgAccount = (orgId: string) => orgAccountOf(app.db, orgId);
  const sendInvitation = async (inv: any, inviter: { id: string; name: string }) => {
    const account = await orgAccount(inv.org_id);
    if (!account) {
      await app.db.query(`update invitations set send_error = $2 where id = $1`, [inv.id, 'Kein Org-Postfach angebunden']);
      return { sent: false, error: 'Kein Org-Postfach angebunden. Link manuell weitergeben oder unter Meine Mail-Konten ein Org-Postfach anlegen.' };
    }
    const org = await app.db.one(`select name from orgs where id = $1`, [inv.org_id]);
    const project = inv.project_id ? await app.db.maybeOne(`select key, name from projects where id = $1`, [inv.project_id]) : null;
    const link = `${publicBase()}/einladung/${inv.token}`;
    try {
      await app.mail.sendFromAccount(account, {
        to: [inv.email], subject: project ? `Einladung zum Projekt „${project.name}“ – PROject (${org.name})` : `Einladung zu PROject (${org.name})`,
        text: `Guten Tag ${inv.name},\n\n${inviter.name} hat Sie ${project ? `zum Projekt „${project.name}“ (${project.key}) in PROject` : `zu PROject, dem Projekttool von ${org.name},`} eingeladen.\n\nBitte legen Sie hier Ihr Passwort fest:\n${link}\n\nDer Link ist 14 Tage gültig.\n\nMit freundlichen Grüßen\n${org.name}`,
        userId: inviter.id
      });
      await app.db.query(`update invitations set sent_at = now(), send_error = null where id = $1`, [inv.id]);
      return { sent: true };
    } catch (e: any) {
      const error = String(e?.message ?? e);
      await app.db.query(`update invitations set send_error = $2 where id = $1`, [inv.id, error]);
      return { sent: false, error };
    }
  };

  app.get<{ Querystring: { projectId?: string } }>('/invitations', async (req) => {
    const user = requireUser(req);
    if (req.query.projectId) {
      await requireProject(app.db, user, req.query.projectId, 'pl');
      const rows = await app.db.query(`select * from invitations where org_id = $1 and project_id = $2 and accepted_at is null order by created_at desc`, [user.orgId, req.query.projectId]);
      return { invitations: rows.rows.map(mapInvitation), hasOrgAccount: Boolean(await orgAccount(user.orgId)) };
    }
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const rows = await app.db.query(`select * from invitations where org_id = $1 and accepted_at is null order by created_at desc`, [user.orgId]);
    return { invitations: rows.rows.map(mapInvitation), hasOrgAccount: Boolean(await orgAccount(user.orgId)) };
  });

  // Org-Admin lädt mit globaler Rolle ein; ein PL lädt in sein Projekt ein (globale Rolle „Benutzer“, Projektrolle Mitglied oder Leser)
  app.post<{ Body: { email: string; name: string; globalRole?: string; projectId?: string | null; projectRole?: 'member' | 'reader' | null } }>('/invitations', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? ({} as any);
    const projectId: string | null = b.projectId || null;
    let projectRole: 'member' | 'reader' | null = null;
    if (projectId) {
      await requireProject(app.db, user, projectId, 'pl');
      if (!projectPolicy(await app.db.one(`select personal from projects where id = $1`, [projectId])).members.invitations) throw forbidden(TEXT.noInvitations);
      projectRole = b.projectRole === 'reader' ? 'reader' : 'member';
    } else if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin oder ein PL für sein Projekt');
    const { email, name } = b;
    const globalRole = user.globalRole === 'org_admin' ? (b.globalRole ?? 'user') : 'user';
    if (!email?.trim() || !name?.trim()) throw badRequest('E-Mail und Name erforderlich');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Gültige E-Mail erforderlich');
    if (!['org_admin', 'project_creator', 'user'].includes(globalRole)) throw badRequest('Ungültige Rolle');
    const addr = email.trim().toLowerCase();
    if (await app.db.maybeOne(`select 1 from users where lower(email) = $1`, [addr])) throw badRequest('Für diese E-Mail existiert bereits ein Benutzer');
    await app.db.query(`delete from invitations where org_id = $1 and email = $2 and accepted_at is null`, [user.orgId, addr]);
    const inv = await app.db.one(
      `insert into invitations (org_id, email, name, global_role, token, invited_by, expires_at, project_id, project_role) values ($1,$2,$3,$4,$5,$6, now() + interval '14 days', $7, $8) returning *`,
      [user.orgId, addr, name.trim(), globalRole, randomBytes(24).toString('base64url'), user.id, projectId, projectRole]
    );
    const r = await sendInvitation(inv, user);
    await audit(app.db, { orgId: user.orgId, projectId, userId: user.id, action: 'user.invite', objectType: 'invitation', objectId: inv.id, details: { email: addr, globalRole, projectRole, sent: r.sent } });
    return { invitation: mapInvitation(await app.db.one(`select * from invitations where id = $1`, [inv.id])), ...r };
  });

  app.post<{ Params: { id: string } }>('/invitations/:id/resend', async (req) => {
    const user = requireUser(req);
    const inv = await app.db.maybeOne(`select * from invitations where id = $1 and org_id = $2 and accepted_at is null`, [req.params.id, user.orgId]);
    if (!inv) throw notFound('Einladung nicht gefunden');
    if (!(await mayManage(user, inv))) throw forbidden('Nur Org-Admin oder der PL des Projekts');
    await app.db.query(`update invitations set expires_at = now() + interval '14 days' where id = $1`, [inv.id]);
    const r = await sendInvitation(inv, user);
    return { invitation: mapInvitation(await app.db.one(`select * from invitations where id = $1`, [inv.id])), ...r };
  });

  app.delete<{ Params: { id: string } }>('/invitations/:id', async (req) => {
    const user = requireUser(req);
    const inv = await app.db.maybeOne(`select * from invitations where id = $1 and org_id = $2 and accepted_at is null`, [req.params.id, user.orgId]);
    if (inv && !(await mayManage(user, inv))) throw forbidden('Nur Org-Admin oder der PL des Projekts');
    await app.db.query(`delete from invitations where id = $1 and org_id = $2 and accepted_at is null`, [req.params.id, user.orgId]);
    return { ok: true };
  });

  // Öffentlich: Einladung prüfen und annehmen (Passwort setzen, danach angemeldet)
  const openInvitation = (token: string) => app.db.maybeOne(`select i.*, o.name as org_name from invitations i join orgs o on o.id = i.org_id where i.token = $1 and i.accepted_at is null and i.expires_at > now()`, [token]);
  app.get<{ Params: { token: string } }>('/invitations/accept/:token', async (req) => {
    const inv = await openInvitation(req.params.token);
    if (!inv) throw notFound('Einladung ungültig oder abgelaufen');
    return { email: inv.email, name: inv.name, orgName: inv.org_name };
  });
  app.post<{ Params: { token: string }; Body: { name?: string; password: string } }>('/invitations/accept/:token', async (req, reply) => {
    const inv = await openInvitation(req.params.token);
    if (!inv) throw notFound('Einladung ungültig oder abgelaufen');
    const b = req.body ?? ({} as any);
    if (!b.password || b.password.length < 10) throw badRequest('Passwort mit mindestens 10 Zeichen');
    if (await app.db.maybeOne(`select 1 from users where lower(email) = $1`, [inv.email])) throw badRequest('Benutzer existiert bereits, bitte anmelden');
    const row = await app.db.one(
      `insert into users (org_id, email, name, password_hash, global_role) values ($1,$2,$3,$4,$5) returning *`,
      [inv.org_id, inv.email, (b.name ?? inv.name).trim() || inv.name, hashPassword(b.password), inv.global_role]
    );
    await app.db.query(`update invitations set accepted_at = now(), user_id = $2 where id = $1`, [inv.id, row.id]);
    if (inv.project_id) {
      await app.db.query(
        `insert into project_members (project_id, user_id, role, is_deputy, can_edit_plan, can_approve, can_finalize, can_use_ai) values ($1,$2,$3,false,false,false,false,$4) on conflict (project_id, user_id) do nothing`,
        [inv.project_id, row.id, inv.project_role ?? 'member', inv.project_role !== 'reader'] // „KI nutzen“ vorbelegt: Mitglied an, Leser aus
      );
      await audit(app.db, { orgId: inv.org_id, projectId: inv.project_id, userId: row.id, action: 'member.set', objectType: 'membership', objectId: row.id, details: { role: inv.project_role ?? 'member', viaInvitation: inv.id } });
    }
    await audit(app.db, { orgId: inv.org_id, userId: row.id, action: 'user.invite_accepted', objectType: 'user', objectId: row.id, details: { invitation: inv.id } });
    const token = await createSession(app.db, row.id);
    setSessionCookie(reply, token);
    return { user: mapUser(row) };
  });

  // ---- Berechtigungsgruppen des Mandanten
  const groupRows = async (orgId: string, id?: string) => {
    const rows = await app.db.query(
      `select g.*, coalesce((select json_agg(m.user_id) from group_members m where m.group_id = g.id), '[]'::json) as member_ids,
         coalesce((select json_agg(m.user_id) from group_members m where m.group_id = g.id and m.is_manager), '[]'::json) as manager_ids
       from groups g where g.org_id = $1 ${id ? 'and g.id = $2' : ''} order by g.name`,
      id ? [orgId, id] : [orgId]
    );
    const ids = (v: any): string[] => (typeof v === 'string' ? JSON.parse(v) : v) ?? [];
    return rows.rows.map((g: any): Group => ({ id: g.id, name: g.name, description: g.description, idpName: g.idp_name ?? null, memberIds: ids(g.member_ids), managerIds: ids(g.manager_ids) }));
  };
  /** Gewünschte Mitglieder prüfen, bevor etwas geschrieben wird: nur Personen des Mandanten, nie KI-Agenten; Verwalter sind immer auch Mitglied. */
  const checkMembers = async (orgId: string, ids: string[], managerIds?: string[]): Promise<string[]> => {
    const wanted = [...new Set([...ids, ...(managerIds ?? [])].map(String))];
    const known = wanted.length ? (await app.db.query(`select id, kind from users where org_id = $1 and id = any($2::uuid[])`, [orgId, wanted])).rows : [];
    if (known.some((u: any) => u.kind === 'agent')) throw badRequest('KI-Agenten werden nie Gruppenmitglied');
    return known.map((u: any) => u.id as string);
  };
  /** Mitglieder setzen (geprüft mit checkMembers). Ohne managerIds bleiben die bisherigen Verwalter. */
  const setMembers = async (groupId: string, memberIds: string[], managerIds?: string[]) => {
    const managers = new Set(managerIds ?? (await app.db.query(`select user_id from group_members where group_id = $1 and is_manager`, [groupId])).rows.map((r: any) => r.user_id as string));
    await app.db.query(`delete from group_members where group_id = $1`, [groupId]);
    for (const id of memberIds) await app.db.query(`insert into group_members (group_id, user_id, is_manager) values ($1,$2,$3)`, [groupId, id, managers.has(id)]);
  };
  /** Gruppen pflegen der Org-Admin und das Org-Recht „Gruppen verwalten“; Verwalter einer Gruppe nur deren Mitglieder. */
  const groupsAdmin = (user: User) => hasOrgRight(user, 'groups_admin');

  // Alle angemeldeten Benutzer sehen Gruppen (PL wählt sie für Projekte, Teilprojekte und Mail-Ansichten)
  app.get('/groups', async (req) => {
    const user = requireUser(req);
    return { groups: await groupRows(user.orgId) };
  });
  app.post<{ Body: { name: string; description?: string | null; memberIds?: string[]; managerIds?: string[]; idpName?: string | null } }>('/groups', async (req) => {
    const user = requireUser(req);
    if (!groupsAdmin(user)) throw forbidden('Gruppen legt der Org-Admin oder die Gruppenverwaltung an');
    const b = req.body ?? ({} as any);
    if (!b.name?.trim()) throw badRequest('Name erforderlich');
    if (await app.db.maybeOne(`select 1 from groups where org_id = $1 and lower(name) = lower($2)`, [user.orgId, b.name.trim()])) throw badRequest('Gruppe existiert bereits');
    const members = await checkMembers(user.orgId, b.memberIds ?? [], b.managerIds ?? []);
    const g = await app.db.one(`insert into groups (org_id, name, description, idp_name) values ($1,$2,$3,$4) returning id`, [user.orgId, b.name.trim(), b.description ?? null, b.idpName?.trim() || null]);
    await setMembers(g.id, members, b.managerIds ?? []);
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'group.create', objectType: 'group', objectId: g.id, details: { name: b.name, members: b.memberIds, managers: b.managerIds } });
    return { group: (await groupRows(user.orgId, g.id))[0] };
  });
  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string | null; memberIds?: string[]; managerIds?: string[]; idpName?: string | null } }>('/groups/:id', async (req) => {
    const user = requireUser(req);
    const g = await app.db.maybeOne(`select * from groups where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!g) throw notFound('Gruppe nicht gefunden');
    const b = req.body ?? {};
    if (!groupsAdmin(user)) {
      const manager = await app.db.maybeOne(`select 1 from group_members where group_id = $1 and user_id = $2 and is_manager`, [g.id, user.id]);
      if (!manager) throw forbidden('Gruppen pflegen der Org-Admin, die Gruppenverwaltung und die Verwalter der Gruppe');
      if (Object.keys(b).some((k) => k !== 'memberIds') || !Array.isArray(b.memberIds)) throw forbidden('Als Verwalter der Gruppe pflegst du nur deren Mitglieder');
      const managers = (await app.db.query(`select user_id from group_members where group_id = $1 and is_manager`, [g.id])).rows.map((r: any) => r.user_id);
      if (managers.some((id: string) => !b.memberIds!.includes(id))) throw badRequest('Verwalter bleiben Mitglied der Gruppe; Verwalter ändert die Gruppenverwaltung');
    }
    // Mitglieder vor jeder Änderung prüfen, damit ein Fehler nichts halb schreibt
    const current = (await app.db.query(`select user_id from group_members where group_id = $1`, [g.id])).rows.map((r: any) => r.user_id as string);
    const members = b.memberIds || b.managerIds ? await checkMembers(user.orgId, b.memberIds ?? current, b.managerIds) : null;
    await app.db.query(`update groups set name = coalesce($2, name), description = case when $3 then $4 else description end, idp_name = case when $5 then $6 else idp_name end where id = $1`, [g.id, b.name?.trim() || null, 'description' in b, b.description ?? null, 'idpName' in b, b.idpName?.trim() || null]);
    if (members) {
      await setMembers(g.id, members, b.managerIds);
      await syncProjectGroups(app.db, { groupId: g.id });
    }
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'group.update', objectType: 'group', objectId: g.id, details: b });
    return { group: (await groupRows(user.orgId, g.id))[0] };
  });
  app.delete<{ Params: { id: string } }>('/groups/:id', async (req) => {
    const user = requireUser(req);
    if (!groupsAdmin(user)) throw forbidden('Gruppen löscht der Org-Admin oder die Gruppenverwaltung');
    // Projekte der Gruppe vorher merken: nach dem Löschen fehlen die Verknüpfungen für den Abgleich
    const projects = await app.db.query(`select pg.project_id from project_groups pg join groups g on g.id = pg.group_id where g.id = $1 and g.org_id = $2`, [req.params.id, user.orgId]);
    await app.db.query(`delete from groups where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    for (const p of projects.rows) await syncProjectGroups(app.db, { projectId: p.project_id });
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'group.delete', objectType: 'group', objectId: req.params.id });
    return { ok: true };
  });

  // W10: Benutzer deaktivieren (eigener Zugang und letzter Org-Admin geschützt)
  app.post<{ Params: { id: string } }>('/users/:id/deactivate', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const target = await app.db.maybeOne(`select * from users where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!target) throw notFound('Benutzer nicht gefunden');
    await assertKeepsAccess(user, target, { globalRole: target.global_role, active: false });
    const releasedTasks = target.active ? await deactivate(user, target) : [];
    return { ok: true, releasedTasks };
  });

  // Mandanten-Einstellungen (PDF-Stil, Firmenname)
  app.get('/org/settings', async (req) => {
    const user = requireUser(req);
    const o = await app.db.one(`select name, settings from orgs where id = $1`, [user.orgId]);
    return { name: o.name, settings: o.settings ?? {} };
  });
  app.put<{ Body: { company?: string; accentColor?: string; footerText?: string; timeTracking?: boolean; personalProjects?: boolean; mailInquiry?: MailInquiry | null } }>('/org/settings', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const b = req.body ?? {};
    if (b.accentColor && !/^#[0-9a-fA-F]{6}$/.test(b.accentColor)) throw badRequest('Akzentfarbe als #rrggbb');
    // Vorgabe der Mail-Rückfrage für Projekte ohne eigene Einstellung
    let inquiry: MailInquiry | undefined;
    if (b.mailInquiry !== undefined) { try { inquiry = parseInquiry(b.mailInquiry) ?? DEFAULT_INQUIRY; } catch (e: any) { throw badRequest(e.message); } }
    const o = await app.db.one(`update orgs set settings = settings || $2::jsonb where id = $1 returning settings`, [user.orgId, JSON.stringify({ company: b.company ?? undefined, accentColor: b.accentColor ?? undefined, footerText: b.footerText ?? undefined, timeTracking: b.timeTracking ?? undefined, personalProjects: typeof b.personalProjects === 'boolean' ? b.personalProjects : undefined, mailInquiry: inquiry })]);
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'org.settings', objectType: 'org', objectId: user.orgId, details: b });
    return { settings: o.settings };
  });

  // Benachrichtigungen (Liste mit Filtern in notifyRules.ts)
  app.post<{ Body: { ids?: string[]; all?: boolean } }>('/notifications/read', async (req) => {
    const user = requireUser(req);
    if (req.body?.all) await app.db.query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [user.id]);
    else if (req.body?.ids?.length) await app.db.query(`update notifications set read_at = now() where user_id = $1 and id = any($2::uuid[])`, [user.id, req.body.ids]);
    return { ok: true };
  });

  app.get<{ Querystring: { projectId?: string } }>('/audit', async (req) => {
    const user = requireUser(req);
    const { projectId } = req.query;
    if (projectId) {
      const m = await app.db.maybeOne(`select role from project_members where project_id = $1 and user_id = $2`, [projectId, user.id]);
      if (!m) throw forbidden();
      const own = m.role !== 'pl';
      const rows = await app.db.query(
        `select a.*, u.name as user_name from audit_log a left join users u on u.id = a.user_id
         where a.project_id = $1 ${own ? 'and a.user_id = $3' : ''} order by a.created_at desc limit $2`,
        own ? [projectId, 200, user.id] : [projectId, 200]
      );
      return { entries: rows.rows.map(mapAudit) };
    }
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    // Projekte ohne Admin-Details (projectPolicy.adminAccess.auditDetails): Aktion, Person und Zeit ja, Inhaltsdetails nein (auch bei Einträgen ohne Projekt zu Agenten des Projekts)
    const rows = await app.db.query(
      `select a.*, u.name as user_name,
         (exists (select 1 from projects p where p.id = a.project_id and ${SQL.isPersonal('p')})
          or exists (select 1 from users ag join projects p on p.id = ag.agent_project_id where ag.id::text = a.object_id::text and ${SQL.isPersonal('p')} and a.object_type = 'user')) as redact
       from audit_log a left join users u on u.id = a.user_id
       where a.org_id = $1 order by a.created_at desc limit 1000`,
      [user.orgId]
    );
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'audit.export', objectType: 'audit', details: { count: rows.rows.length } });
    return { entries: rows.rows.map((r: any) => (r.redact ? { ...mapAudit(r), details: { personalProject: true } } : mapAudit(r))) };
  });
}

function mapAudit(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    userId: r.user_id,
    userName: r.user_name ?? null,
    action: r.action,
    objectType: r.object_type,
    objectId: r.object_id,
    details: r.details ?? {},
    createdAt: r.created_at
  };
}

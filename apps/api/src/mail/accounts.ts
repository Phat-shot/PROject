import type { User } from '@projekttool/shared';
import type { Db } from '../db.js';
import { getMembership } from '../rights.js';
import { projectPolicy } from '../projectPolicy.js';
import type { AccountRow } from './types.js';
import { audit } from '../audit.js';

/**
 * Mail-Konten mit Verwalter und Bindungen (Konzept 17).
 * Ein Konto ist ein Postfach mit Zugangsdaten und einem Verwalter (managed_user_id | managed_project_id | keiner = Org-Admin).
 * Bindungen (mail_account_uses) sagen, wofür es dient: org (Systemmails, höchstens eine je Mandant), project (Projektkonto,
 * genau eins je Projekt Standard), personal („Meine Konten“ einer Person). Die Semantik hängt an der Bindung, nicht am Konto.
 */
export type UseKind = 'org' | 'project' | 'personal';
export interface UseRow { id: string; org_id: string; account_id: string; use: UseKind; project_id: string | null; user_id: string | null; is_default: boolean; created_by: string | null; created_at: Date }
export type ManagedBy = { kind: 'org' } | { kind: 'user'; userId: string } | { kind: 'project'; projectId: string };

export const managerOf = (a: { managed_user_id?: string | null; managed_project_id?: string | null }): ManagedBy =>
  a.managed_user_id ? { kind: 'user', userId: a.managed_user_id } : a.managed_project_id ? { kind: 'project', projectId: a.managed_project_id } : { kind: 'org' };

/** Spiegel des Verwalters in den alten Spalten (eine Version lang): type, owner_user_id, project_id. */
export const mirrorOf = (m: ManagedBy) => ({ type: m.kind === 'user' ? 'personal' : m.kind === 'project' ? 'project' : 'org', owner_user_id: m.kind === 'user' ? m.userId : null, project_id: m.kind === 'project' ? m.projectId : null } as const);

/**
 * Bindung, über die ein Projekt (oder niemand) ein Konto nutzt: project-Bindung dieses Projekts, sonst personal, sonst org.
 * SQL-Fragment für Joins (liefert Spalten use, use_user_id, use_id); Aliase: a = mail_accounts, projectExpr = Projekt-Ausdruck oder null.
 */
export const USE_LATERAL = (a: string, projectExpr: string) =>
  `left join lateral (select u.use, u.user_id as use_user_id, u.id as use_id from mail_account_uses u where u.account_id = ${a}.id and (u.use <> 'project' or u.project_id = ${projectExpr})
     order by case u.use when 'project' then 0 when 'personal' then 1 else 2 end, u.created_at limit 1) ux on true`;

export async function accountUses(db: Db, accountId: string): Promise<UseRow[]> {
  return (await db.query(`select * from mail_account_uses where account_id = $1 order by created_at`, [accountId])).rows as UseRow[];
}

/** Bindung eines Kontos im Kontext eines Projekts (siehe USE_LATERAL). */
export async function accountUseIn(db: Db, accountId: string, projectId: string | null): Promise<{ use: UseKind; user_id: string | null; id: string } | null> {
  return db.maybeOne(`select u.use, u.user_id, u.id from mail_account_uses u where u.account_id = $1 and (u.use <> 'project' or u.project_id = $2) order by case u.use when 'project' then 0 when 'personal' then 1 else 2 end, u.created_at limit 1`, [accountId, projectId]);
}

export async function accountBoundToProject(db: Db, accountId: string, projectId: string): Promise<UseRow | null> {
  return db.maybeOne(`select * from mail_account_uses where account_id = $1 and use = 'project' and project_id = $2`, [accountId, projectId]);
}

/** Standard-Ausgangskonto eines Projekts; null, wenn keines Standard ist (kein stilles „Ältestes“). */
export async function projectAccount(db: Db, projectId: string): Promise<AccountRow | null> {
  return db.maybeOne<AccountRow>(`select a.* from mail_account_uses u join mail_accounts a on a.id = u.account_id where u.project_id = $1 and u.use = 'project' and u.is_default`, [projectId]);
}

/** Alle Projektkonten eines Projekts (Standard zuerst). */
export async function projectAccounts(db: Db, projectId: string): Promise<(AccountRow & { use_id: string; is_default: boolean })[]> {
  return (await db.query(`select a.*, u.id as use_id, u.is_default from mail_account_uses u join mail_accounts a on a.id = u.account_id where u.project_id = $1 and u.use = 'project' order by u.is_default desc, u.created_at`, [projectId])).rows;
}

/** Org-Postfach (org-Bindung) des Mandanten. */
export async function orgAccount(db: Db, orgId: string): Promise<AccountRow | null> {
  return db.maybeOne<AccountRow>(`select a.* from mail_account_uses u join mail_accounts a on a.id = u.account_id where u.org_id = $1 and u.use = 'org'`, [orgId]);
}

/** Persönliche Bindung eines Kontos für eine Person. */
export async function personalUse(db: Db, accountId: string, userId: string): Promise<UseRow | null> {
  return db.maybeOne(`select * from mail_account_uses where account_id = $1 and use = 'personal' and user_id = $2`, [accountId, userId]);
}

/** Bindung einer Ansicht (use, use_user_id). */
export async function viewUse(db: Db, viewId: string): Promise<{ use: UseKind; use_user_id: string | null } | null> {
  return db.maybeOne(`select u.use, u.user_id as use_user_id from mail_views v join mail_account_uses u on u.id = v.use_id where v.id = $1`, [viewId]);
}

/** Konto verwalten: Person für ihre Konten, PL für Konten ihres Projekts (der Org-Admin dort nur, soweit projectPolicy.adminAccess.accounts), sonst der Org-Admin. */
export async function canManageAccount(db: Db, user: User, account: AccountRow): Promise<boolean> {
  const m = managerOf(account);
  if (m.kind === 'user') return m.userId === user.id;
  if (m.kind === 'project') {
    if ((await getMembership(db, m.projectId, user.id))?.role === 'pl') return true;
    return user.globalRole === 'org_admin' && projectPolicy(await db.one(`select personal from projects where id = $1`, [m.projectId])).adminAccess.accounts;
  }
  return user.globalRole === 'org_admin';
}

/**
 * Senderecht am Konto ohne Ansicht (Compose per accountId, Entwürfe von Agenten, Versand von Doku-Seiten): PL eines Projekts
 * mit project-Bindung dieses Kontos, Eigentümer einer personal-Bindung, der Verwalter zusätzlich nur in normalen Projekten.
 */
export async function accountRights(db: Db, user: User, account: AccountRow, projectId: string): Promise<{ canSend: boolean; via: 'project' | 'personal' | 'manager' | null }> {
  if ((await accountBoundToProject(db, account.id, projectId)) && (await getMembership(db, projectId, user.id))?.role === 'pl') return { canSend: true, via: 'project' };
  if (await personalUse(db, account.id, user.id)) return { canSend: true, via: 'personal' };
  const p = await db.maybeOne(`select personal from projects where id = $1`, [projectId]);
  if (p && !projectPolicy(p).mail.ownOnly && (await canManageAccount(db, user, account))) return { canSend: true, via: 'manager' };
  return { canSend: false, via: null };
}

/**
 * Bindung setzen dürfen: org nur der Org-Admin an von ihm verwaltete Konten; project die PL des Projekts für Konten mit Verwalter
 * = dieses Projekt oder = sie selbst, der Org-Admin bietet von ihm verwaltete Konten jedem Projekt an (auch persönlichen);
 * personal die Person für Konten, die sie verwaltet, der Org-Admin sein Org-Postfach sich selbst. null = erlaubt, sonst Grund.
 */
export async function bindReason(db: Db, user: User, account: AccountRow, use: UseKind, target: { projectId?: string | null; userId?: string | null }): Promise<string | null> {
  const m = managerOf(account);
  const uses = await accountUses(db, account.id);
  // Org-Postfach: nur Systemmails, keine Projekt- oder persönlichen Bindungen; umgekehrt wird kein gebundenes Konto zum Org-Postfach
  if (use === 'org') {
    if (!(user.globalRole === 'org_admin' && m.kind === 'org')) return 'Als Org-Postfach bindet nur der Org-Admin ein von ihm verwaltetes Konto';
    return uses.some((u) => u.use !== 'org') ? 'Ein Konto mit Projekt- oder persönlichen Bindungen wird nicht zum Org-Postfach; dafür ein eigenes Konto anlegen' : null;
  }
  if (uses.some((u) => u.use === 'org')) return 'Das Org-Postfach dient nur Systemmails; für Projekte ein zentrales Postfach oder ein Projektpostfach anlegen';
  if (use === 'project') {
    if (!target.projectId) return 'projectId erforderlich';
    if (m.kind === 'org') {
      if (user.globalRole === 'org_admin') return null;
      // Zentrales Postfach: jede PL holt es in ihr normales Projekt, wenn der Org-Admin es für alle freigegeben hat
      const p = await db.maybeOne(`select personal from projects where id = $1`, [target.projectId]);
      if ((account as any).offered_to_all && p && !projectPolicy(p).mail.ownOnly && (await getMembership(db, target.projectId, user.id))?.role === 'pl') return null;
      return 'Konten der Organisation bietet nur der Org-Admin einem Projekt an (zentrale Postfächer mit „für alle Projekte“ holt die PL selbst)';
    }
    if ((await getMembership(db, target.projectId, user.id))?.role !== 'pl') return 'Projektkonten bindet die PL des Projekts';
    if (m.kind === 'project') return m.projectId === target.projectId ? null : 'Das Konto verwaltet ein anderes Projekt; nur der Org-Admin bietet fremde Konten an';
    return m.userId === user.id ? null : 'Das Konto verwaltet eine andere Person';
  }
  if (!target.userId || target.userId !== user.id) return 'Persönlich bindet man nur für sich selbst';
  if (m.kind === 'user') return m.userId === user.id ? null : 'Das Konto verwaltet eine andere Person';
  if (m.kind === 'org') return user.globalRole === 'org_admin' ? null : 'Konten der Organisation bindet nur der Org-Admin';
  return (await getMembership(db, m.projectId, user.id))?.role === 'pl' ? null : 'Das Konto verwaltet ein Projekt, dessen PL du nicht bist';
}

/** Projekt-Mailadresse als Cache aus dem Standardkonto. */
export async function refreshMailAddress(db: Db, projectId: string): Promise<void> {
  await db.query(`update projects set mail_address = (select a.address from mail_account_uses u join mail_accounts a on a.id = u.account_id where u.project_id = $1 and u.use = 'project' and u.is_default) where id = $1`, [projectId]);
}

/** Standard-Ausgangskonto eines Projekts setzen (Bindung muss bestehen). */
export async function setDefault(db: Db, projectId: string, accountId: string): Promise<void> {
  const u = await accountBoundToProject(db, accountId, projectId);
  if (!u) throw new Error('Konto ist nicht an dieses Projekt gebunden');
  await db.query(`update mail_account_uses set is_default = false where project_id = $1 and use = 'project' and is_default`, [projectId]);
  await db.query(`update mail_account_uses set is_default = true where id = $1`, [u.id]);
  await refreshMailAddress(db, projectId);
}

/** Angeboten: das Konto verwaltet die Organisation oder ein anderes Projekt (eigen: dieses Projekt oder eine Person, die es selbst gebunden hat). */
export const isOffered = (a: { managed_user_id?: string | null; managed_project_id?: string | null }, projectId: string) => !a.managed_user_id && a.managed_project_id !== projectId;

/** Fehlt ein Standard, rückt die älteste eigene Bindung nach; angebotene Konten werden nie automatisch Standard. */
export async function ensureDefault(db: Db, projectId: string): Promise<void> {
  if (!(await db.maybeOne(`select 1 from mail_account_uses where project_id = $1 and use = 'project' and is_default`, [projectId]))) {
    const next = await db.maybeOne(`select u.id from mail_account_uses u join mail_accounts a on a.id = u.account_id where u.project_id = $1 and u.use = 'project' and (a.managed_project_id = $1 or a.managed_user_id is not null) order by u.created_at limit 1`, [projectId]);
    if (next) await db.query(`update mail_account_uses set is_default = true where id = $1`, [next.id]);
  }
  await refreshMailAddress(db, projectId);
}

/** Bindung anlegen; die erste eigene project-Bindung eines Projekts wird Standard. */
export async function bind(db: Db, account: AccountRow, use: UseKind, target: { projectId?: string | null; userId?: string | null }, createdBy: string | null): Promise<UseRow> {
  const existing = await db.maybeOne<UseRow>(`select * from mail_account_uses where account_id = $1 and use = $2 and project_id is not distinct from $3 and user_id is not distinct from $4`, [account.id, use, target.projectId ?? null, target.userId ?? null]);
  if (existing) return existing;
  const r = await db.one<UseRow>(`insert into mail_account_uses (org_id, account_id, use, project_id, user_id, created_by) values ($1,$2,$3,$4,$5,$6) returning *`, [account.org_id, account.id, use, use === 'project' ? target.projectId : null, use === 'personal' ? target.userId : null, createdBy]);
  if (use === 'project') await ensureDefault(db, target.projectId!);
  return r;
}

/** Bindung lösen; Ansichten darüber verschwinden (cascade), der Standard rückt nach. */
export async function unbind(db: Db, useId: string): Promise<UseRow | null> {
  const u = await db.maybeOne<UseRow>(`delete from mail_account_uses where id = $1 returning *`, [useId]);
  if (u?.use === 'project' && u.project_id) await ensureDefault(db, u.project_id);
  return u;
}

/** Verwalter setzen (Spiegel in den alten Spalten mitziehen). Wird ein Projekt Verwalter, lösen sich Bindungen an andere Projekte (Projektpostfächer gehören genau einem Projekt). */
export async function setManager(db: Db, accountId: string, m: ManagedBy): Promise<void> {
  const mir = mirrorOf(m);
  await db.query(`update mail_accounts set managed_user_id = $2, managed_project_id = $3, type = $4, owner_user_id = $5, project_id = $6, offered_to_all = case when $3::uuid is null and $2::uuid is null then offered_to_all else false end where id = $1`,
    [accountId, m.kind === 'user' ? m.userId : null, m.kind === 'project' ? m.projectId : null, mir.type, mir.owner_user_id, mir.project_id]);
  if (m.kind === 'project') for (const u of (await accountUses(db, accountId)).filter((x) => x.use === 'project' && x.project_id !== m.projectId)) await unbind(db, u.id);
}

/** Art eines Kontos aus Verwalter und Bindungen (Oberfläche und Rechtehinweise). */
export function accountKind(a: { managed_user_id?: string | null; managed_project_id?: string | null }, uses: { use: UseKind }[]): 'org' | 'central' | 'project' | 'personal' {
  if (uses.some((u) => u.use === 'org')) return 'org';
  const m = managerOf(a);
  return m.kind === 'org' ? 'central' : m.kind === 'project' ? 'project' : 'personal';
}

/**
 * Person wird deaktiviert: Konten mit Verwalter = Person und ohne project/org-Bindung werden gelöscht; sonst geht die Verwaltung
 * an das Projekt der einzigen project-Bindung oder an die Org, die personal-Bindung entfällt.
 */
export async function releaseUserAccounts(db: Db, orgId: string, userId: string, actorId: string | null): Promise<void> {
  const accounts = await db.query<AccountRow>(`select * from mail_accounts where managed_user_id = $1`, [userId]);
  for (const a of accounts.rows) {
    const uses = await accountUses(db, a.id);
    const shared = uses.filter((u) => u.use !== 'personal');
    if (!shared.length) { await db.query(`delete from mail_accounts where id = $1`, [a.id]); continue; }
    const projects = [...new Set(shared.filter((u) => u.use === 'project').map((u) => u.project_id!))];
    const to: ManagedBy = shared.every((u) => u.use === 'project') && projects.length === 1 ? { kind: 'project', projectId: projects[0] } : { kind: 'org' };
    await setManager(db, a.id, to);
    for (const u of uses.filter((x) => x.use === 'personal')) await unbind(db, u.id);
    for (const p of projects) await ensureDefault(db, p);
    await audit(db, { orgId, projectId: to.kind === 'project' ? to.projectId : null, userId: actorId, action: 'mail_account.manager_transferred', objectType: 'mail_account', objectId: a.id, details: { from: userId, to: to.kind === 'project' ? `project:${to.projectId}` : 'org' } });
  }
  // Persönliche Bindungen an fremd verwalteten Konten (z. B. Org-Postfach des Org-Admins) entfallen
  for (const u of (await db.query<UseRow>(`select * from mail_account_uses where user_id = $1 and use = 'personal'`, [userId])).rows) await unbind(db, u.id);
}

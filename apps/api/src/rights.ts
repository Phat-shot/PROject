import type { Membership, OrgRight, ProjectRole, User, MailViewRights } from '@projekttool/shared';
import { ROLE_RANK } from '@projekttool/shared';
import type { Db } from './db.js';
import { forbidden, HttpError, notFound } from './errors.js';

export function mapMembership(row: any): Membership {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    isDeputy: row.is_deputy,
    canEditPlan: row.can_edit_plan,
    canApprove: row.can_approve,
    canFinalize: row.can_finalize,
    canUseAi: row.can_use_ai,
    agentCanMail: row.agent_can_mail !== false,
    origin: row.origin === 'group' ? 'group' : 'direct'
  };
}

/** Org-Recht (Verwaltung): der Org-Admin hat alle, sonst einzeln vergeben (users.org_rights, z. B. ai_admin für Verwaltung › KI). */
export function hasOrgRight(user: User, right: OrgRight): boolean {
  return user.globalRole === 'org_admin' || Boolean(user.orgRights?.includes(right));
}

export async function getMembership(db: Db, projectId: string, userId: string): Promise<Membership | null> {
  const row = await db.maybeOne(`select * from project_members where project_id = $1 and user_id = $2`, [projectId, userId]);
  return row ? mapMembership(row) : null;
}

/**
 * Zentrale Rechteprüfung: Projektmitgliedschaft mit Mindestrolle.
 * Org-Admins haben keinen impliziten Zugriff auf Projektinhalte.
 */
export async function requireProject(db: Db, user: User, projectId: string, min: ProjectRole = 'reader'): Promise<Membership> {
  const project = await db.maybeOne(`select id, org_id, status, visibility from projects where id = $1`, [projectId]);
  if (!project || project.org_id !== user.orgId) throw notFound('Projekt nicht gefunden');
  const m = await effectiveMembership(db, user, projectId, project.visibility);
  if (!m) throw forbidden('Kein Mitglied dieses Projekts');
  if (ROLE_RANK[m.role] < ROLE_RANK[min]) throw forbidden(`Rolle ${min} erforderlich`);
  return m;
}

/** Mitgliedschaft oder, bei Sichtbarkeit „org“, implizite Leserolle für alle aktiven Benutzer des Mandanten. */
export async function effectiveMembership(db: Db, user: User, projectId: string, visibility?: string): Promise<Membership | null> {
  const m = await getMembership(db, projectId, user.id);
  if (m) return m;
  const vis = visibility ?? (await db.maybeOne(`select visibility from projects where id = $1 and org_id = $2`, [projectId, user.orgId]))?.visibility;
  if (vis === 'org' && user.active) return { projectId, userId: user.id, role: 'reader', isDeputy: false, canEditPlan: false, canApprove: false, canFinalize: false, canUseAi: false };
  return null;
}

/**
 * Zugriff auf ein Arbeitspaket: Projektrolle (requireProject) und Sicht auf sein Teilprojekt (eingeschränkte TPs) zusammen.
 * Liefert die Zeile des Arbeitspakets und die Mitgliedschaft.
 */
export async function requireTask(db: Db, user: User, taskId: string, min: ProjectRole = 'reader'): Promise<{ task: any; membership: Membership }> {
  const task = await db.maybeOne(`select * from tasks where id = $1`, [taskId]);
  if (!task) throw notFound('Arbeitspaket nicht gefunden');
  const membership = await requireProject(db, user, task.project_id, min);
  if (!(await canSeeSubproject(db, user.id, task.subproject_id))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
  return { task, membership };
}

/** Wie requireTask als Ja/Nein (z. B. Leserecht an einer Mail über ihre Kopie im Arbeitspaket). */
export async function canSeeTask(db: Db, user: User, taskId: string): Promise<boolean> {
  try {
    await requireTask(db, user, taskId);
    return true;
  } catch (e) {
    if (e instanceof HttpError) return false;
    throw e;
  }
}

export function requireFlag(m: Membership, flag: keyof Membership, message: string) {
  if (m.role === 'pl') return;
  if (!m[flag]) throw forbidden(message);
}

export const NO_RIGHTS: MailViewRights = { canRead: false, canDraft: false, canSend: false, canAi: false, canCreateTask: false };
export const ALL_RIGHTS: MailViewRights = { canRead: true, canDraft: true, canSend: true, canAi: true, canCreateTask: true };

/**
 * Rechte an einer Mail-Ansicht: Eigentümer eines persönlichen Kontos hat alles,
 * sonst Vereinigung aus personenbezogener Zeile und Rollenzeile.
 * Senden aus persönlichen Konten nur der Eigentümer.
 */
export async function getViewRights(db: Db, viewId: string, user: User, membership: Membership | null): Promise<MailViewRights> {
  const view = await db.maybeOne(
    `select v.*, a.type as account_type, a.owner_user_id from mail_views v join mail_accounts a on a.id = v.account_id where v.id = $1`,
    [viewId]
  );
  if (!view) return NO_RIGHTS;
  if (view.account_type === 'personal' && view.owner_user_id === user.id) return ALL_RIGHTS;
  if (!membership) return NO_RIGHTS;
  const rows = await db.query(
    `select * from mail_view_rights where view_id = $1 and (user_id = $2 or role = $3 or group_id in (select group_id from group_members where user_id = $2))`,
    [viewId, user.id, membership.role]
  );
  const r: MailViewRights = { ...NO_RIGHTS };
  for (const row of rows.rows) {
    r.canRead ||= row.can_read;
    r.canDraft ||= row.can_draft;
    r.canSend ||= row.can_send;
    r.canAi ||= row.can_ai;
    r.canCreateTask ||= row.can_create_task;
  }
  if (view.account_type === 'personal') r.canSend = false;
  return r;
}

/**
 * Eingeschränkte Teilprojekte: sichtbar für PL, Teilprojekt-Verantwortung und benannte Benutzer/Gruppen.
 * SQL-Fragment für Aufgabenabfragen (Alias t), $userParam ist die Platzhalternummer der Benutzer-ID.
 */
export function visibleSubprojectSql(userParam: number, alias = 't'): string {
  const u = `$${userParam}`;
  return `(${alias}.subproject_id is null or exists (select 1 from subprojects s where s.id = ${alias}.subproject_id and (not s.restricted
      or s.responsible_user_id = ${u}
      or exists (select 1 from project_members pm where pm.project_id = s.project_id and pm.user_id = ${u} and pm.role = 'pl')
      or exists (select 1 from subproject_access a where a.subproject_id = s.id and (a.user_id = ${u} or a.group_id in (select group_id from group_members gm where gm.user_id = ${u}))))))`;
}

export async function canSeeSubproject(db: Db, userId: string, subprojectId: string | null): Promise<boolean> {
  if (!subprojectId) return true;
  const r = await db.maybeOne(
    `select 1 from subprojects s where s.id = $1 and (not s.restricted or s.responsible_user_id = $2
       or exists (select 1 from project_members pm where pm.project_id = s.project_id and pm.user_id = $2 and pm.role = 'pl')
       or exists (select 1 from subproject_access a where a.subproject_id = s.id and (a.user_id = $2 or a.group_id in (select group_id from group_members gm where gm.user_id = $2))))`,
    [subprojectId, userId]
  );
  return Boolean(r);
}

/**
 * Regel M: Zeilen mit origin='group' in project_members nachziehen. Ein Direkteintrag überschreibt alle Gruppen;
 * zwischen mehreren Gruppen gilt die höchste Rolle, die Einzelrechte werden ODER-verknüpft. Nur aktive Personen
 * (Agenten nie), nie in persönlichen Projekten. Umfang: Projekt, Benutzer und/oder die Projekte einer Gruppe; ohne Angabe alles.
 * Läuft bei Änderungen an project_groups und group_members, beim SSO-Abgleich, (De-)Aktivieren und Löschen eines Direkteintrags.
 */
export async function syncProjectGroups(db: Db, scope: { projectId?: string; userId?: string; groupId?: string } = {}): Promise<void> {
  const params = [scope.projectId ?? null, scope.userId ?? null, scope.groupId ?? null];
  const inScope = (p: string, u: string) =>
    `($1::uuid is null or ${p} = $1::uuid) and ($2::uuid is null or ${u} = $2::uuid) and ($3::uuid is null or ${p} in (select project_id from project_groups where group_id = $3::uuid))`;
  const wanted = `select pg.project_id, gm.user_id, max(case when pg.role = 'member' then 2 else 1 end) as role_rank,
      bool_or(pg.can_edit_plan) as can_edit_plan, bool_or(pg.can_approve) as can_approve, bool_or(pg.can_finalize) as can_finalize, bool_or(pg.can_use_ai) as can_use_ai
    from project_groups pg
    join group_members gm on gm.group_id = pg.group_id
    join users u on u.id = gm.user_id and u.active and u.kind = 'person'
    join projects p on p.id = pg.project_id and not p.personal
    where ${inScope('pg.project_id', 'gm.user_id')}
    group by pg.project_id, gm.user_id`;
  await db.query(
    `delete from project_members pm where pm.origin = 'group' and ${inScope('pm.project_id', 'pm.user_id')}
       and not exists (select 1 from (${wanted}) w where w.project_id = pm.project_id and w.user_id = pm.user_id)`,
    params
  );
  // Direkteinträge bleiben unberührt (where origin = 'group' beim Konflikt)
  await db.query(
    `insert into project_members (project_id, user_id, role, is_deputy, can_edit_plan, can_approve, can_finalize, can_use_ai, origin)
     select project_id, user_id, case when role_rank = 2 then 'member' else 'reader' end, false, can_edit_plan, can_approve, can_finalize, can_use_ai, 'group' from (${wanted}) w
     on conflict (project_id, user_id) do update set role = excluded.role, can_edit_plan = excluded.can_edit_plan, can_approve = excluded.can_approve,
       can_finalize = excluded.can_finalize, can_use_ai = excluded.can_use_ai
     where project_members.origin = 'group'`,
    params
  );
}

/**
 * Empfänger aus einer Gruppe (für Benachrichtigungsregeln): aktive Personen der Gruppe mit Projektsicht
 * (effektive Mitgliedschaft oder Sichtbarkeit „org“), bei einem Teilprojekt nur mit Sicht darauf (canSeeSubproject).
 */
export async function groupRecipients(db: Db, { groupId, projectId, subprojectId = null }: { groupId: string; projectId: string; subprojectId?: string | null }): Promise<string[]> {
  const rows = await db.query(
    `select u.id from group_members gm join users u on u.id = gm.user_id join projects p on p.id = $2 and p.org_id = u.org_id
     where gm.group_id = $1 and u.active and u.kind = 'person'
       and (p.visibility = 'org' or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = u.id))
     order by u.name`,
    [groupId, projectId]
  );
  const out: string[] = [];
  for (const r of rows.rows) if (await canSeeSubproject(db, r.id, subprojectId)) out.push(r.id);
  return out;
}

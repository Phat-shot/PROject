import type { FastifyInstance } from 'fastify';
import type { Membership, Project, ProjectRole, User } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { canSeeSubproject, getMembership, mapMembership, requireProject, visibleSubprojectSql } from '../rights.js';
import { dateStr, mapSubproject, resolveProjectLead } from '../tasks/service.js';
import { createDefaultFolders } from '../docs/service.js';
import { mapLabel } from './tasks.js';
import { evaluateProject, policyOf, type EscalationPolicy } from '../tasks/escalation.js';
import { createReport, reportingOf } from '../docs/report.js';
import type { ReportingPolicy } from '@projekttool/shared';

const DEFAULT_COLUMNS: [string, 'backlog' | 'active' | 'parked' | 'done'][] = [['Geplant', 'backlog'], ['Offen', 'active'], ['In Arbeit', 'active'], ['In Prüfung', 'active'], ['Zurückgestellt', 'parked'], ['Erledigt', 'done']];

export function mapProject(r: any): Project {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    status: r.status,
    mailAddress: r.mail_address,
    timeTrackingEnabled: Boolean(r.time_tracking_enabled),
    budgetHours: r.budget_hours == null ? null : Number(r.budget_hours),
    escalation: policyOf(r.escalation),
    reporting: reportingOf(r.reporting),
    visibility: r.visibility ?? 'members',
    myRole: r.my_role ?? undefined
  };
}

export async function projectRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/projects', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select p.*, coalesce(m.role, 'reader') as my_role,
         (select count(*) from tasks t join board_columns c on c.id = t.column_id where t.project_id = p.id and t.archived_at is null and not c.is_done)::int as open_count,
         (select count(*) from tasks t join board_columns c on c.id = t.column_id where t.project_id = p.id and t.archived_at is null and not c.is_done and t.due_date < $3)::int as overdue_count,
         (select count(*) from tasks t join board_columns c on c.id = t.column_id where t.project_id = p.id and t.archived_at is null and c.is_done)::int as done_count,
         (select ms.name from milestones ms where ms.project_id = p.id and ms.date >= $3 order by ms.date limit 1) as next_ms_name,
         (select ms.date from milestones ms where ms.project_id = p.id and ms.date >= $3 order by ms.date limit 1) as next_ms_date
       from projects p left join project_members m on m.project_id = p.id and m.user_id = $1
       where p.org_id = $2 and (m.user_id is not null or p.visibility = 'org') order by p.status, p.name`,
      [user.id, user.orgId, new Date().toISOString().slice(0, 10)]
    );
    return { projects: rows.rows.map((r: any) => ({ ...mapProject(r), stats: { open: r.open_count, overdue: r.overdue_count, done: r.done_count, nextMilestone: r.next_ms_name ? { name: r.next_ms_name, date: dateStr(r.next_ms_date)! } : null } })) };
  });

  // W1: Projekt anlegen (Projektersteller oder Org-Admin wird PL)
  app.post<{ Body: { key: string; name: string; description?: string; mailAddress?: string } }>('/projects', async (req) => {
    const user = requireUser(req);
    if (!['org_admin', 'project_creator'].includes(user.globalRole)) throw forbidden('Nur Projektersteller dürfen Projekte anlegen');
    const { key, name, description, mailAddress } = req.body ?? ({} as any);
    if (!key || !name) throw badRequest('Kürzel und Name erforderlich');
    if (!/^[A-Z0-9-]{2,12}$/.test(key)) throw badRequest('Kürzel: 2–12 Zeichen, Großbuchstaben, Ziffern, Bindestrich');
    const exists = await db.maybeOne(`select id from projects where org_id = $1 and key = $2`, [user.orgId, key]);
    if (exists) throw conflict('Kürzel bereits vergeben');
    void mailAddress; // Projekt-Mailadresse ergibt sich aus dem angebundenen Projektkonto
    const p = await db.one(
      `insert into projects (org_id, key, name, description, created_by) values ($1,$2,$3,$4,$5) returning *`,
      [user.orgId, key, name, description ?? null, user.id]
    );
    await db.query(
      `insert into project_members (project_id, user_id, role, can_edit_plan, can_approve, can_finalize, can_use_ai) values ($1,$2,'pl',true,true,true,true)`,
      [p.id, user.id]
    );
    for (const [i, [name, kind]] of DEFAULT_COLUMNS.entries()) {
      await db.query(`insert into board_columns (project_id, name, position, is_done, kind) values ($1,$2,$3,$4,$5)`, [p.id, name, i, kind === 'done', kind]);
    }
    await createDefaultFolders(db, p.id);
    await audit(db, { orgId: user.orgId, projectId: p.id, userId: user.id, action: 'project.create', objectType: 'project', objectId: p.id, details: { key, name } });
    return { project: { ...mapProject(p), myRole: 'pl' } };
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    const p = await db.one(`select * from projects where id = $1`, [req.params.id]);
    const members = await db.query(
      `select m.*, u.name, u.email from project_members m join users u on u.id = m.user_id where m.project_id = $1 order by m.role desc, u.name`,
      [p.id]
    );
    const columns = await db.query(`select * from board_columns where project_id = $1 order by position`, [p.id]);
    const subprojects = await db.query(
      `select s.*, u.name as responsible_name, u.email as responsible_email,
         coalesce((select json_agg(a.user_id) from subproject_access a where a.subproject_id = s.id and a.user_id is not null), '[]'::json) as access_user_ids,
         coalesce((select json_agg(a.group_id) from subproject_access a where a.subproject_id = s.id and a.group_id is not null), '[]'::json) as access_group_ids
       from subprojects s left join users u on u.id = s.responsible_user_id where s.project_id = $1
         and (not s.restricted or s.responsible_user_id = $2 or $3 or exists (select 1 from subproject_access a where a.subproject_id = s.id and (a.user_id = $2 or a.group_id in (select group_id from group_members gm where gm.user_id = $2))))
       order by s.position, s.created_at`,
      [p.id, user.id, m.role === 'pl']
    );
    const milestones = await db.query(`select * from milestones where project_id = $1 order by date`, [p.id]);
    const lead = await resolveProjectLead(db, p.id);
    const labels = await db.query(`select * from labels where project_id = $1 order by position, name`, [p.id]);
    return {
      project: { ...mapProject(p), myRole: m.role, myMembership: m },
      labels: labels.rows.map(mapLabel),
      members: members.rows.map((r: any) => ({ ...mapMembership(r), name: r.name, email: r.email })),
      columns: columns.rows.map(mapColumn),
      subprojects: subprojects.rows.map((r: any) => mapSubproject(r, lead)),
      milestones: milestones.rows.map((r: any) => ({ id: r.id, projectId: r.project_id, subprojectId: r.subproject_id, name: r.name, date: dateStr(r.date) }))
    };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; mailAddress?: string | null; timeTrackingEnabled?: boolean; budgetHours?: number | null; visibility?: 'members' | 'org'; escalation?: Partial<EscalationPolicy>; reporting?: Partial<ReportingPolicy> } }>('/projects/:id', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const b = req.body ?? {};
    if (b.visibility !== undefined && !['members', 'org'].includes(b.visibility)) throw badRequest('Sichtbarkeit: members oder org');
    if (b.reporting) {
      const cur = reportingOf((await db.one(`select reporting from projects where id = $1`, [req.params.id])).reporting);
      const { lastRunOn, lastPageId, ...incoming } = b.reporting as any;
      void lastRunOn; void lastPageId;
      const next = reportingOf({ ...cur, ...incoming });
      if (!Number.isInteger(next.weekday) || next.weekday < 1 || next.weekday > 7) throw badRequest('Wochentag 1 (Mo) bis 7 (So)');
      if (!Number.isInteger(next.dayOfMonth) || next.dayOfMonth < 1 || next.dayOfMonth > 28) throw badRequest('Monatstag 1 bis 28');
      next.recipients = next.recipients.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      const bad = next.recipients.find((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
      if (bad) throw badRequest(`Ungültige Empfängeradresse: ${bad}`);
      const tpl = await db.maybeOne(`select 1 from doc_templates where key = $1 and (org_id = $2 or org_id is null)`, [next.templateKey, user.orgId]);
      if (!tpl) throw badRequest('Vorlage nicht gefunden');
      if (next.parentPageId) {
        const pg = await db.maybeOne(`select 1 from doc_pages where id = $1 and project_id = $2`, [next.parentPageId, req.params.id]);
        if (!pg) throw badRequest('Oberseite gehört nicht zum Projekt');
      }
      await db.query(`update projects set reporting = $2 where id = $1`, [req.params.id, JSON.stringify(next)]);
      await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'reporting.policy', objectType: 'project', objectId: req.params.id, details: next as any });
    }
    if (b.escalation) {
      const cur = policyOf((await db.one(`select escalation from projects where id = $1`, [req.params.id])).escalation);
      const next = policyOf({ ...cur, ...b.escalation });
      if (next.stageDays.some((d) => !Number.isFinite(d) || d < 0) || !(next.stageDays[0] <= next.stageDays[1] && next.stageDays[1] <= next.stageDays[2])) throw badRequest('Stufenfristen müssen aufsteigend sein');
      if (next.contactUserId) {
        const ok = await db.maybeOne(`select 1 from users where id = $1 and org_id = $2 and active`, [next.contactUserId, user.orgId]);
        if (!ok) throw badRequest('Eskalationskontakt muss ein Benutzer des Mandanten sein');
      }
      await db.query(`update projects set escalation = $2 where id = $1`, [req.params.id, JSON.stringify(next)]);
      await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'escalation.policy', objectType: 'project', objectId: req.params.id, details: next as any });
    }
    const p = await db.one(
      `update projects set name = coalesce($2, name), description = coalesce($3, description),
         time_tracking_enabled = coalesce($4, time_tracking_enabled), budget_hours = case when $5 then $6::numeric else budget_hours end, visibility = coalesce($7, visibility) where id = $1 returning *`,
      [req.params.id, b.name ?? null, b.description ?? null, b.timeTrackingEnabled ?? null, 'budgetHours' in b, b.budgetHours ?? null, b.visibility ?? null]
    );
    await audit(db, { orgId: user.orgId, projectId: p.id, userId: user.id, action: 'project.update', objectType: 'project', objectId: p.id, details: b });
    return { project: mapProject(p) };
  });

  // Reporting manuell auslösen (PL): erzeugt den Bericht sofort nach den eingestellten Regeln
  app.post<{ Params: { id: string } }>('/projects/:id/reporting/run', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const result = await createReport(db, app.mail, req.params.id, { userId: user.id, manual: true });
    return { result };
  });

  // W11: Projekt archivieren
  app.post<{ Params: { id: string } }>('/projects/:id/archive', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    await db.query(`update projects set status = 'archived' where id = $1`, [req.params.id]);
    // Mail-Ansichten trennen: Synchronisation endet, Kopien in Arbeitspaketen bleiben.
    await db.query(`delete from mail_views where project_id = $1`, [req.params.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'project.archive', objectType: 'project', objectId: req.params.id });
    return { ok: true };
  });

  // W2: Einladung / Rolle ändern
  app.put<{ Params: { id: string; userId: string }; Body: { role: ProjectRole; isDeputy?: boolean; canEditPlan?: boolean; canApprove?: boolean; canFinalize?: boolean; canUseAi?: boolean; transferTasks?: boolean } }>(
    '/projects/:id/members/:userId',
    async (req) => {
      const user = requireUser(req);
      await requireProject(db, user, req.params.id, 'pl');
      const b = req.body ?? ({} as any);
      if (!['pl', 'member', 'reader'].includes(b.role)) throw badRequest('Ungültige Projektrolle');
      const target = await db.maybeOne(`select id from users where id = $1 and org_id = $2 and active`, [req.params.userId, user.orgId]);
      if (!target) throw badRequest('Nur Benutzer des eigenen Mandanten können eingeladen werden');
      // Stellvertreter = zweiter PL, vom PL bestimmt.
      const isDeputy = b.role === 'pl' ? Boolean(b.isDeputy ?? true) : false;
      const primary = await db.maybeOne(`select user_id from project_members where project_id = $1 and role = 'pl' and not is_deputy`, [req.params.id]);
      let transferred = 0;
      if (b.role === 'pl' && !isDeputy && primary && primary.user_id !== req.params.userId) {
        await db.query(`update project_members set is_deputy = true where project_id = $1 and user_id = $2`, [req.params.id, primary.user_id]);
        // Geerbte Zuständigkeiten folgen automatisch; direkt zugewiesene nur auf Wunsch
        if (b.transferTasks) {
          const t1 = await db.query(`update tasks set responsible_user_id = $3 where project_id = $1 and responsible_user_id = $2 and archived_at is null returning id`, [req.params.id, primary.user_id, req.params.userId]);
          const t2 = await db.query(`update subprojects set responsible_user_id = $3 where project_id = $1 and responsible_user_id = $2 returning id`, [req.params.id, primary.user_id, req.params.userId]);
          await db.query(`update checklist_items set responsible_user_id = $3 where responsible_user_id = $2 and task_id in (select id from tasks where project_id = $1)`, [req.params.id, primary.user_id, req.params.userId]);
          transferred = t1.rows.length + t2.rows.length;
        }
      }
      if (primary && primary.user_id === req.params.userId && b.role !== 'pl') {
        const other = await db.maybeOne(`select user_id from project_members where project_id = $1 and role = 'pl' and user_id <> $2`, [req.params.id, req.params.userId]);
        if (!other) throw badRequest('Das Projekt braucht einen PL. Erst einen zweiten PL bestimmen.');
        await db.query(`update project_members set is_deputy = false where project_id = $1 and user_id = $2`, [req.params.id, other.user_id]);
      }
      const row = await db.one(
        `insert into project_members (project_id, user_id, role, is_deputy, can_edit_plan, can_approve, can_finalize, can_use_ai)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (project_id, user_id) do update set role = excluded.role, is_deputy = excluded.is_deputy,
           can_edit_plan = excluded.can_edit_plan, can_approve = excluded.can_approve, can_finalize = excluded.can_finalize, can_use_ai = excluded.can_use_ai
         returning *`,
        [req.params.id, req.params.userId, b.role, isDeputy, Boolean(b.canEditPlan), Boolean(b.canApprove), Boolean(b.canFinalize), Boolean(b.canUseAi)]
      );
      await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'member.set', objectType: 'membership', objectId: req.params.userId, details: { ...b, transferred } });
      return { membership: mapMembership(row), transferred };
    }
  );

  app.delete<{ Params: { id: string; userId: string } }>('/projects/:id/members/:userId', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const m = await getMembership(db, req.params.id, req.params.userId);
    if (!m) throw notFound('Mitglied nicht gefunden');
    if (m.role === 'pl' && !m.isDeputy) throw badRequest('Der verantwortliche PL kann nicht entfernt werden');
    await db.query(`delete from project_members where project_id = $1 and user_id = $2`, [req.params.id, req.params.userId]);
    await db.query(`delete from sessions where user_id = $1 and false`, [req.params.userId]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'member.remove', objectType: 'membership', objectId: req.params.userId });
    return { ok: true };
  });

  // Board-Spalten
  app.put<{ Params: { id: string }; Body: { columns: { id?: string; name: string; isDone?: boolean; kind?: string; wipLimit?: number | null }[] } }>('/projects/:id/columns', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const cols = req.body?.columns ?? [];
    if (cols.length < 2) throw badRequest('Mindestens zwei Spalten');
    const existing = await db.query(`select id from board_columns where project_id = $1`, [req.params.id]);
    const keep = new Set<string>();
    const kinds = ['backlog', 'active', 'parked', 'done'];
    if (!cols.some((c) => c.kind === 'done' || (!c.kind && c.isDone))) throw badRequest('Eine Spalte muss „Erledigt“ sein');
    for (const [i, c] of cols.entries()) {
      const kind = c.kind && kinds.includes(c.kind) ? c.kind : c.isDone ? 'done' : 'active';
      if (c.id) {
        await db.query(`update board_columns set name = $2, position = $3, is_done = $4, wip_limit = $6, kind = $7 where id = $1 and project_id = $5`, [c.id, c.name, i, kind === 'done', req.params.id, c.wipLimit || null, kind]);
        keep.add(c.id);
      } else {
        const r = await db.one(`insert into board_columns (project_id, name, position, is_done, wip_limit, kind) values ($1,$2,$3,$4,$5,$6) returning id`, [req.params.id, c.name, i, kind === 'done', c.wipLimit || null, kind]);
        keep.add(r.id);
      }
    }
    const first = [...keep][0];
    for (const e of existing.rows) {
      if (!keep.has(e.id)) {
        await db.query(`update tasks set column_id = $2 where column_id = $1`, [e.id, first]);
        await db.query(`delete from board_columns where id = $1`, [e.id]);
      }
    }
    const rows = await db.query(`select * from board_columns where project_id = $1 order by position`, [req.params.id]);
    return { columns: rows.rows.map(mapColumn) };
  });

  // Teilprojekte
  type SubprojectBody = { name?: string; responsibleUserId?: string | null; startDate?: string | null; endDate?: string | null; restricted?: boolean; accessUserIds?: string[]; accessGroupIds?: string[]; transferTasks?: boolean };
  /** Zugriffsliste eines eingeschränkten Teilprojekts setzen (nur PL). */
  const setAccess = async (user: User, projectId: string, subprojectId: string, b: SubprojectBody, m: Membership) => {
    if (b.restricted === undefined && !b.accessUserIds && !b.accessGroupIds) return;
    if (m.role !== 'pl') throw forbidden('Sichtbarkeit von Teilprojekten regelt der PL');
    if (b.restricted !== undefined) await db.query(`update subprojects set restricted = $2 where id = $1`, [subprojectId, Boolean(b.restricted)]);
    if (b.accessUserIds || b.accessGroupIds) {
      await db.query(`delete from subproject_access where subproject_id = $1`, [subprojectId]);
      for (const uid of new Set(b.accessUserIds ?? [])) {
        const ok = await db.maybeOne(`select 1 from users where id = $1 and org_id = $2`, [uid, user.orgId]);
        if (ok) await db.query(`insert into subproject_access (subproject_id, user_id) values ($1,$2)`, [subprojectId, uid]);
      }
      for (const gid of new Set(b.accessGroupIds ?? [])) {
        const ok = await db.maybeOne(`select 1 from groups where id = $1 and org_id = $2`, [gid, user.orgId]);
        if (ok) await db.query(`insert into subproject_access (subproject_id, group_id) values ($1,$2)`, [subprojectId, gid]);
      }
    }
    await audit(db, { orgId: user.orgId, projectId, userId: user.id, action: 'subproject.access', objectType: 'subproject', objectId: subprojectId, details: { restricted: b.restricted, users: b.accessUserIds, groups: b.accessGroupIds } });
  };

  app.post<{ Params: { id: string }; Body: SubprojectBody }>('/projects/:id/subprojects', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    if (m.role !== 'pl' && !m.canEditPlan) throw forbidden('Teilprojekte anlegen erfordert das Recht „Projektplan ändern“');
    const b = req.body ?? ({} as any);
    if (!b.name) throw badRequest('Name erforderlich');
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from subprojects where project_id = $1`, [req.params.id]);
    const r = await db.one(
      `insert into subprojects (project_id, name, responsible_user_id, start_date, end_date, position) values ($1,$2,$3,$4,$5,$6) returning *`,
      [req.params.id, b.name, b.responsibleUserId ?? null, b.startDate ?? null, b.endDate ?? null, pos.p]
    );
    await setAccess(user, req.params.id, r.id, b, m);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'subproject.create', objectType: 'subproject', objectId: r.id, details: { name: b.name } });
    return { subproject: mapSubproject(await loadSub(r.id), await resolveProjectLead(db, req.params.id)) };
  });

  app.patch<{ Params: { id: string; sid: string }; Body: SubprojectBody }>('/projects/:id/subprojects/:sid', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    if (m.role !== 'pl' && !m.canEditPlan) throw forbidden('Erfordert das Recht „Projektplan ändern“');
    if (!(await canSeeSubproject(db, user.id, req.params.sid))) throw forbidden('Teilprojekt ist eingeschränkt sichtbar');
    const b = req.body ?? {};
    await setAccess(user, req.params.id, req.params.sid, b, m);
    const before = await db.maybeOne(`select responsible_user_id from subprojects where id = $1 and project_id = $2`, [req.params.sid, req.params.id]);
    const r = await db.maybeOne(
      `update subprojects set name = coalesce($3, name),
         responsible_user_id = case when $4 then $5::uuid else responsible_user_id end,
         start_date = case when $6 then $7::date else start_date end,
         end_date = case when $8 then $9::date else end_date end
       where id = $1 and project_id = $2 returning *`,
      [req.params.sid, req.params.id, b.name ?? null, 'responsibleUserId' in b, b.responsibleUserId ?? null, 'startDate' in b, b.startDate ?? null, 'endDate' in b, b.endDate ?? null]
    );
    if (!r) throw notFound('Teilprojekt nicht gefunden');
    // Direkt zugewiesene Arbeitspakete der bisherigen Verantwortung mit übertragen (geerbte folgen ohnehin)
    let transferred = 0;
    if (b.transferTasks && 'responsibleUserId' in b) {
      const lead = await resolveProjectLead(db, req.params.id);
      const oldEff = before?.responsible_user_id ?? lead.userId;
      const newEff = r.responsible_user_id ?? lead.userId;
      if (oldEff && newEff && oldEff !== newEff) {
        const t1 = await db.query(`update tasks set responsible_user_id = $3 where subproject_id = $1 and responsible_user_id = $2 and archived_at is null returning id`, [r.id, oldEff, newEff]);
        await db.query(`update checklist_items set responsible_user_id = $3 where responsible_user_id = $2 and task_id in (select id from tasks where subproject_id = $1)`, [r.id, oldEff, newEff]);
        transferred = t1.rows.length;
      }
    }
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'subproject.update', objectType: 'subproject', objectId: r.id, details: { ...b, transferred } });
    return { subproject: mapSubproject(await loadSub(r.id), await resolveProjectLead(db, req.params.id)), transferred };
  });

  app.delete<{ Params: { id: string; sid: string } }>('/projects/:id/subprojects/:sid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    await db.query(`delete from subprojects where id = $1 and project_id = $2`, [req.params.sid, req.params.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'subproject.delete', objectType: 'subproject', objectId: req.params.sid });
    return { ok: true };
  });

  // Meilensteine
  app.post<{ Params: { id: string }; Body: { name: string; date: string; subprojectId?: string | null } }>('/projects/:id/milestones', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    if (m.role !== 'pl' && !m.canEditPlan) throw forbidden('Erfordert das Recht „Projektplan ändern“');
    const b = req.body ?? ({} as any);
    if (!b.name || !b.date) throw badRequest('Name und Datum erforderlich');
    const r = await db.one(`insert into milestones (project_id, subproject_id, name, date) values ($1,$2,$3,$4) returning *`, [req.params.id, b.subprojectId ?? null, b.name, b.date]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'milestone.create', objectType: 'milestone', objectId: r.id, details: b });
    return { milestone: { id: r.id, projectId: r.project_id, subprojectId: r.subproject_id, name: r.name, date: dateStr(r.date) } };
  });

  app.patch<{ Params: { id: string; mid: string }; Body: { name?: string; date?: string; subprojectId?: string | null } }>('/projects/:id/milestones/:mid', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    if (m.role !== 'pl' && !m.canEditPlan) throw forbidden('Erfordert das Recht „Projektplan ändern“');
    const b = req.body ?? {};
    if (b.name !== undefined && !b.name.trim()) throw badRequest('Name erforderlich');
    if (b.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) throw badRequest('Datum als YYYY-MM-DD');
    if (b.subprojectId) {
      const s = await db.maybeOne(`select id from subprojects where id = $1 and project_id = $2`, [b.subprojectId, req.params.id]);
      if (!s) throw badRequest('Teilprojekt gehört nicht zum Projekt');
    }
    const r = await db.maybeOne(
      `update milestones set name = coalesce($3, name), date = coalesce($4::date, date), subproject_id = case when $5 then $6::uuid else subproject_id end
       where id = $1 and project_id = $2 returning *`,
      [req.params.mid, req.params.id, b.name?.trim() ?? null, b.date ?? null, 'subprojectId' in b, b.subprojectId ?? null]
    );
    if (!r) throw notFound('Meilenstein nicht gefunden');
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'milestone.update', objectType: 'milestone', objectId: r.id, details: b });
    return { milestone: { id: r.id, projectId: r.project_id, subprojectId: r.subproject_id, name: r.name, date: dateStr(r.date) } };
  });

  app.delete<{ Params: { id: string; mid: string } }>('/projects/:id/milestones/:mid', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    if (m.role !== 'pl' && !m.canEditPlan) throw forbidden('Erfordert das Recht „Projektplan ändern“');
    await db.query(`delete from milestones where id = $1 and project_id = $2`, [req.params.mid, req.params.id]);
    return { ok: true };
  });

  // Übersicht: Kennzahlen, Meilensteine, Konflikte, Freigaben, Aktivität
  app.get<{ Params: { id: string } }>('/projects/:id/overview', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const pid = req.params.id;
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    const counts = await db.one(
      `select count(*) filter (where not c.is_done)::int as open,
              count(*) filter (where c.is_done)::int as done,
              count(*) filter (where not c.is_done and t.due_date < $2)::int as overdue,
              count(*) filter (where not c.is_done and t.due_date >= $2 and t.due_date <= $3)::int as due_week,
              count(*) filter (where not c.is_done and t.due_date is null)::int as no_due
       from tasks t join board_columns c on c.id = t.column_id where t.project_id = $1 and t.archived_at is null`,
      [pid, today, week]
    );
    const perSub = await db.query(
      `select s.id, s.name, count(t.id)::int as total, count(t.id) filter (where c.is_done)::int as done, count(t.id) filter (where not c.is_done and t.due_date < $2)::int as overdue
       from subprojects s left join tasks t on t.subproject_id = s.id and t.archived_at is null left join board_columns c on c.id = t.column_id
       where s.project_id = $1 group by s.id, s.name, s.position order by s.position`,
      [pid, today]
    );
    const milestones = await db.query(`select * from milestones where project_id = $1 and date >= $2 order by date limit 5`, [pid, today]);
    const pending = await db.one(`select count(*)::int as c from mail_drafts where project_id = $1 and status = 'pending_approval'`, [pid]);
    const review = await db.query(`select id, title, updated_at from doc_pages where project_id = $1 and status = 'review' order by updated_at desc limit 5`, [pid]);
    const activity = await db.query(
      `select a.action, a.object_type, a.object_id, a.details, a.created_at, u.name as user_name from audit_log a left join users u on u.id = a.user_id where a.project_id = $1 order by a.created_at desc limit 12`,
      [pid]
    );
    const lead = await resolveProjectLead(db, pid);
    const { loadTasks } = await import('../tasks/service.js');
    const tasks = await loadTasks(db, `t.project_id = $1 and t.archived_at is null and ${visibleSubprojectSql(2)}`, [pid, user.id], lead);
    const conflicts = tasks.filter((t) => t.conflicts.length > 0 && !t.done).map((t) => ({ id: t.id, title: t.title, conflicts: t.conflicts }));
    const overdue = tasks.filter((t) => !t.done && t.dueDate && t.dueDate < today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0, 8)
      .map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate, responsible: t.responsible.name ?? t.responsible.email }));
    const load = new Map<string, { name: string; open: number; overdue: number }>();
    for (const t of tasks) {
      if (t.done || !t.responsible.userId) continue;
      const e = load.get(t.responsible.userId) ?? { name: t.responsible.name ?? '?', open: 0, overdue: 0 };
      e.open++; if (t.dueDate && t.dueDate < today) e.overdue++;
      load.set(t.responsible.userId, e);
    }
    const time = await db.one(`select coalesce(sum(minutes), 0)::int as logged from time_entries where project_id = $1`, [pid]);
    const est = await db.one(`select coalesce(sum(estimate_minutes), 0)::int as est from tasks where project_id = $1 and archived_at is null`, [pid]);
    const proj = await db.one(`select time_tracking_enabled, budget_hours from projects where id = $1`, [pid]);
    const esc = await evaluateProject(db, pid, today);
    return {
      escalations: esc.filter((e) => e.targetLevel > 0 || e.level > 0).slice(0, 10),
      time: { enabled: proj.time_tracking_enabled, loggedMinutes: time.logged, estimateMinutes: est.est, budgetHours: proj.budget_hours == null ? null : Number(proj.budget_hours) },
      counts, perSubproject: perSub.rows,
      milestones: milestones.rows.map((r: any) => ({ id: r.id, name: r.name, date: dateStr(r.date), subprojectId: r.subproject_id })),
      pendingDrafts: pending.c, pagesInReview: review.rows, conflicts, overdue,
      workload: [...load.entries()].map(([userId, v]) => ({ userId, ...v })).sort((a, b) => b.open - a.open),
      activity: activity.rows.map((a: any) => ({ action: a.action, objectType: a.object_type, objectId: a.object_id, details: a.details, createdAt: a.created_at, userName: a.user_name }))
    };
  });

  // Warnungen: aktuelle Eskalationslage (Soll-Stufen aus dem Regelwerk, ohne Nebenwirkung)
  app.get<{ Params: { id: string } }>('/projects/:id/escalations', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const rows = await evaluateProject(db, req.params.id, new Date().toISOString().slice(0, 10));
    const policy = policyOf((await db.one(`select escalation from projects where id = $1`, [req.params.id])).escalation);
    return { policy, escalations: rows };
  });

  // Projektkontakte (Externe)
  app.get<{ Params: { id: string } }>('/projects/:id/contacts', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const rows = await db.query(`select * from project_contacts where project_id = $1 order by email`, [req.params.id]);
    return { contacts: rows.rows.map((r: any) => ({ id: r.id, email: r.email, name: r.name })) };
  });

  async function loadSub(id: string) {
    return db.one(
      `select s.*, u.name as responsible_name, u.email as responsible_email,
         coalesce((select json_agg(a.user_id) from subproject_access a where a.subproject_id = s.id and a.user_id is not null), '[]'::json) as access_user_ids,
         coalesce((select json_agg(a.group_id) from subproject_access a where a.subproject_id = s.id and a.group_id is not null), '[]'::json) as access_group_ids
       from subprojects s left join users u on u.id = s.responsible_user_id where s.id = $1`, [id]);
  }
}

export function mapColumn(r: any) {
  return { id: r.id, projectId: r.project_id, name: r.name, position: r.position, isDone: r.is_done, kind: r.kind ?? (r.is_done ? 'done' : 'active'), wipLimit: r.wip_limit ?? null };
}

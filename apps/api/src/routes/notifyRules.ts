import type { FastifyInstance } from 'fastify';
import type { NotifyEvent, User } from '@projekttool/shared';
import { NOTIFY_EVENTS, NOTIFY_ROLES } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject, requireTask } from '../rights.js';
import { resolveAll, resolveRule, rulesAt, setRules, type RuleInput } from '../rules.js';
import { eventContext, recipientsOf } from '../notify.js';
import { digestHourOf } from '../notifyMail.js';

/**
 * Benachrichtigungsregeln je Ebene (Regel N): Org (Org-Admin, mit Digest-Stunde), Projekt (PL; Mitglieder lesen), AP (PL,
 * die zuständige Person nur den Berichtswunsch „Zwischenstände“), eigene Regeln (Benutzer, im Projekt, am AP). Jede Antwort
 * enthält die Zeilen der Ebene und die aufgelösten Werte mit Herkunft und Sperren. Dazu die Vorschau „Wer bekommt was?“.
 */
export async function notifyRuleRoutes(app: FastifyInstance) {
  const db = app.db;
  const requireAdmin = (req: any): User => { const user = requireUser(req); if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin'); return user; };
  const items = (b: any): RuleInput[] => { if (!Array.isArray(b?.rules)) throw badRequest('rules: Liste der Regeln je Klasse'); return b.rules; };

  const orgListing = async (orgId: string) => {
    const o = await db.one(`select settings from orgs where id = $1`, [orgId]);
    return { rules: await rulesAt(db, { orgId }), effective: await resolveAll(db, { orgId }), digestHour: digestHourOf(o.settings) };
  };
  app.get('/org/notification-rules', async (req) => orgListing(requireAdmin(req).orgId));
  app.put<{ Body: { rules?: RuleInput[]; digestHour?: number } }>('/org/notification-rules', async (req) => {
    const user = requireAdmin(req);
    const b = req.body ?? {};
    if (b.digestHour !== undefined) {
      if (!Number.isInteger(b.digestHour) || b.digestHour < 0 || b.digestHour > 23) throw badRequest('Digest-Stunde: 0 bis 23');
      await db.query(`update orgs set settings = jsonb_set(settings, '{notify}', coalesce(settings->'notify', '{}'::jsonb) || jsonb_build_object('digestHour', $2::int)) where id = $1`, [user.orgId, b.digestHour]);
      await audit(db, { orgId: user.orgId, userId: user.id, action: 'org.settings', objectType: 'org', objectId: user.orgId, details: { notify: { digestHour: b.digestHour } } });
    }
    if (b.rules) await setRules(db, user, 'org', { orgId: user.orgId }, items(b));
    return orgListing(user.orgId);
  });

  // Projekt: Mitglieder lesen (geerbte Werte mit Herkunft), die PL setzt und sperrt
  const projectListing = async (user: User, projectId: string, isPl: boolean) => ({
    rules: await rulesAt(db, { orgId: user.orgId, projectId }), effective: await resolveAll(db, { orgId: user.orgId, projectId }), canEdit: isPl
  });
  app.get<{ Params: { id: string } }>('/projects/:id/notification-rules', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    return projectListing(user, req.params.id, m.role === 'pl');
  });
  app.put<{ Params: { id: string }; Body: { rules: RuleInput[] } }>('/projects/:id/notification-rules', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    await setRules(db, user, 'project', { orgId: user.orgId, projectId: req.params.id }, items(req.body));
    return projectListing(user, req.params.id, true);
  });

  /**
   * Vorschau „Wer bekommt was?“ (PL): je Klasse die aufgelöste Regel (optional am AP) und die Personen aus den Rollen mit ihrem
   * Mail- und Chat-Modus; Rollen, die nur die Aufrufstelle kennt (Erwähnte, Stufen, Kette), stehen als Hinweis.
   */
  app.get<{ Params: { id: string }; Querystring: { taskId?: string } }>('/projects/:id/notification-rules/effective', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    if (req.query.taskId) await requireTask(db, user, req.query.taskId);
    const ctx = await eventContext(db, req.params.id, req.query.taskId ?? null);
    if (!ctx || (req.query.taskId && !ctx.task)) throw notFound('Arbeitspaket nicht im Projekt');
    const names = new Map<string, string>();
    const name = async (id: string) => { if (!names.has(id)) names.set(id, (await db.maybeOne(`select name from users where id = $1`, [id]))?.name ?? '?'); return names.get(id)!; };
    const events = [];
    for (const e of NOTIFY_EVENTS) {
      const rule = await resolveRule(db, { orgId: user.orgId, projectId: req.params.id, taskId: ctx.task?.id ?? null, event: e.key });
      const { out, toProjectChannel } = await recipientsOf(db, { event: e.key, project: ctx.project, task: ctx.task, recipients: rule.value.recipients });
      const people = [];
      for (const [uid, role] of out) {
        const mine = await resolveRule(db, { orgId: user.orgId, projectId: req.params.id, taskId: ctx.task?.id ?? null, userId: uid, event: e.key });
        people.push({ id: uid, name: await name(uid), role, roleLabel: NOTIFY_ROLES.find((r) => r.key === role)?.label ?? (role.startsWith('group:') ? 'Gruppe' : role.startsWith('user:') ? 'Person' : role), mail: mine.value.mail, chat: mine.value.chat });
      }
      const open = rule.value.recipients.flatMap((r) => r.split('|')).filter((r) => ['participants', 'mentioned', 'requester'].includes(r) || (!ctx.task && ['responsible', 'parent_responsible', 'subproject_lead'].includes(r)));
      events.push({ event: e.key, label: e.label, rule, people, projectChannel: toProjectChannel || (rule.value.chat === 'project' && !ctx.project.personal && !ctx.task?.restricted), perEvent: open.map((r) => NOTIFY_ROLES.find((x) => x.key === r)?.label ?? r), caller: e.recipientsText.includes('Aufrufstelle') ? e.recipientsText : null });
    }
    return { taskId: ctx.task?.id ?? null, events };
  });

  // AP: Regeln der Ebene AP (PL alle Klassen; Zuständige(r) nur den Berichtswunsch für Zwischenstände) und der eigene Wunsch
  const taskListing = async (user: User, task: any, isPl: boolean) => {
    const responsible = (await db.maybeOne(`select 1 from tasks t left join tasks pt on pt.id = t.parent_id left join subprojects s on s.id = t.subproject_id
      where t.id = $1 and $2 = case when t.responsible_user_id is not null then t.responsible_user_id when t.responsible_email is not null then null when pt.responsible_user_id is not null then pt.responsible_user_id else s.responsible_user_id end`, [task.id, user.id])) !== null;
    const scope = { orgId: user.orgId, projectId: task.project_id, taskId: task.id };
    return {
      rules: await rulesAt(db, scope), effective: await resolveAll(db, scope), canEdit: isPl, canEditProgress: isPl || responsible,
      mine: await rulesAt(db, { ...scope, userId: user.id }), myEffective: await resolveRule(db, { ...scope, userId: user.id, event: 'progress' })
    };
  };
  app.get<{ Params: { id: string } }>('/tasks/:id/notification-rules', async (req) => {
    const user = requireUser(req);
    const { task, membership } = await requireTask(db, user, req.params.id);
    return taskListing(user, task, membership.role === 'pl');
  });
  app.put<{ Params: { id: string }; Body: { rules: RuleInput[] } }>('/tasks/:id/notification-rules', async (req) => {
    const user = requireUser(req);
    const { task, membership } = await requireTask(db, user, req.params.id, 'member');
    const listing = await taskListing(user, task, membership.role === 'pl');
    const rules = items(req.body);
    if (!listing.canEdit) {
      if (!listing.canEditProgress) throw forbidden('Regeln am AP setzen die PL und die zuständige Person (Zwischenstände)');
      if (rules.some((r) => r.event !== 'progress')) throw forbidden('Als zuständige Person stellst du am AP nur die Zwischenstände ein');
    }
    await setRules(db, user, 'task', { orgId: user.orgId, projectId: task.project_id, taskId: task.id }, rules);
    return taskListing(user, task, membership.role === 'pl');
  });

  // Eigene Regeln: Benutzer (ohne Angabe), Benutzer im Projekt (?projectId), Benutzer am AP (?taskId); nur Chat und Mail, am AP der Berichtswunsch
  const myScope = async (user: User, q: { projectId?: string; taskId?: string }) => {
    if (q.taskId) {
      const { task } = await requireTask(db, user, q.taskId);
      if (q.projectId && q.projectId !== task.project_id) throw badRequest('Arbeitspaket gehört nicht zum Projekt');
      return { level: 'user_task' as const, scope: { orgId: user.orgId, projectId: task.project_id, taskId: task.id, userId: user.id } };
    }
    if (q.projectId) {
      await requireProject(db, user, q.projectId);
      return { level: 'user_project' as const, scope: { orgId: user.orgId, projectId: q.projectId, userId: user.id } };
    }
    return { level: 'user' as const, scope: { orgId: user.orgId, userId: user.id } };
  };
  const myListing = async (level: string, scope: { orgId: string; projectId?: string; taskId?: string; userId: string }) => ({ level, rules: await rulesAt(db, scope), effective: await resolveAll(db, scope) });
  app.get<{ Querystring: { projectId?: string; taskId?: string } }>('/me/notification-rules', async (req) => {
    const user = requireUser(req);
    const { level, scope } = await myScope(user, req.query);
    return myListing(level, scope);
  });
  app.put<{ Querystring: { projectId?: string; taskId?: string }; Body: { rules: RuleInput[] } }>('/me/notification-rules', async (req) => {
    const user = requireUser(req);
    if (user.kind === 'agent') throw forbidden('KI-Agenten bekommen keine Meldungen');
    const { level, scope } = await myScope(user, req.query);
    await setRules(db, user, level, scope, items(req.body));
    return myListing(level, scope);
  });

  // Meldungen mit Filtern (Klasse, Projekt, ungelesen, offen); unread zählt immer alle ungelesenen
  app.get<{ Querystring: { event?: string; projectId?: string; unread?: string; open?: string } }>('/notifications', async (req) => {
    const user = requireUser(req);
    const q = req.query;
    if (q.event && !NOTIFY_EVENTS.some((e) => e.key === q.event)) throw badRequest('Unbekannte Ereignisklasse');
    const rows = await db.query(
      `select * from notifications where user_id = $1 and ($2::text is null or event = $2) and ($3::uuid is null or project_id = $3)
         and (not $4 or read_at is null) and (not $5 or resolved_at is null)
       order by read_at nulls first, created_at desc limit 60`,
      [user.id, q.event ?? null, q.projectId || null, q.unread === '1', q.open === '1']
    );
    const unread = await db.one(`select count(*)::int as c from notifications where user_id = $1 and read_at is null`, [user.id]);
    return {
      notifications: rows.rows.map((n: any) => ({
        id: n.id, projectId: n.project_id, type: n.type, title: n.title, body: n.body, link: n.link, readAt: n.read_at, createdAt: n.created_at,
        event: (n.event ?? 'info') as NotifyEvent, ref: n.ref_type ? { type: n.ref_type, id: n.ref_id } : null, resolvedAt: n.resolved_at ?? null, mail: n.mail
      })),
      unread: unread.c
    };
  });
}

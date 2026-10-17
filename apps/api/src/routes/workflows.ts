import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { loadTasks, resolveProjectLead } from '../tasks/service.js';
import { advanceRun, approveRun, cancelRun, skipStep, validateSteps, type StepState, type WorkflowStep } from '../workflows/engine.js';

/**
 * Workflows je Projekt: Definitionen (Schrittfolgen) und Läufe. Ein Lauf startet im Board („statt Arbeitspaket“,
 * Arbeitspakete landen in der gewählten Spalte/Teilprojekt) oder eigenständig unter „Workflows“ als Mini-Projekt.
 */
export async function workflowRoutes(app: FastifyInstance) {
  const db = app.db;

  const mapDef = (r: any) => ({ id: r.id, projectId: r.project_id, name: r.name, description: r.description, steps: r.steps as WorkflowStep[], active: Boolean(r.active), createdAt: r.created_at, updatedAt: r.updated_at, runCount: Number(r.run_count ?? 0), activeRuns: Number(r.active_runs ?? 0) });
  const mapRun = (r: any) => {
    const steps: WorkflowStep[] = r.steps ?? []; const state: StepState[] = r.state ?? [];
    const cur = r.status === 'active' ? steps[r.current_step] : null;
    const curState = cur ? state[r.current_step] : null;
    const waitingOn = !cur ? null
      : cur.type === 'task' ? `Arbeitspaket „${cur.title}“ erledigt`
        : cur.type === 'timer' ? `Timer bis ${curState?.waitUntil ? new Date(curState.waitUntil).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : '–'}`
          : cur.type === 'wait' ? (cur.waitKind === 'mail' ? `Mail${cur.mailSubject ? ` „${cur.mailSubject}“` : ''}${cur.mailFrom ? ` von ${cur.mailFrom}` : ''}` : 'Freigabe durch die Projektleitung')
            : 'Mailversand';
    return {
      id: r.id, defId: r.def_id, projectId: r.project_id, name: r.name, defName: r.def_name, steps, state, vars: r.vars ?? {}, status: r.status, currentStep: r.current_step,
      standalone: Boolean(r.standalone), columnId: r.column_id, subprojectId: r.subproject_id, startedBy: r.started_by, startedByName: r.started_by_name ?? null, startedAt: r.started_at, finishedAt: r.finished_at, lastError: r.last_error,
      doneSteps: state.filter((s) => s.status === 'done' || s.status === 'skipped').length, totalSteps: steps.length, waitingOn
    };
  };
  const RUN_SELECT = `select r.*, u.name as started_by_name from workflow_runs r left join users u on u.id = r.started_by`;

  async function requirePlan(user: any, projectId: string) {
    const m = await requireProject(db, user, projectId, 'member');
    if (m.role !== 'pl' && !m.canEditPlan) throw forbidden('Workflows anlegen erfordert das Recht „Projektplan ändern“');
    return m;
  }

  app.get<{ Params: { id: string } }>('/projects/:id/workflows', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'reader');
    const defs = await db.query(`select d.*, (select count(*) from workflow_runs x where x.def_id = d.id)::int as run_count, (select count(*) from workflow_runs x where x.def_id = d.id and x.status = 'active')::int as active_runs from workflow_defs d where d.project_id = $1 order by d.name`, [req.params.id]);
    const runs = await db.query(`${RUN_SELECT} where r.project_id = $1 order by (r.status = 'active') desc, r.started_at desc limit 200`, [req.params.id]);
    return { definitions: defs.rows.map(mapDef), runs: runs.rows.map(mapRun) };
  });

  app.post<{ Params: { id: string }; Body: { name: string; description?: string | null; steps: unknown } }>('/projects/:id/workflows', async (req) => {
    const user = requireUser(req);
    await requirePlan(user, req.params.id);
    const name = String(req.body?.name ?? '').trim().slice(0, 200);
    if (!name) throw badRequest('Name erforderlich');
    const steps = validateSteps(req.body?.steps);
    const r = await db.one(`insert into workflow_defs (org_id, project_id, name, description, steps, created_by) values ($1,$2,$3,$4,$5,$6) returning *`, [user.orgId, req.params.id, name, req.body?.description?.trim() || null, JSON.stringify(steps), user.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'workflow.create', objectType: 'workflow', objectId: r.id, details: { name, steps: steps.length } });
    return { definition: mapDef(r) };
  });

  app.patch<{ Params: { id: string; wid: string }; Body: { name?: string; description?: string | null; steps?: unknown; active?: boolean } }>('/projects/:id/workflows/:wid', async (req) => {
    const user = requireUser(req);
    await requirePlan(user, req.params.id);
    const d = await db.maybeOne(`select * from workflow_defs where id = $1 and project_id = $2`, [req.params.wid, req.params.id]);
    if (!d) throw notFound('Workflow nicht gefunden');
    const b = req.body ?? {};
    const steps = b.steps !== undefined ? validateSteps(b.steps) : null;
    const r = await db.one(
      `update workflow_defs set name = coalesce($2, name), description = case when $3 then $4 else description end, steps = coalesce($5::jsonb, steps), active = coalesce($6, active), updated_at = now() where id = $1 returning *`,
      [d.id, b.name?.trim() || null, 'description' in b, b.description?.trim() || null, steps ? JSON.stringify(steps) : null, typeof b.active === 'boolean' ? b.active : null]
    );
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'workflow.update', objectType: 'workflow', objectId: d.id, details: { name: r.name } });
    return { definition: mapDef(r) };
  });

  app.delete<{ Params: { id: string; wid: string } }>('/projects/:id/workflows/:wid', async (req) => {
    const user = requireUser(req);
    await requirePlan(user, req.params.id);
    const active = await db.maybeOne(`select 1 from workflow_runs where def_id = $1 and status = 'active'`, [req.params.wid]);
    if (active) throw badRequest('Es laufen noch Instanzen dieses Workflows. Erst abbrechen oder abwarten.');
    await db.query(`delete from workflow_defs where id = $1 and project_id = $2`, [req.params.wid, req.params.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'workflow.delete', objectType: 'workflow', objectId: req.params.wid });
    return { ok: true };
  });

  // Lauf starten: im Board (columnId/subprojectId) oder eigenständig (standalone)
  app.post<{ Params: { id: string; wid: string }; Body: { name?: string; columnId?: string | null; subprojectId?: string | null; standalone?: boolean; vars?: Record<string, string> } }>('/projects/:id/workflows/:wid/start', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const d = await db.maybeOne(`select * from workflow_defs where id = $1 and project_id = $2 and active`, [req.params.wid, req.params.id]);
    if (!d) throw notFound('Workflow nicht gefunden oder inaktiv');
    const b = req.body ?? {};
    if (b.columnId && !(await db.maybeOne(`select 1 from board_columns where id = $1 and project_id = $2`, [b.columnId, req.params.id]))) throw badRequest('Spalte gehört nicht zum Projekt');
    if (b.subprojectId && !(await db.maybeOne(`select 1 from subprojects where id = $1 and project_id = $2`, [b.subprojectId, req.params.id]))) throw badRequest('Teilprojekt gehört nicht zum Projekt');
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.vars ?? {})) if (/^[\p{L}\p{N}_-]{1,40}$/u.test(k)) vars[k] = String(v ?? '').slice(0, 500);
    const name = String(b.name ?? '').trim().slice(0, 200) || `${d.name} ${new Date().toLocaleDateString('de-DE')}`;
    const r = await db.one(
      `insert into workflow_runs (def_id, project_id, name, def_name, steps, state, vars, standalone, column_id, subproject_id, started_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [d.id, req.params.id, name, d.name, JSON.stringify(d.steps), JSON.stringify((d.steps as WorkflowStep[]).map((s) => ({ key: s.key, status: 'pending' }))), JSON.stringify(vars), Boolean(b.standalone), b.columnId ?? null, b.subprojectId ?? null, user.id]
    );
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'workflow.start', objectType: 'workflow_run', objectId: r.id, details: { name, workflow: d.name } });
    await advanceRun(db, app.mail, r.id);
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [r.id])) };
  });

  app.get<{ Params: { id: string; rid: string } }>('/projects/:id/workflow-runs/:rid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'reader');
    const r = await db.maybeOne(`${RUN_SELECT} where r.id = $1 and r.project_id = $2`, [req.params.rid, req.params.id]);
    if (!r) throw notFound('Lauf nicht gefunden');
    const tasks = await loadTasks(db, `t.workflow_run_id = $1 and t.deleted_at is null`, [r.id], await resolveProjectLead(db, req.params.id));
    return { run: mapRun(r), tasks };
  });

  app.post<{ Params: { id: string; rid: string } }>('/projects/:id/workflow-runs/:rid/approve', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    if (m.role !== 'pl' && !m.canApprove) throw forbidden('Freigabe erfordert die PL-Rolle oder das Recht „freigeben“');
    const r = await db.maybeOne(`select id from workflow_runs where id = $1 and project_id = $2`, [req.params.rid, req.params.id]);
    if (!r) throw notFound('Lauf nicht gefunden');
    await approveRun(db, app.mail, r.id, user.id);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'workflow.approve', objectType: 'workflow_run', objectId: r.id });
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [r.id])) };
  });

  app.post<{ Params: { id: string; rid: string }; Body: { note?: string } }>('/projects/:id/workflow-runs/:rid/skip', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const r = await db.maybeOne(`select id from workflow_runs where id = $1 and project_id = $2`, [req.params.rid, req.params.id]);
    if (!r) throw notFound('Lauf nicht gefunden');
    await skipStep(db, app.mail, r.id, `Übersprungen von ${user.name}${req.body?.note ? `: ${req.body.note}` : ''}`);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'workflow.skip', objectType: 'workflow_run', objectId: r.id, details: { note: req.body?.note ?? null } });
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [r.id])) };
  });

  app.post<{ Params: { id: string; rid: string } }>('/projects/:id/workflow-runs/:rid/cancel', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    const r = await db.maybeOne(`select id, started_by from workflow_runs where id = $1 and project_id = $2`, [req.params.rid, req.params.id]);
    if (!r) throw notFound('Lauf nicht gefunden');
    if (m.role !== 'pl' && r.started_by !== user.id) throw forbidden('Abbrechen darf die PL oder wer den Lauf gestartet hat');
    await cancelRun(db, r.id, user.id);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'workflow.cancel', objectType: 'workflow_run', objectId: r.id });
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [r.id])) };
  });

  // Manuelles Weiterschalten (prüft Timer/Mails/Arbeitspakete sofort statt auf den Worker zu warten)
  app.post<{ Params: { id: string; rid: string } }>('/projects/:id/workflow-runs/:rid/check', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const r = await db.maybeOne(`select id from workflow_runs where id = $1 and project_id = $2`, [req.params.rid, req.params.id]);
    if (!r) throw notFound('Lauf nicht gefunden');
    await advanceRun(db, app.mail, r.id);
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [r.id])) };
  });
}

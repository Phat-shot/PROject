import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { loadTasks, resolveProjectLead } from '../tasks/service.js';
import { DEFAULT_COLUMNS } from './projects.js';
import { advanceRun, approveRun, cancelRun, skipStep, validateSteps, type StepState, type WorkflowStep } from '../workflows/engine.js';

/**
 * Workflows sind ein eigener Bereich neben den Projekten: Vorlagen (Schrittfolgen) gelten mandantenweit.
 * Eine Instanz (Lauf) startet entweder isoliert in einem eigenen Mini-Projekt (projects.kind = 'workflow')
 * oder im Projekt statt eines Arbeitspakets (Arbeitspakete in Spalte/Teilprojekt).
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
      id: r.id, defId: r.def_id, projectId: r.project_id, projectKey: r.project_key ?? null, projectName: r.project_name ?? null, projectKind: r.project_kind ?? 'project',
      name: r.name, defName: r.def_name, steps, state, vars: r.vars ?? {}, status: r.status, currentStep: r.current_step,
      standalone: Boolean(r.standalone), columnId: r.column_id, subprojectId: r.subproject_id, startedBy: r.started_by, startedByName: r.started_by_name ?? null, startedAt: r.started_at, finishedAt: r.finished_at, lastError: r.last_error,
      doneSteps: state.filter((s) => s.status === 'done' || s.status === 'skipped').length, totalSteps: steps.length, waitingOn
    };
  };
  const RUN_SELECT = `select r.*, u.name as started_by_name, p.key as project_key, p.name as project_name, p.kind as project_kind from workflow_runs r left join users u on u.id = r.started_by join projects p on p.id = r.project_id`;
  const DEF_SELECT = `select d.*, (select count(*) from workflow_runs x where x.def_id = d.id)::int as run_count, (select count(*) from workflow_runs x where x.def_id = d.id and x.status = 'active')::int as active_runs from workflow_defs d`;

  const canBuild = (user: any) => ['org_admin', 'project_creator'].includes(user.globalRole);

  async function loadDef(user: any, wid: string, projectId?: string) {
    const d = await db.maybeOne(`select * from workflow_defs where id = $1 and org_id = $2`, [wid, user.orgId]);
    if (!d) throw notFound('Workflow nicht gefunden');
    if (d.project_id && projectId && d.project_id !== projectId) throw notFound('Workflow nicht gefunden');
    return d;
  }

  async function runAccess(user: any, rid: string, min: 'reader' | 'member' | 'pl' = 'reader') {
    const r = await db.maybeOne(`select * from workflow_runs where id = $1`, [rid]);
    if (!r) throw notFound('Lauf nicht gefunden');
    const m = await requireProject(db, user, r.project_id, min);
    return { run: r, membership: m };
  }

  async function startRun(user: any, def: any, opts: { name?: string | null; vars?: Record<string, string>; projectId: string; columnId?: string | null; subprojectId?: string | null; standalone: boolean }) {
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.vars ?? {})) if (/^[\p{L}\p{N}_-]{1,40}$/u.test(k)) vars[k] = String(v ?? '').slice(0, 500);
    const name = String(opts.name ?? '').trim().slice(0, 200) || `${def.name} ${new Date().toLocaleDateString('de-DE')}`;
    const r = await db.one(
      `insert into workflow_runs (def_id, project_id, name, def_name, steps, state, vars, standalone, column_id, subproject_id, started_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [def.id, opts.projectId, name, def.name, JSON.stringify(def.steps), JSON.stringify((def.steps as WorkflowStep[]).map((s) => ({ key: s.key, status: 'pending' }))), JSON.stringify(vars), opts.standalone, opts.columnId ?? null, opts.subprojectId ?? null, user.id]
    );
    await audit(db, { orgId: user.orgId, projectId: opts.projectId, userId: user.id, action: 'workflow.start', objectType: 'workflow_run', objectId: r.id, details: { name, workflow: def.name, standalone: opts.standalone } });
    await advanceRun(db, app.mail, r.id);
    return mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [r.id]));
  }

  // ---------- Bereich „Workflows“ (mandantenweit) ----------

  app.get('/workflows', async (req) => {
    const user = requireUser(req);
    const defs = await db.query(`${DEF_SELECT} where d.org_id = $1 and d.project_id is null order by d.name`, [user.orgId]);
    const runs = await db.query(
      `${RUN_SELECT} where p.org_id = $2 and (exists (select 1 from project_members m where m.project_id = r.project_id and m.user_id = $1) or $3) order by (r.status = 'active') desc, r.started_at desc limit 300`,
      [user.id, user.orgId, user.globalRole === 'org_admin']
    );
    return { definitions: defs.rows.map(mapDef), runs: runs.rows.map(mapRun), canBuild: canBuild(user) };
  });

  app.post<{ Body: { name: string; description?: string | null; steps: unknown } }>('/workflows', async (req) => {
    const user = requireUser(req);
    if (!canBuild(user)) throw forbidden('Workflow-Vorlagen bauen Org-Admins und Projektersteller');
    const name = String(req.body?.name ?? '').trim().slice(0, 200);
    if (!name) throw badRequest('Name erforderlich');
    const steps = validateSteps(req.body?.steps);
    const r = await db.one(`insert into workflow_defs (org_id, project_id, name, description, steps, created_by) values ($1,null,$2,$3,$4,$5) returning *`, [user.orgId, name, req.body?.description?.trim() || null, JSON.stringify(steps), user.id]);
    await audit(db, { orgId: user.orgId, projectId: null, userId: user.id, action: 'workflow.create', objectType: 'workflow', objectId: r.id, details: { name, steps: steps.length } });
    return { definition: mapDef(r) };
  });

  app.patch<{ Params: { wid: string }; Body: { name?: string; description?: string | null; steps?: unknown; active?: boolean } }>('/workflows/:wid', async (req) => {
    const user = requireUser(req);
    if (!canBuild(user)) throw forbidden('Workflow-Vorlagen bauen Org-Admins und Projektersteller');
    const d = await loadDef(user, req.params.wid);
    const b = req.body ?? {};
    const steps = b.steps !== undefined ? validateSteps(b.steps) : null;
    const r = await db.one(
      `update workflow_defs set name = coalesce($2, name), description = case when $3 then $4 else description end, steps = coalesce($5::jsonb, steps), active = coalesce($6, active), updated_at = now() where id = $1 returning *`,
      [d.id, b.name?.trim() || null, 'description' in b, b.description?.trim() || null, steps ? JSON.stringify(steps) : null, typeof b.active === 'boolean' ? b.active : null]
    );
    await audit(db, { orgId: user.orgId, projectId: d.project_id, userId: user.id, action: 'workflow.update', objectType: 'workflow', objectId: d.id, details: { name: r.name } });
    return { definition: mapDef(r) };
  });

  app.delete<{ Params: { wid: string } }>('/workflows/:wid', async (req) => {
    const user = requireUser(req);
    if (!canBuild(user)) throw forbidden('Workflow-Vorlagen bauen Org-Admins und Projektersteller');
    const d = await loadDef(user, req.params.wid);
    if (await db.maybeOne(`select 1 from workflow_runs where def_id = $1 and status = 'active'`, [d.id])) throw badRequest('Es laufen noch Instanzen dieses Workflows. Erst abbrechen oder abwarten.');
    await db.query(`delete from workflow_defs where id = $1`, [d.id]);
    await audit(db, { orgId: user.orgId, projectId: d.project_id, userId: user.id, action: 'workflow.delete', objectType: 'workflow', objectId: d.id });
    return { ok: true };
  });

  // Isolierte Instanz: eigenes Mini-Projekt (kind workflow), Starter ist PL
  app.post<{ Params: { wid: string }; Body: { name?: string; vars?: Record<string, string> } }>('/workflows/:wid/start', async (req) => {
    const user = requireUser(req);
    if (user.kind === 'agent') throw forbidden('KI-Agenten starten keine Workflows');
    const d = await loadDef(user, req.params.wid);
    if (!d.active) throw badRequest('Workflow ist inaktiv');
    const name = String(req.body?.name ?? '').trim().slice(0, 200) || `${d.name} ${new Date().toLocaleDateString('de-DE')}`;
    const n = await db.one(`select count(*)::int as c from projects where org_id = $1 and kind = 'workflow'`, [user.orgId]);
    let key = ''; for (let i = n.c + 1; i < n.c + 1000; i++) { key = `WF${i}`; if (!(await db.maybeOne(`select 1 from projects where org_id = $1 and key = $2`, [user.orgId, key]))) break; }
    const p = await db.one(`insert into projects (org_id, key, name, description, created_by, kind, visibility) values ($1,$2,$3,$4,$5,'workflow','members') returning *`, [user.orgId, key, name, `Isolierter Lauf des Workflows „${d.name}“`, user.id]);
    await db.query(`insert into project_members (project_id, user_id, role, can_edit_plan, can_approve, can_finalize, can_use_ai) values ($1,$2,'pl',true,true,true,true)`, [p.id, user.id]);
    for (const [i, [cname, kind]] of DEFAULT_COLUMNS.entries()) await db.query(`insert into board_columns (project_id, name, position, is_done, kind) values ($1,$2,$3,$4,$5)`, [p.id, cname, i, kind === 'done', kind]);
    await audit(db, { orgId: user.orgId, projectId: p.id, userId: user.id, action: 'project.create', objectType: 'project', objectId: p.id, details: { key, name, kind: 'workflow' } });
    return { run: await startRun(user, d, { name, vars: req.body?.vars, projectId: p.id, standalone: true }) };
  });

  app.get<{ Params: { rid: string } }>('/workflow-runs/:rid', async (req) => {
    const user = requireUser(req);
    const { run } = await runAccess(user, req.params.rid);
    const tasks = await loadTasks(db, `t.workflow_run_id = $1 and t.deleted_at is null`, [run.id], await resolveProjectLead(db, run.project_id));
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [run.id])), tasks };
  });

  app.post<{ Params: { rid: string } }>('/workflow-runs/:rid/approve', async (req) => {
    const user = requireUser(req);
    const { run, membership: m } = await runAccess(user, req.params.rid, 'member');
    if (m.role !== 'pl' && !m.canApprove) throw forbidden('Freigabe erfordert die PL-Rolle oder das Recht „Freigeben“');
    await approveRun(db, app.mail, run.id, user.id);
    await audit(db, { orgId: user.orgId, projectId: run.project_id, userId: user.id, action: 'workflow.approve', objectType: 'workflow_run', objectId: run.id });
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [run.id])) };
  });

  app.post<{ Params: { rid: string }; Body: { note?: string } }>('/workflow-runs/:rid/skip', async (req) => {
    const user = requireUser(req);
    const { run } = await runAccess(user, req.params.rid, 'pl');
    await skipStep(db, app.mail, run.id, `Übersprungen von ${user.name}${req.body?.note ? `: ${req.body.note}` : ''}`);
    await audit(db, { orgId: user.orgId, projectId: run.project_id, userId: user.id, action: 'workflow.skip', objectType: 'workflow_run', objectId: run.id, details: { note: req.body?.note ?? null } });
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [run.id])) };
  });

  app.post<{ Params: { rid: string } }>('/workflow-runs/:rid/cancel', async (req) => {
    const user = requireUser(req);
    const { run, membership: m } = await runAccess(user, req.params.rid, 'member');
    if (m.role !== 'pl' && run.started_by !== user.id) throw forbidden('Abbrechen darf die PL oder wer den Lauf gestartet hat');
    await cancelRun(db, run.id, user.id);
    await audit(db, { orgId: user.orgId, projectId: run.project_id, userId: user.id, action: 'workflow.cancel', objectType: 'workflow_run', objectId: run.id });
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [run.id])) };
  });

  app.post<{ Params: { rid: string } }>('/workflow-runs/:rid/check', async (req) => {
    const user = requireUser(req);
    const { run } = await runAccess(user, req.params.rid, 'member');
    await advanceRun(db, app.mail, run.id);
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [run.id])) };
  });

  // ---------- Im Projekt: Vorlagen sehen, Lauf statt Arbeitspaket starten, Läufe des Projekts ----------

  app.get<{ Params: { id: string } }>('/projects/:id/workflows', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'reader');
    const defs = await db.query(`${DEF_SELECT} where d.org_id = $2 and d.active and (d.project_id is null or d.project_id = $1) order by d.name`, [req.params.id, user.orgId]);
    const runs = await db.query(`${RUN_SELECT} where r.project_id = $1 order by (r.status = 'active') desc, r.started_at desc limit 200`, [req.params.id]);
    return { definitions: defs.rows.map(mapDef), runs: runs.rows.map(mapRun) };
  });

  app.post<{ Params: { id: string; wid: string }; Body: { name?: string; columnId?: string | null; subprojectId?: string | null; vars?: Record<string, string> } }>('/projects/:id/workflows/:wid/start', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const d = await loadDef(user, req.params.wid, req.params.id);
    if (!d.active) throw badRequest('Workflow ist inaktiv');
    const b = req.body ?? {};
    if (b.columnId && !(await db.maybeOne(`select 1 from board_columns where id = $1 and project_id = $2`, [b.columnId, req.params.id]))) throw badRequest('Spalte gehört nicht zum Projekt');
    if (b.subprojectId && !(await db.maybeOne(`select 1 from subprojects where id = $1 and project_id = $2`, [b.subprojectId, req.params.id]))) throw badRequest('Teilprojekt gehört nicht zum Projekt');
    return { run: await startRun(user, d, { name: b.name, vars: b.vars, projectId: req.params.id, columnId: b.columnId, subprojectId: b.subprojectId, standalone: false }) };
  });

  // Projektbezogene Aliase (gleiche Prüfungen wie die globalen Routen)
  app.get<{ Params: { id: string; rid: string } }>('/projects/:id/workflow-runs/:rid', async (req) => {
    const user = requireUser(req);
    const { run } = await runAccess(user, req.params.rid);
    if (run.project_id !== req.params.id) throw notFound('Lauf nicht gefunden');
    const tasks = await loadTasks(db, `t.workflow_run_id = $1 and t.deleted_at is null`, [run.id], await resolveProjectLead(db, run.project_id));
    return { run: mapRun(await db.one(`${RUN_SELECT} where r.id = $1`, [run.id])), tasks };
  });
}

import type { FastifyInstance } from 'fastify';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { getMembership, requireProject } from '../rights.js';
import { loadTask, mapSubproject, newMailCode, resolveProjectLead } from '../tasks/service.js';
import { uploadDir } from '../docs/layout.js';

/**
 * Kopieren und Verschieben von Arbeitspaketen und Teilprojekten, auch in andere Projekte.
 * parts = Liste der Bestandteile, die mitgenommen werden (vom Client aus „Alles / Alles außer / Nichts außer“ aufgelöst).
 */
export const TASK_PARTS = ['subtasks', 'checklist', 'comments', 'attachments', 'mails', 'labels', 'dependencies', 'responsible', 'dates', 'time'] as const;
export const SUBPROJECT_PARTS = ['tasks', 'milestones', 'access', ...TASK_PARTS] as const;
type Part = (typeof SUBPROJECT_PARTS)[number];

interface CopyBody { targetProjectId?: string | null; subprojectId?: string | null; columnId?: string | null; parts?: string[]; taskIds?: string[]; name?: string | null; title?: string | null }

export async function copyRoutes(app: FastifyInstance) {
  const db = app.db;

  const partsOf = (b: CopyBody, allowed: readonly string[]): Set<Part> => new Set((Array.isArray(b.parts) ? b.parts : [...allowed]).filter((p) => allowed.includes(p)) as Part[]);

  /** Zielprojekt: gleiches Projekt (Mitglied reicht) oder anderes Projekt des Mandanten, dort PL oder „Projektplan ändern“. */
  async function targetOf(user: any, sourceProjectId: string, b: CopyBody, mustPlan: boolean) {
    const targetId = b.targetProjectId || sourceProjectId;
    const tm = await requireProject(db, user, targetId, 'member');
    if ((mustPlan || targetId !== sourceProjectId) && tm.role !== 'pl' && !tm.canEditPlan) throw forbidden('Im Zielprojekt ist das Recht „Projektplan ändern“ nötig');
    const project = await db.one(`select id, key, name, status from projects where id = $1`, [targetId]);
    if (project.status === 'archived') throw badRequest('Zielprojekt ist archiviert');
    return { id: targetId as string, key: project.key as string, membership: tm };
  }

  /** Spalte im Ziel: gewünschte Spalte, sonst gleichnamige, sonst die erste. */
  async function columnFor(targetProjectId: string, sourceColumnId: string | null, wanted: string | null | undefined): Promise<string> {
    if (wanted) {
      const c = await db.maybeOne(`select id from board_columns where id = $1 and project_id = $2`, [wanted, targetProjectId]);
      if (!c) throw badRequest('Spalte gehört nicht zum Zielprojekt');
      return c.id;
    }
    if (sourceColumnId) {
      const same = await db.maybeOne(`select t.id from board_columns t join board_columns s on lower(s.name) = lower(t.name) where s.id = $1 and t.project_id = $2 and not t.is_done order by t.position limit 1`, [sourceColumnId, targetProjectId]);
      if (same) return same.id;
    }
    return (await db.one(`select id from board_columns where project_id = $1 order by position limit 1`, [targetProjectId])).id;
  }

  async function subprojectFor(targetProjectId: string, wanted: string | null | undefined): Promise<string | null> {
    if (!wanted) return null;
    const s = await db.maybeOne(`select id from subprojects where id = $1 and project_id = $2`, [wanted, targetProjectId]);
    if (!s) throw badRequest('Teilprojekt gehört nicht zum Zielprojekt');
    return s.id;
  }

  /** Label im Ziel mit gleichem Namen, sonst neu anlegen. */
  const labelCache = new Map<string, string>();
  async function labelFor(targetProjectId: string, labelId: string): Promise<string> {
    const key = `${targetProjectId}:${labelId}`;
    const hit = labelCache.get(key);
    if (hit) return hit;
    const src = await db.one(`select name, color, project_id from labels where id = $1`, [labelId]);
    if (src.project_id === targetProjectId) return labelId;
    let l = await db.maybeOne(`select id from labels where project_id = $1 and lower(name) = lower($2)`, [targetProjectId, src.name]);
    if (!l) {
      const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from labels where project_id = $1`, [targetProjectId]);
      l = await db.one(`insert into labels (project_id, name, color, position) values ($1,$2,$3,$4) returning id`, [targetProjectId, src.name, src.color, pos.p]);
    }
    labelCache.set(key, l.id);
    return l.id;
  }

  /** Zuständige Person bleibt nur, wenn sie im Zielprojekt Mitglied ist. */
  async function responsibleFor(targetProjectId: string, sourceProjectId: string, userId: string | null): Promise<string | null> {
    if (!userId || targetProjectId === sourceProjectId) return userId;
    return (await getMembership(db, targetProjectId, userId)) ? userId : null;
  }

  async function copyAttachments(fromTaskId: string, toTaskId: string, targetProjectId: string, userId: string) {
    const rows = await db.query(`select * from attachments where task_id = $1`, [fromTaskId]);
    await mkdir(uploadDir, { recursive: true });
    for (const a of rows.rows) {
      const storage = path.join(uploadDir, `${randomUUID()}${path.extname(a.storage_path)}`);
      try { await copyFile(a.storage_path, storage); } catch { continue; }
      await db.query(`insert into attachments (project_id, task_id, filename, mime, size, storage_path, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7)`, [targetProjectId, toTaskId, a.filename, a.mime, a.size, storage, userId]);
    }
  }

  /** Ein Arbeitspaket kopieren; gibt die neue ID zurück. Abhängigkeiten werden vom Aufrufer über idMap nachgezogen. */
  async function copyTask(src: any, target: { id: string }, opts: { columnId: string; subprojectId: string | null; parts: Set<Part>; userId: string; title?: string | null; sourceProjectId: string; parentId?: string | null; idMap?: Map<string, string> }): Promise<string> {
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1`, [opts.columnId]);
    const keepResp = opts.parts.has('responsible');
    const keepDates = opts.parts.has('dates');
    const r = await db.one(
      `insert into tasks (project_id, subproject_id, column_id, title, description, priority, start_date, due_date, responsible_user_id, responsible_email, position, mail_code, created_by, estimate_minutes, recurrence, parent_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
      [target.id, opts.subprojectId, opts.columnId, (opts.title?.trim() || src.title).slice(0, 300), src.description, src.priority,
        keepDates ? src.start_date : null, keepDates ? src.due_date : null,
        keepResp ? await responsibleFor(target.id, opts.sourceProjectId, src.responsible_user_id) : null, keepResp ? src.responsible_email : null,
        pos.p, newMailCode(), opts.userId, src.estimate_minutes, src.recurrence ? JSON.stringify(src.recurrence) : null, opts.parentId ?? null]
    );
    opts.idMap?.set(src.id, r.id);
    if (opts.parts.has('checklist')) {
      const items = await db.query(`select title, responsible_user_id, responsible_email, position from checklist_items where task_id = $1 order by position`, [src.id]);
      for (const i of items.rows) {
        await db.query(`insert into checklist_items (task_id, title, done, responsible_user_id, responsible_email, position) values ($1,$2,false,$3,$4,$5)`,
          [r.id, i.title, keepResp ? await responsibleFor(target.id, opts.sourceProjectId, i.responsible_user_id) : null, keepResp ? i.responsible_email : null, i.position]);
      }
    }
    if (opts.parts.has('comments')) await db.query(`insert into task_comments (task_id, user_id, body, source, mail_id, mentions, created_at) select $1, user_id, body, source, null, '[]'::jsonb, created_at from task_comments where task_id = $2`, [r.id, src.id]);
    if (opts.parts.has('labels')) {
      const ls = await db.query(`select label_id from task_labels where task_id = $1`, [src.id]);
      for (const l of ls.rows) await db.query(`insert into task_labels (task_id, label_id) values ($1,$2) on conflict do nothing`, [r.id, await labelFor(target.id, l.label_id)]);
    }
    if (opts.parts.has('mails')) await db.query(`insert into mail_task_links (mail_id, task_id, copied, linked_by) select mail_id, $1, copied, $3 from mail_task_links where task_id = $2`, [r.id, src.id, opts.userId]);
    if (opts.parts.has('attachments')) await copyAttachments(src.id, r.id, target.id, opts.userId);
    // Aufgaben des Arbeitspakets mitkopieren (Status bleibt, Teilprojekt folgt dem Arbeitspaket)
    if (!src.parent_id && opts.parts.has('subtasks')) {
      const subs = await db.query(`select * from tasks where parent_id = $1 and deleted_at is null and archived_at is null order by position, created_at`, [src.id]);
      for (const c of subs.rows) {
        const columnId = await columnFor(target.id, target.id === opts.sourceProjectId ? null : c.column_id, target.id === opts.sourceProjectId ? c.column_id : null);
        await copyTask(c, target, { ...opts, columnId, title: null, parentId: r.id });
      }
    }
    return r.id;
  }

  /** Abhängigkeiten innerhalb einer kopierten Menge nachziehen; bei Einzelkopie im selben Projekt bleiben die Vorgänger. */
  async function copyDependencies(idMap: Map<string, string>, sameProject: boolean) {
    for (const [oldId, newId] of idMap) {
      const deps = await db.query(`select predecessor_id from task_dependencies where successor_id = $1`, [oldId]);
      for (const d of deps.rows) {
        const mapped = idMap.get(d.predecessor_id) ?? (sameProject ? d.predecessor_id : null);
        if (mapped && mapped !== newId) await db.query(`insert into task_dependencies (predecessor_id, successor_id) values ($1,$2) on conflict do nothing`, [mapped, newId]);
      }
    }
  }

  /** Ein Arbeitspaket in ein anderes Projekt verschieben (Nummer neu, Spalte/Labels/Zuständigkeit abgeglichen). */
  async function moveTaskToProject(src: any, target: { id: string }, opts: { columnId: string; subprojectId: string | null; parts: Set<Part>; keepDeps: Set<string>; keepParent?: boolean }) {
    const resp = opts.parts.has('responsible') ? await responsibleFor(target.id, src.project_id, src.responsible_user_id) : null;
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1`, [opts.columnId]);
    // Aufgaben gehen immer mit ihrem Arbeitspaket; eine einzeln verschobene Aufgabe wird im Ziel zum Arbeitspaket
    const children = src.parent_id ? [] : (await db.query(`select * from tasks where parent_id = $1`, [src.id])).rows;
    const keepDeps = new Set([...opts.keepDeps, src.id, ...children.map((c: any) => c.id as string)]);
    await db.query(
      `update tasks set project_id = $2, column_id = $3, subproject_id = $4, position = $5, responsible_user_id = $6, responsible_email = $7,
         start_date = case when $8 then start_date end, due_date = case when $8 then due_date end,
         parent_id = case when $9 then parent_id end,
         number = (select coalesce(max(number), 0) + 1 from tasks x where x.project_id = $2), updated_at = now(), agent_wait = null, agent_next_check_at = null
       where id = $1`,
      [src.id, target.id, opts.columnId, opts.subprojectId, pos.p, resp, opts.parts.has('responsible') ? src.responsible_email : null, opts.parts.has('dates'), Boolean(opts.keepParent)]
    );
    if (!opts.parts.has('checklist')) await db.query(`delete from checklist_items where task_id = $1`, [src.id]);
    else await db.query(`update checklist_items set responsible_user_id = null where task_id = $1 and responsible_user_id is not null and not exists (select 1 from project_members pm where pm.project_id = $2 and pm.user_id = checklist_items.responsible_user_id)`, [src.id, target.id]);
    if (!opts.parts.has('comments')) await db.query(`delete from task_comments where task_id = $1`, [src.id]);
    if (!opts.parts.has('mails')) await db.query(`delete from mail_task_links where task_id = $1`, [src.id]);
    if (opts.parts.has('attachments')) await db.query(`update attachments set project_id = $2 where task_id = $1`, [src.id, target.id]);
    else await db.query(`delete from attachments where task_id = $1`, [src.id]);
    if (opts.parts.has('labels')) {
      const ls = await db.query(`select label_id from task_labels where task_id = $1`, [src.id]);
      await db.query(`delete from task_labels where task_id = $1`, [src.id]);
      for (const l of ls.rows) await db.query(`insert into task_labels (task_id, label_id) values ($1,$2) on conflict do nothing`, [src.id, await labelFor(target.id, l.label_id)]);
    } else await db.query(`delete from task_labels where task_id = $1`, [src.id]);
    if (opts.parts.has('time')) await db.query(`update time_entries set project_id = $2 where task_id = $1`, [src.id, target.id]);
    else await db.query(`update time_entries set task_id = null where task_id = $1`, [src.id]);
    // Abhängigkeiten nur innerhalb der verschobenen Menge behalten
    await db.query(`delete from task_dependencies where (successor_id = $1 and predecessor_id <> all($2::uuid[])) or (predecessor_id = $1 and successor_id <> all($2::uuid[]))`, [src.id, [...keepDeps]]);
    if (!opts.parts.has('dependencies')) await db.query(`delete from task_dependencies where successor_id = $1 or predecessor_id = $1`, [src.id]);
    await db.query(`delete from meeting_tasks where task_id = $1`, [src.id]);
    await db.query(`update mail_drafts set project_id = $2 where task_id = $1`, [src.id, target.id]);
    await db.query(`update agent_runs set project_id = $2 where task_id = $1`, [src.id, target.id]);
    for (const c of children) {
      await moveTaskToProject(c, target, { ...opts, columnId: await columnFor(target.id, c.column_id, null), keepDeps, keepParent: true });
    }
  }

  async function loadSource(taskId: string) {
    const t = await db.maybeOne(`select * from tasks where id = $1 and deleted_at is null`, [taskId]);
    if (!t) throw notFound('Arbeitspaket nicht gefunden');
    return t;
  }

  // Arbeitspaket kopieren (ins gleiche oder ein anderes Projekt)
  app.post<{ Params: { id: string }; Body: CopyBody }>('/tasks/:id/copy', async (req) => {
    const user = requireUser(req);
    const src = await loadSource(req.params.id);
    await requireProject(db, user, src.project_id, 'member');
    const b = req.body ?? {};
    const target = await targetOf(user, src.project_id, b, false);
    const parts = partsOf(b, TASK_PARTS);
    const columnId = await columnFor(target.id, target.id === src.project_id ? null : src.column_id, b.columnId);
    const subprojectId = target.id === src.project_id && b.subprojectId === undefined ? src.subproject_id : await subprojectFor(target.id, b.subprojectId);
    // Eine Aufgabe bleibt als Kopie beim selben Arbeitspaket; in einem anderen Projekt wird sie zum Arbeitspaket
    const parentId = src.parent_id && target.id === src.project_id ? src.parent_id : null;
    const idMap = new Map<string, string>();
    const newId = await copyTask(src, target, { columnId, subprojectId, parts, userId: user.id, title: b.title ?? (target.id === src.project_id ? `${src.title} (Kopie)` : null), sourceProjectId: src.project_id, parentId, idMap });
    if (parts.has('dependencies')) await copyDependencies(idMap, target.id === src.project_id);
    await audit(db, { orgId: user.orgId, projectId: target.id, userId: user.id, action: 'task.copy', objectType: 'task', objectId: newId, details: { from: src.id, fromProject: src.project_id, parts: [...parts] } });
    return { task: await loadTask(db, newId), projectId: target.id, projectKey: target.key };
  });

  // Arbeitspaket in ein anderes Projekt verschieben
  app.post<{ Params: { id: string }; Body: CopyBody }>('/tasks/:id/move-to-project', async (req) => {
    const user = requireUser(req);
    const src = await loadSource(req.params.id);
    const sm = await requireProject(db, user, src.project_id, 'member');
    if (sm.role !== 'pl' && !sm.canEditPlan) throw forbidden('Verschieben in ein anderes Projekt erfordert das Recht „Projektplan ändern“');
    const b = req.body ?? {};
    if (!b.targetProjectId || b.targetProjectId === src.project_id) throw badRequest('Zielprojekt fehlt oder ist das Quellprojekt');
    const target = await targetOf(user, src.project_id, b, true);
    const parts = partsOf(b, TASK_PARTS);
    const columnId = await columnFor(target.id, src.column_id, b.columnId);
    const subprojectId = await subprojectFor(target.id, b.subprojectId);
    const fromKey = `${(await db.one(`select key from projects where id = $1`, [src.project_id])).key}-${src.number}`;
    await moveTaskToProject(src, target, { columnId, subprojectId, parts, keepDeps: new Set() });
    await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [src.id, user.id, `Aus Projekt ${fromKey} hierher verschoben`]);
    await audit(db, { orgId: user.orgId, projectId: target.id, userId: user.id, action: 'task.move_project', objectType: 'task', objectId: src.id, details: { fromProject: src.project_id, parts: [...parts] } });
    await audit(db, { orgId: user.orgId, projectId: src.project_id, userId: user.id, action: 'task.move_project', objectType: 'task', objectId: src.id, details: { toProject: target.id } });
    return { task: await loadTask(db, src.id), projectId: target.id, projectKey: target.key };
  });

  async function loadSub(projectId: string, sid: string) {
    const s = await db.maybeOne(`select * from subprojects where id = $1 and project_id = $2`, [sid, projectId]);
    if (!s) throw notFound('Teilprojekt nicht gefunden');
    return s;
  }

  async function subTasks(sid: string, taskIds: string[] | undefined) {
    const rows = await db.query(`select * from tasks where subproject_id = $1 and parent_id is null and deleted_at is null and archived_at is null order by position, created_at`, [sid]);
    return Array.isArray(taskIds) ? rows.rows.filter((t: any) => taskIds.includes(t.id)) : rows.rows;
  }

  // Teilprojekt kopieren (mit ausgewählten Arbeitspaketen und Meilensteinen)
  app.post<{ Params: { id: string; sid: string }; Body: CopyBody }>('/projects/:id/subprojects/:sid/copy', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    const src = await loadSub(req.params.id, req.params.sid);
    const b = req.body ?? {};
    const target = await targetOf(user, req.params.id, b, true);
    if (target.id === req.params.id && m.role !== 'pl' && !m.canEditPlan) throw forbidden('Teilprojekte anlegen erfordert das Recht „Projektplan ändern“');
    const parts = partsOf(b, SUBPROJECT_PARTS);
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from subprojects where project_id = $1`, [target.id]);
    const keepDates = parts.has('dates');
    const ns = await db.one(
      `insert into subprojects (project_id, name, responsible_user_id, start_date, end_date, position, restricted) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [target.id, (b.name?.trim() || (target.id === req.params.id ? `${src.name} (Kopie)` : src.name)).slice(0, 200), parts.has('responsible') ? await responsibleFor(target.id, req.params.id, src.responsible_user_id) : null,
        keepDates ? src.start_date : null, keepDates ? src.end_date : null, pos.p, parts.has('access') ? src.restricted : false]
    );
    if (parts.has('access')) await db.query(`insert into subproject_access (subproject_id, user_id, group_id) select $1, user_id, group_id from subproject_access where subproject_id = $2 and (user_id is null or $3 = $4 or exists (select 1 from project_members pm where pm.project_id = $3 and pm.user_id = subproject_access.user_id))`, [ns.id, src.id, target.id, req.params.id]);
    const idMap = new Map<string, string>();
    if (parts.has('tasks')) {
      for (const t of await subTasks(src.id, b.taskIds)) {
        const columnId = await columnFor(target.id, target.id === req.params.id ? null : t.column_id, null);
        await copyTask(t, target, { columnId, subprojectId: ns.id, parts, userId: user.id, sourceProjectId: req.params.id, idMap });
      }
      if (parts.has('dependencies')) await copyDependencies(idMap, target.id === req.params.id);
    }
    if (parts.has('milestones')) await db.query(`insert into milestones (project_id, subproject_id, name, date) select $1, $2, name, date from milestones where subproject_id = $3`, [target.id, ns.id, src.id]);
    await audit(db, { orgId: user.orgId, projectId: target.id, userId: user.id, action: 'subproject.copy', objectType: 'subproject', objectId: ns.id, details: { from: src.id, fromProject: req.params.id, tasks: idMap.size, parts: [...parts] } });
    return { subproject: mapSubproject(await db.one(`select s.*, coalesce((select json_agg(a.user_id) from subproject_access a where a.subproject_id = s.id and a.user_id is not null), '[]'::json) as access_user_ids, coalesce((select json_agg(a.group_id) from subproject_access a where a.subproject_id = s.id and a.group_id is not null), '[]'::json) as access_group_ids from subprojects s where s.id = $1`, [ns.id]), await resolveProjectLead(db, target.id)), projectId: target.id, projectKey: target.key, tasks: idMap.size };
  });

  // Teilprojekt in ein anderes Projekt verschieben
  app.post<{ Params: { id: string; sid: string }; Body: CopyBody }>('/projects/:id/subprojects/:sid/move-to-project', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id, 'member');
    if (m.role !== 'pl' && !m.canEditPlan) throw forbidden('Verschieben erfordert das Recht „Projektplan ändern“');
    const src = await loadSub(req.params.id, req.params.sid);
    const b = req.body ?? {};
    if (!b.targetProjectId || b.targetProjectId === req.params.id) throw badRequest('Zielprojekt fehlt oder ist das Quellprojekt');
    const target = await targetOf(user, req.params.id, b, true);
    const parts = partsOf(b, SUBPROJECT_PARTS);
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from subprojects where project_id = $1`, [target.id]);
    const resp = parts.has('responsible') ? await responsibleFor(target.id, req.params.id, src.responsible_user_id) : null;
    await db.query(`update subprojects set project_id = $2, position = $3, responsible_user_id = $4, start_date = case when $5 then start_date end, end_date = case when $5 then end_date end, restricted = $6 where id = $1`, [src.id, target.id, pos.p, resp, parts.has('dates'), parts.has('access') ? src.restricted : false]);
    if (parts.has('access')) await db.query(`delete from subproject_access where subproject_id = $1 and user_id is not null and not exists (select 1 from project_members pm where pm.project_id = $2 and pm.user_id = subproject_access.user_id)`, [src.id, target.id]);
    else await db.query(`delete from subproject_access where subproject_id = $1`, [src.id]);
    const all = await db.query(`select * from tasks where subproject_id = $1 and parent_id is null and deleted_at is null`, [src.id]);
    const chosen = new Set<string>((parts.has('tasks') ? (Array.isArray(b.taskIds) ? all.rows.filter((t: any) => b.taskIds!.includes(t.id)) : all.rows) : []).map((t: any) => t.id as string));
    // Nicht mitgenommene Arbeitspakete (samt ihren Aufgaben) bleiben im Quellprojekt ohne Teilprojekt
    await db.query(`update tasks set subproject_id = null where subproject_id = $1 and id <> all($2::uuid[]) and (parent_id is null or parent_id <> all($2::uuid[]))`, [src.id, [...chosen]]);
    for (const t of all.rows.filter((x: any) => chosen.has(x.id))) {
      const columnId = await columnFor(target.id, t.column_id, null);
      await moveTaskToProject(t, target, { columnId, subprojectId: src.id, parts, keepDeps: chosen });
    }
    if (parts.has('milestones')) await db.query(`update milestones set project_id = $2 where subproject_id = $1`, [src.id, target.id]);
    else await db.query(`update milestones set subproject_id = null where subproject_id = $1`, [src.id]);
    await audit(db, { orgId: user.orgId, projectId: target.id, userId: user.id, action: 'subproject.move_project', objectType: 'subproject', objectId: src.id, details: { fromProject: req.params.id, tasks: chosen.size, parts: [...parts] } });
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'subproject.move_project', objectType: 'subproject', objectId: src.id, details: { toProject: target.id, tasks: chosen.size } });
    return { ok: true, projectId: target.id, projectKey: target.key, tasks: chosen.size };
  });
}


import type { FastifyInstance } from 'fastify';
import type { DocStatus } from '@projekttool/shared';
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { BUILTIN_TEMPLATES, mapFolder, mapPage, mapTemplate, mapVersion, renderTemplate } from '../docs/service.js';
import { mapAttachment } from './tasks.js';

const TRANSITIONS: Record<DocStatus, DocStatus[]> = { draft: ['review', 'final'], review: ['draft', 'final'], final: ['draft'] };

export async function docRoutes(app: FastifyInstance) {
  const db = app.db;
  const uploadDir = path.resolve(process.env.DATA_DIR ?? '.data', 'uploads');

  app.get<{ Params: { id: string } }>('/projects/:id/docs', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const folders = await db.query(`select * from doc_folders where project_id = $1 order by position, name`, [req.params.id]);
    const pages = await db.query(
      `select p.id, p.project_id, p.folder_id, p.parent_page_id, p.title, p.status, p.version, p.template_key, p.created_by, p.updated_by, p.created_at, p.updated_at, p.finalized_at, '' as content_md, u.name as updated_by_name
       from doc_pages p left join users u on u.id = p.updated_by where p.project_id = $1 order by p.title`,
      [req.params.id]
    );
    const templates = await db.query(`select * from doc_templates where org_id = $1 or org_id is null order by name`, [user.orgId]);
    return { folders: folders.rows.map(mapFolder), pages: pages.rows.map(mapPage), templates: templates.rows.map(mapTemplate) };
  });

  app.post<{ Params: { id: string }; Body: { name: string; parentId?: string | null; distributionList?: string[] } }>('/projects/:id/docs/folders', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const b = req.body ?? ({} as any);
    if (!b.name?.trim()) throw badRequest('Name erforderlich');
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from doc_folders where project_id = $1`, [req.params.id]);
    const r = await db.one(
      `insert into doc_folders (project_id, parent_id, name, position, distribution_list) values ($1,$2,$3,$4,$5) returning *`,
      [req.params.id, b.parentId ?? null, b.name.trim(), pos.p, JSON.stringify(b.distributionList ?? [])]
    );
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'folder.create', objectType: 'doc_folder', objectId: r.id, details: { name: b.name } });
    return { folder: mapFolder(r) };
  });

  app.patch<{ Params: { id: string; fid: string }; Body: { name?: string; distributionList?: string[]; parentId?: string | null } }>('/projects/:id/docs/folders/:fid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const b = req.body ?? {};
    const r = await db.maybeOne(
      `update doc_folders set name = coalesce($3, name), distribution_list = coalesce($4::jsonb, distribution_list),
         parent_id = case when $5 then $6::uuid else parent_id end
       where id = $1 and project_id = $2 returning *`,
      [req.params.fid, req.params.id, b.name ?? null, b.distributionList ? JSON.stringify(b.distributionList) : null, 'parentId' in b, b.parentId ?? null]
    );
    if (!r) throw notFound('Ordner nicht gefunden');
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'folder.update', objectType: 'doc_folder', objectId: r.id, details: b });
    return { folder: mapFolder(r) };
  });

  app.delete<{ Params: { id: string; fid: string } }>('/projects/:id/docs/folders/:fid', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const cnt = await db.one(`select count(*)::int as c from doc_pages where folder_id = $1`, [req.params.fid]);
    if (cnt.c > 0) throw badRequest('Ordner enthält Seiten');
    await db.query(`delete from doc_folders where id = $1 and project_id = $2`, [req.params.fid, req.params.id]);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { title: string; folderId?: string | null; parentPageId?: string | null; templateKey?: string | null; contentMd?: string } }>('/projects/:id/docs/pages', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? ({} as any);
    if (!b.title?.trim()) throw badRequest('Titel erforderlich');
    let content = b.contentMd ?? '';
    if (b.templateKey) {
      const t = await db.maybeOne(`select * from doc_templates where key = $1 and (org_id = $2 or org_id is null) order by org_id nulls last limit 1`, [b.templateKey, user.orgId]);
      if (!t) throw badRequest('Vorlage nicht gefunden');
      content = renderTemplate(t.content_md);
    }
    const r = await db.one(
      `insert into doc_pages (project_id, folder_id, parent_page_id, title, content_md, template_key, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7) returning *`,
      [req.params.id, b.folderId ?? null, b.parentPageId ?? null, b.title.trim(), content, b.templateKey ?? null, user.id]
    );
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, status, saved_by) values ($1,1,$2,$3,'draft',$4)`, [r.id, r.title, r.content_md, user.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'page.create', objectType: 'doc_page', objectId: r.id, details: { title: b.title, templateKey: b.templateKey ?? null } });
    return { page: mapPage(r) };
  });

  app.get<{ Params: { pid: string } }>('/docs/pages/:pid', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select p.*, u.name as updated_by_name from doc_pages p left join users u on u.id = p.updated_by where p.id = $1`, [req.params.pid]);
    if (!r) throw notFound('Seite nicht gefunden');
    await requireProject(db, user, r.project_id);
    const versions = await db.query(
      `select v.id, v.page_id, v.version, v.title, v.status, v.saved_by, v.saved_at, '' as content_md, u.name as saved_by_name from doc_page_versions v left join users u on u.id = v.saved_by where v.page_id = $1 order by v.version desc`,
      [r.id]
    );
    const attachments = await db.query(`select * from attachments where page_id = $1 order by created_at`, [r.id]);
    return { page: mapPage(r), versions: versions.rows.map(mapVersion), attachments: attachments.rows.map(mapAttachment) };
  });

  app.get<{ Params: { pid: string; v: string } }>('/docs/pages/:pid/versions/:v', async (req) => {
    const user = requireUser(req);
    const p = await db.maybeOne(`select project_id from doc_pages where id = $1`, [req.params.pid]);
    if (!p) throw notFound('Seite nicht gefunden');
    await requireProject(db, user, p.project_id);
    const v = await db.maybeOne(`select v.*, u.name as saved_by_name from doc_page_versions v left join users u on u.id = v.saved_by where v.page_id = $1 and v.version = $2`, [req.params.pid, Number(req.params.v)]);
    if (!v) throw notFound('Version nicht gefunden');
    return { version: mapVersion(v) };
  });

  app.patch<{ Params: { pid: string }; Body: { title?: string; contentMd?: string; folderId?: string | null; parentPageId?: string | null; baseVersion?: number } }>('/docs/pages/:pid', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select * from doc_pages where id = $1`, [req.params.pid]);
    if (!r) throw notFound('Seite nicht gefunden');
    await requireProject(db, user, r.project_id, 'member');
    if (r.status === 'final') throw conflict('Finale Seite ist gesperrt. Erst zurück auf Entwurf setzen.');
    const b = req.body ?? {};
    if (b.baseVersion !== undefined && b.baseVersion !== r.version) {
      throw conflict(`Seite wurde zwischenzeitlich geändert (Version ${r.version}). Bitte neu laden.`);
    }
    const contentChanged = b.contentMd !== undefined && b.contentMd !== r.content_md;
    const titleChanged = b.title !== undefined && b.title.trim() !== r.title;
    const newVersion = contentChanged || titleChanged ? r.version + 1 : r.version;
    const u = await db.one(
      `update doc_pages set title = coalesce($2, title), content_md = coalesce($3, content_md),
         folder_id = case when $4 then $5::uuid else folder_id end,
         parent_page_id = case when $6 then $7::uuid else parent_page_id end,
         version = $8, updated_by = $9, updated_at = now()
       where id = $1 returning *`,
      [r.id, b.title?.trim() || null, b.contentMd ?? null, 'folderId' in b, b.folderId ?? null, 'parentPageId' in b, b.parentPageId ?? null, newVersion, user.id]
    );
    if (newVersion !== r.version) {
      await db.query(`insert into doc_page_versions (page_id, version, title, content_md, status, saved_by) values ($1,$2,$3,$4,$5,$6)`, [u.id, newVersion, u.title, u.content_md, u.status, user.id]);
    }
    await audit(db, { orgId: user.orgId, projectId: r.project_id, userId: user.id, action: 'page.update', objectType: 'doc_page', objectId: r.id, details: { version: newVersion } });
    return { page: mapPage(u) };
  });

  // Status: Entwurf → In Prüfung → Final; Final sperrt und versioniert.
  app.post<{ Params: { pid: string }; Body: { status: DocStatus } }>('/docs/pages/:pid/status', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select * from doc_pages where id = $1`, [req.params.pid]);
    if (!r) throw notFound('Seite nicht gefunden');
    const m = await requireProject(db, user, r.project_id, 'member');
    const to = req.body?.status;
    if (!to || !TRANSITIONS[r.status as DocStatus]?.includes(to)) throw badRequest(`Übergang ${r.status} → ${to} nicht erlaubt`);
    if ((to === 'final' || r.status === 'final') && m.role !== 'pl' && !m.canFinalize) throw forbidden('Final setzen erfordert das Recht „Dokument final setzen“');
    const u = await db.one(
      `update doc_pages set status = $2, finalized_at = case when $2 = 'final' then now() else null end, updated_by = $3, updated_at = now() where id = $1 returning *`,
      [r.id, to, user.id]
    );
    await db.query(`update doc_page_versions set status = $3 where page_id = $1 and version = $2`, [u.id, u.version, to]);
    await audit(db, { orgId: user.orgId, projectId: r.project_id, userId: user.id, action: `page.${to}`, objectType: 'doc_page', objectId: r.id, details: { from: r.status, version: u.version } });
    return { page: mapPage(u) };
  });

  app.delete<{ Params: { pid: string } }>('/docs/pages/:pid', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select * from doc_pages where id = $1`, [req.params.pid]);
    if (!r) throw notFound('Seite nicht gefunden');
    await requireProject(db, user, r.project_id, 'pl');
    await db.query(`update doc_pages set parent_page_id = $2 where parent_page_id = $1`, [r.id, r.parent_page_id]);
    await db.query(`delete from doc_pages where id = $1`, [r.id]);
    await audit(db, { orgId: user.orgId, projectId: r.project_id, userId: user.id, action: 'page.delete', objectType: 'doc_page', objectId: r.id, details: { title: r.title } });
    return { ok: true };
  });

  // W5: Finale Seite an den Verteiler des Ordners senden (über Projektkonto, als Mailtext; PDF später)
  app.post<{ Params: { pid: string }; Body: { accountId?: string } }>('/docs/pages/:pid/distribute', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select p.*, f.distribution_list from doc_pages p left join doc_folders f on f.id = p.folder_id where p.id = $1`, [req.params.pid]);
    if (!r) throw notFound('Seite nicht gefunden');
    const m = await requireProject(db, user, r.project_id, 'member');
    if (m.role !== 'pl' && !m.canFinalize) throw forbidden('Versand erfordert das Recht „Versand auslösen“');
    if (r.status !== 'final') throw badRequest('Nur finale Seiten werden versendet');
    const list: string[] = r.distribution_list ?? [];
    if (!list.length) throw badRequest('Der Ordner hat keinen Verteiler');
    const account = req.body?.accountId
      ? await db.maybeOne(`select * from mail_accounts where id = $1 and project_id = $2 and type = 'project'`, [req.body.accountId, r.project_id])
      : await db.maybeOne(`select * from mail_accounts where project_id = $1 and type = 'project' order by created_at limit 1`, [r.project_id]);
    if (!account) throw badRequest('Kein Projektkonto vorhanden');
    const result = await app.mail.sendFromAccount(account, {
      to: list,
      subject: `${r.title} (Version ${r.version})`,
      text: r.content_md,
      userId: user.id,
      projectId: r.project_id
    });
    await audit(db, { orgId: user.orgId, projectId: r.project_id, userId: user.id, action: 'page.distribute', objectType: 'doc_page', objectId: r.id, details: { to: list, version: r.version, messageId: result.messageId } });
    return { ok: true, to: list };
  });

  app.get('/docs/templates', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(`select * from doc_templates where org_id = $1 or org_id is null order by name`, [user.orgId]);
    return { templates: rows.rows.map(mapTemplate) };
  });

  app.put<{ Params: { key: string }; Body: { name: string; contentMd: string } }>('/docs/templates/:key', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Vorlagen pflegt der Org-Admin');
    const b = req.body ?? ({} as any);
    if (!b.name || b.contentMd === undefined) throw badRequest('Name und Inhalt erforderlich');
    const r = await db.one(
      `insert into doc_templates (org_id, key, name, content_md) values ($1,$2,$3,$4)
       on conflict (org_id, key) do update set name = excluded.name, content_md = excluded.content_md returning *`,
      [user.orgId, req.params.key, b.name, b.contentMd]
    );
    return { template: mapTemplate(r) };
  });

  // Anhänge (Aufgabe oder Seite)
  app.post<{ Querystring: { taskId?: string; pageId?: string } }>('/attachments', async (req) => {
    const user = requireUser(req);
    const { taskId, pageId } = req.query;
    let projectId: string | null = null;
    if (taskId) projectId = (await db.maybeOne(`select project_id from tasks where id = $1`, [taskId]))?.project_id ?? null;
    else if (pageId) projectId = (await db.maybeOne(`select project_id from doc_pages where id = $1`, [pageId]))?.project_id ?? null;
    if (!projectId) throw badRequest('taskId oder pageId erforderlich');
    await requireProject(db, user, projectId, 'member');
    const file = await req.file();
    if (!file) throw badRequest('Keine Datei');
    const buf = await file.toBuffer();
    await mkdir(uploadDir, { recursive: true });
    const storage = path.join(uploadDir, `${randomUUID()}${path.extname(file.filename)}`);
    await writeFile(storage, buf);
    const r = await db.one(
      `insert into attachments (project_id, task_id, page_id, filename, mime, size, storage_path, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [projectId, taskId ?? null, pageId ?? null, file.filename, file.mimetype, buf.length, storage, user.id]
    );
    await audit(db, { orgId: user.orgId, projectId, userId: user.id, action: 'attachment.upload', objectType: 'attachment', objectId: r.id, details: { filename: file.filename, size: buf.length } });
    return { attachment: mapAttachment(r) };
  });

  app.get<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    const user = requireUser(req);
    const a = await db.maybeOne(`select * from attachments where id = $1`, [req.params.id]);
    if (!a) throw notFound('Anhang nicht gefunden');
    await requireProject(db, user, a.project_id);
    reply.header('content-type', a.mime);
    reply.header('content-disposition', `inline; filename="${encodeURIComponent(a.filename)}"`);
    return reply.send(createReadStream(a.storage_path));
  });

  // Eingebaute Vorlagen bereitstellen (für seed und Tests)
  app.decorate('builtinTemplates', BUILTIN_TEMPLATES);
}

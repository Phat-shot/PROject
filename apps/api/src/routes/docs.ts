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
import { BUILTIN_TEMPLATES, mapFolder, mapPage, mapTemplate, mapVersion } from '../docs/service.js';
import { mapAttachment } from './tasks.js';
import { mapShare, newShareToken, publicBase, resolveShare, sharedPageIds } from '../docs/share.js';
import { notify, notifyMany, usersWithRight } from '../notify.js';
import { type PdfStyle } from '../docs/pdf.js';
import { htmlToPdf, type PageLayout } from '../docs/pdfHtml.js';
import { htmlToMd, mdToHtml, renderTemplateHtml, sanitizeHtml } from '../docs/html.js';

const TRANSITIONS: Record<DocStatus, DocStatus[]> = { draft: ['review', 'final'], review: ['draft', 'final'], final: ['draft'] };

export async function docRoutes(app: FastifyInstance) {
  const db = app.db;
  const styleFor = async (projectId: string): Promise<PdfStyle> => {
    const o = await db.one(`select o.name, o.settings from projects p join orgs o on o.id = p.org_id where p.id = $1`, [projectId]);
    const st = o.settings ?? {};
    return { company: st.company ?? o.name, accentColor: st.accentColor, footerText: st.footerText };
  };
  /** Layout einer Seite: Mandanten-Stil, überschrieben von Oberseiten (von oben nach unten) und der Seite selbst. */
  const layoutFor = async (pageId: string): Promise<PageLayout> => {
    const page = await db.one(`select project_id from doc_pages where id = $1`, [pageId]);
    const base: PageLayout = await styleFor(page.project_id);
    const chain = await db.query(
      `with recursive anc as (select id, parent_page_id, settings, 0 as depth from doc_pages where id = $1
         union all select p.id, p.parent_page_id, p.settings, a.depth + 1 from doc_pages p join anc a on p.id = a.parent_page_id)
       select settings from anc order by depth desc`,
      [pageId]
    );
    for (const r of chain.rows) Object.assign(base, Object.fromEntries(Object.entries(r.settings?.pdf ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '')));
    return base;
  };
  /** Vorlage für Unterseiten: nächste Oberseite mit childTemplateKey. */
  const inheritedTemplate = async (parentPageId: string | null): Promise<string | null> => {
    if (!parentPageId) return null;
    const chain = await db.query(
      `with recursive anc as (select id, parent_page_id, settings, 0 as depth from doc_pages where id = $1
         union all select p.id, p.parent_page_id, p.settings, a.depth + 1 from doc_pages p join anc a on p.id = a.parent_page_id)
       select settings from anc order by depth`,
      [parentPageId]
    );
    for (const r of chain.rows) if (r.settings?.childTemplateKey) return r.settings.childTemplateKey;
    return null;
  };
  const loadTemplate = async (key: string, orgId: string) => db.maybeOne(`select * from doc_templates where key = $1 and (org_id = $2 or org_id is null) order by org_id nulls last limit 1`, [key, orgId]);
  const templateHtml = (t: any) => renderTemplateHtml(t.content_html ?? mdToHtml(t.content_md ?? ''));
  const folderName = async (folderId: string | null) => (folderId ? (await db.maybeOne(`select name from doc_folders where id = $1`, [folderId]))?.name ?? null : null);
  const uploadDir = path.resolve(process.env.DATA_DIR ?? '.data', 'uploads');

  app.get<{ Params: { id: string } }>('/projects/:id/docs', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const folders = await db.query(`select * from doc_folders where project_id = $1 order by position, name`, [req.params.id]);
    const pages = await db.query(
      `select p.id, p.project_id, p.folder_id, p.parent_page_id, p.title, p.status, p.version, p.template_key, p.settings, p.created_by, p.updated_by, p.created_at, p.updated_at, p.finalized_at, '' as content_md, '' as content_html, u.name as updated_by_name,
              (select count(*)::int from doc_pages c where c.parent_page_id = p.id) as child_count
       from doc_pages p left join users u on u.id = p.updated_by where p.project_id = $1 order by p.title`,
      [req.params.id]
    );
    const templates = await db.query(`select distinct on (key) * from doc_templates where org_id = $1 or org_id is null order by key, org_id nulls last`, [user.orgId]);
    return { folders: folders.rows.map(mapFolder), pages: pages.rows.map(mapPage), templates: templates.rows.map(mapTemplate).sort((a: any, b: any) => a.name.localeCompare(b.name)) };
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

  app.post<{ Params: { id: string }; Body: { title: string; folderId?: string | null; parentPageId?: string | null; templateKey?: string | null; contentMd?: string; contentHtml?: string; settings?: any } }>('/projects/:id/docs/pages', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    const b = req.body ?? ({} as any);
    if (!b.title?.trim()) throw badRequest('Titel erforderlich');
    let parentFolder: string | null = null;
    if (b.parentPageId) {
      const parent = await db.maybeOne(`select folder_id, project_id from doc_pages where id = $1`, [b.parentPageId]);
      if (!parent || parent.project_id !== req.params.id) throw badRequest('Oberseite gehört nicht zum Projekt');
      parentFolder = parent.folder_id;
    }
    // Vorlage: angegeben, sonst von der Oberseite geerbt
    let templateKey: string | null = b.templateKey === undefined ? await inheritedTemplate(b.parentPageId ?? null) : b.templateKey;
    let html = b.contentHtml ? sanitizeHtml(b.contentHtml) : b.contentMd ? mdToHtml(b.contentMd) : '';
    if (templateKey && !b.contentHtml && !b.contentMd) {
      const t = await loadTemplate(templateKey, user.orgId);
      if (!t) throw badRequest('Vorlage nicht gefunden');
      html = templateHtml(t);
    }
    const r = await db.one(
      `insert into doc_pages (project_id, folder_id, parent_page_id, title, content_md, content_html, template_key, settings, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning *`,
      [req.params.id, b.folderId ?? parentFolder ?? null, b.parentPageId ?? null, b.title.trim(), htmlToMd(html), html, templateKey, JSON.stringify(b.settings ?? {}), user.id]
    );
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,1,$2,$3,$4,'draft',$5)`, [r.id, r.title, r.content_md, r.content_html, user.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'page.create', objectType: 'doc_page', objectId: r.id, details: { title: b.title, templateKey: b.templateKey ?? null } });
    return { page: mapPage(r) };
  });

  app.get<{ Params: { pid: string } }>('/docs/pages/:pid', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select p.*, u.name as updated_by_name from doc_pages p left join users u on u.id = p.updated_by where p.id = $1`, [req.params.pid]);
    if (!r) throw notFound('Seite nicht gefunden');
    await requireProject(db, user, r.project_id);
    const versions = await db.query(
      `select v.id, v.page_id, v.version, v.title, v.status, v.saved_by, v.saved_at, '' as content_md, '' as content_html, coalesce(u.name, v.external_editor || ' (extern)') as saved_by_name from doc_page_versions v left join users u on u.id = v.saved_by where v.page_id = $1 order by v.version desc`,
      [r.id]
    );
    const attachments = await db.query(`select * from attachments where page_id = $1 order by created_at`, [r.id]);
    // Freigaben, die diese Seite erreichen: direkt oder über einen Vorfahren mit „inkl. Unterseiten“
    const shares = await db.one(
      `with recursive anc as (
         select id, parent_page_id, 0 as depth from doc_pages where id = $1
         union all
         select p.id, p.parent_page_id, a.depth + 1 from doc_pages p join anc a on p.id = a.parent_page_id
       )
       select count(*)::int as c from doc_shares s join anc a on a.id = s.page_id
       where s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and (a.depth = 0 or s.include_children)`,
      [r.id]
    );
    const page = mapPage(r);
    if (!r.updated_by && r.updated_by_external) page.updatedByName = `${r.updated_by_external} (extern)`;
    const children = await db.query(`select id, title, status, version, updated_at, template_key from doc_pages where parent_page_id = $1 order by title desc`, [r.id]);
    return { page, versions: versions.rows.map(mapVersion), attachments: attachments.rows.map(mapAttachment), activeShares: shares.c,
      children: children.rows.map((c: any) => ({ id: c.id, title: c.title, status: c.status, version: c.version, updatedAt: c.updated_at, templateKey: c.template_key })),
      inheritedTemplateKey: await inheritedTemplate(r.id) };
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

  app.patch<{ Params: { pid: string }; Body: { title?: string; contentMd?: string; contentHtml?: string; folderId?: string | null; parentPageId?: string | null; baseVersion?: number; settings?: any } }>('/docs/pages/:pid', async (req) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select * from doc_pages where id = $1`, [req.params.pid]);
    if (!r) throw notFound('Seite nicht gefunden');
    await requireProject(db, user, r.project_id, 'member');
    const b = req.body ?? {};
    if (b.parentPageId && b.parentPageId === r.id) throw badRequest('Seite kann nicht ihre eigene Oberseite sein');
    if (b.parentPageId) {
      const desc = await db.query(
        `with recursive sub as (select id from doc_pages where parent_page_id = $1 union all select p.id from doc_pages p join sub s on p.parent_page_id = s.id) select 1 from sub where id = $2`,
        [r.id, b.parentPageId]
      );
      if (desc.rows.length) throw badRequest('Eine Unterseite kann nicht Oberseite werden');
    }
    // Struktur (Einstellungen, Oberseite, Ordner) darf auch an finalen Seiten geändert werden, Inhalt nicht
    const structuralOnly = b.contentHtml === undefined && b.contentMd === undefined && b.title === undefined;
    if (r.status === 'final' && !structuralOnly) throw conflict('Finale Seite ist gesperrt. Erst zurück auf Entwurf setzen.');
    if (b.baseVersion !== undefined && b.baseVersion !== r.version) {
      throw conflict(`Seite wurde zwischenzeitlich geändert (Version ${r.version}). Bitte neu laden.`);
    }
    let html: string | null = null;
    if (b.contentHtml !== undefined) html = sanitizeHtml(b.contentHtml);
    else if (b.contentMd !== undefined) html = mdToHtml(b.contentMd);
    const contentChanged = html !== null && html !== r.content_html;
    const titleChanged = b.title !== undefined && b.title.trim() !== r.title;
    const newVersion = contentChanged || titleChanged ? r.version + 1 : r.version;
    const settings = b.settings !== undefined ? { ...(r.settings ?? {}), ...b.settings } : r.settings;
    const u = await db.one(
      `update doc_pages set title = coalesce($2, title), content_html = coalesce($3, content_html), content_md = coalesce($4, content_md),
         folder_id = case when $5 then $6::uuid else folder_id end,
         parent_page_id = case when $7 then $8::uuid else parent_page_id end,
         version = $9, updated_by = $10, updated_at = now(), settings = $11
       where id = $1 returning *`,
      [r.id, b.title?.trim() || null, html, html !== null ? htmlToMd(html) : null, 'folderId' in b, b.folderId ?? null, 'parentPageId' in b, b.parentPageId ?? null, newVersion, user.id, JSON.stringify(settings ?? {})]
    );
    if (newVersion !== r.version) {
      await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,$2,$3,$4,$5,$6,$7)`, [u.id, newVersion, u.title, u.content_md, u.content_html, u.status, user.id]);
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
    if (to === 'review') {
      await notifyMany(db, await usersWithRight(db, r.project_id, 'can_finalize'), { projectId: r.project_id, type: 'page.review', title: `Zur Prüfung: ${u.title}`, body: `von ${user.name}`, link: `/projekte/${r.project_id}/doku/${u.id}` }, user.id);
    }
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
    const project = await db.one(`select name from projects where id = $1`, [r.project_id]);
    const pdf = await htmlToPdf(db, r.content_html ?? mdToHtml(r.content_md), { title: r.title, project: project.name, version: r.version, status: r.status, author: user.name, date: r.finalized_at ? new Date(r.finalized_at) : new Date(), folder: await folderName(r.folder_id) }, await layoutFor(r.id));
    const filename = `${r.title.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80)}_v${r.version}.pdf`;
    const result = await app.mail.sendFromAccount(account, {
      to: list,
      subject: `${r.title} (Version ${r.version})`,
      text: `Anbei „${r.title}“ in der finalen Version ${r.version} aus dem Projekt „${project.name}“ als PDF.\n\nMit freundlichen Grüßen\n${user.name}`,
      userId: user.id,
      projectId: r.project_id,
      attachments: [{ filename, content: pdf, contentType: 'application/pdf' }]
    });
    // Versandte PDF an der Seite ablegen (nachvollziehbar, was rausging)
    await mkdir(uploadDir, { recursive: true });
    const storage = path.join(uploadDir, `${randomUUID()}.pdf`);
    await writeFile(storage, pdf);
    await db.query(`insert into attachments (project_id, page_id, filename, mime, size, storage_path, uploaded_by) values ($1,$2,$3,'application/pdf',$4,$5,$6)`, [r.project_id, r.id, filename, pdf.length, storage, user.id]);
    await audit(db, { orgId: user.orgId, projectId: r.project_id, userId: user.id, action: 'page.distribute', objectType: 'doc_page', objectId: r.id, details: { to: list, version: r.version, messageId: result.messageId, pdf: filename, bytes: pdf.length } });
    return { ok: true, to: list, filename };
  });

  // Freigabe per Link: Seite (+ Unterseiten) an eine Mail-Adresse, lesend oder schreibend
  app.get<{ Params: { pid: string } }>('/docs/pages/:pid/shares', async (req) => {
    const user = requireUser(req);
    const p = await db.maybeOne(`select project_id from doc_pages where id = $1`, [req.params.pid]);
    if (!p) throw notFound('Seite nicht gefunden');
    const m = await requireProject(db, user, p.project_id, 'member');
    if (m.role !== 'pl' && !m.canFinalize) throw forbidden('Freigaben verwaltet der PL oder wer „Versand auslösen“ darf');
    const rows = await db.query(`select s.*, p.title as page_title from doc_shares s join doc_pages p on p.id = s.page_id where s.page_id = $1 order by s.created_at desc`, [req.params.pid]);
    return { shares: rows.rows.map(mapShare) };
  });

  app.post<{ Params: { pid: string }; Body: { email: string; mode: 'read' | 'write'; includeChildren?: boolean; expiresDays?: number | null; send?: boolean; message?: string } }>('/docs/pages/:pid/shares', async (req) => {
    const user = requireUser(req);
    const page = await db.maybeOne(`select * from doc_pages where id = $1`, [req.params.pid]);
    if (!page) throw notFound('Seite nicht gefunden');
    const m = await requireProject(db, user, page.project_id, 'member');
    if (m.role !== 'pl' && !m.canFinalize) throw forbidden('Freigaben erstellt der PL oder wer „Versand auslösen“ darf');
    const b = req.body ?? ({} as any);
    if (!b.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw badRequest('Gültige Mail-Adresse erforderlich');
    if (!['read', 'write'].includes(b.mode)) throw badRequest('Modus read oder write');
    const expires = b.expiresDays ? new Date(Date.now() + b.expiresDays * 86400_000) : null;
    const r = await db.one(
      `insert into doc_shares (page_id, project_id, token, email, mode, include_children, expires_at, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [page.id, page.project_id, newShareToken(), b.email.toLowerCase(), b.mode, b.includeChildren !== false, expires, user.id]
    );
    await audit(db, { orgId: user.orgId, projectId: page.project_id, userId: user.id, action: 'page.share', objectType: 'doc_page', objectId: page.id, details: { email: b.email, mode: b.mode, includeChildren: b.includeChildren !== false, expiresAt: expires } });
    const share = mapShare({ ...r, page_title: page.title });
    let sent = false;
    if (b.send) {
      const account = await db.maybeOne(`select * from mail_accounts where project_id = $1 and type = 'project' order by created_at limit 1`, [page.project_id]);
      if (!account) throw badRequest('Kein Projektkonto für den Versand. Link wurde erstellt, bitte manuell weitergeben.');
      const project = await db.one(`select name from projects where id = $1`, [page.project_id]);
      const text = `${b.message?.trim() ? b.message.trim() + '\n\n' : ''}${user.name} hat die Seite „${page.title}“ aus dem Projekt „${project.name}“ für Sie freigegeben (${b.mode === 'write' ? 'lesen und bearbeiten' : 'nur lesen'}${share.includeChildren ? ', inkl. Unterseiten' : ''}).\n\nLink: ${share.url}${expires ? `\nGültig bis ${expires.toLocaleDateString('de-DE')}` : ''}\n\nDer Link ist persönlich; bitte nicht weitergeben.`;
      await app.mail.sendFromAccount(account, { to: [b.email], subject: `Freigabe: ${page.title}`, text, userId: user.id, projectId: page.project_id });
      sent = true;
    }
    return { share, sent };
  });

  app.delete<{ Params: { sid: string } }>('/docs/shares/:sid', async (req) => {
    const user = requireUser(req);
    const sh = await db.maybeOne(`select * from doc_shares where id = $1`, [req.params.sid]);
    if (!sh) throw notFound('Freigabe nicht gefunden');
    const m = await requireProject(db, user, sh.project_id, 'member');
    if (m.role !== 'pl' && !m.canFinalize && sh.created_by !== user.id) throw forbidden();
    await db.query(`update doc_shares set revoked_at = now() where id = $1`, [sh.id]);
    await audit(db, { orgId: user.orgId, projectId: sh.project_id, userId: user.id, action: 'page.share_revoke', objectType: 'doc_page', objectId: sh.page_id, details: { email: sh.email } });
    return { ok: true };
  });

  // Öffentlich (ohne Login): Lesen und ggf. Bearbeiten über den Freigabe-Link
  app.get<{ Params: { token: string } }>('/share/:token', async (req) => {
    const sh = await resolveShare(db, req.params.token, true);
    if (!sh) throw notFound('Freigabe ungültig, abgelaufen oder widerrufen');
    const ids = await sharedPageIds(db, sh);
    const pages = await db.query(`select id, parent_page_id, title, status, version, updated_at from doc_pages where id = any($1::uuid[]) order by title`, [ids]);
    const root = await db.one(`select p.*, u.name as updated_by_name from doc_pages p left join users u on u.id = p.updated_by where p.id = $1`, [sh.page_id]);
    return {
      share: { mode: sh.mode, email: sh.email, includeChildren: sh.include_children, expiresAt: sh.expires_at, sharedBy: sh.created_by_name, projectName: sh.project_name },
      root: mapPage(root),
      pages: pages.rows.map((p: any) => ({ id: p.id, parentPageId: p.id === sh.page_id ? null : p.parent_page_id, title: p.title, status: p.status, version: p.version, updatedAt: p.updated_at }))
    };
  });

  app.get<{ Params: { token: string; pid: string } }>('/share/:token/pages/:pid', async (req) => {
    const sh = await resolveShare(db, req.params.token);
    if (!sh) throw notFound('Freigabe ungültig, abgelaufen oder widerrufen');
    const ids = await sharedPageIds(db, sh);
    if (!ids.includes(req.params.pid)) throw forbidden('Seite nicht Teil der Freigabe');
    const page = await db.one(`select p.*, u.name as updated_by_name from doc_pages p left join users u on u.id = p.updated_by where p.id = $1`, [req.params.pid]);
    const attachments = await db.query(`select * from attachments where page_id = $1 order by created_at`, [page.id]);
    return { page: mapPage(page), attachments: attachments.rows.map(mapAttachment) };
  });

  app.get<{ Params: { token: string; aid: string } }>('/share/:token/attachments/:aid', async (req, reply) => {
    const sh = await resolveShare(db, req.params.token);
    if (!sh) throw notFound('Freigabe ungültig');
    const a = await db.maybeOne(`select * from attachments where id = $1`, [req.params.aid]);
    if (!a || !a.page_id || !(await sharedPageIds(db, sh)).includes(a.page_id)) throw notFound('Anhang nicht gefunden');
    reply.header('content-type', a.mime);
    reply.header('content-disposition', `inline; filename="${encodeURIComponent(a.filename)}"`);
    return reply.send(createReadStream(a.storage_path));
  });

  app.patch<{ Params: { token: string; pid: string }; Body: { contentMd?: string; contentHtml?: string; title?: string; baseVersion?: number } }>('/share/:token/pages/:pid', async (req) => {
    const sh = await resolveShare(db, req.params.token);
    if (!sh) throw notFound('Freigabe ungültig, abgelaufen oder widerrufen');
    if (sh.mode !== 'write') throw forbidden('Diese Freigabe erlaubt nur Lesen');
    const ids = await sharedPageIds(db, sh);
    if (!ids.includes(req.params.pid)) throw forbidden('Seite nicht Teil der Freigabe');
    const page = await db.one(`select * from doc_pages where id = $1`, [req.params.pid]);
    if (page.status === 'final') throw conflict('Finale Seite ist gesperrt');
    const b = req.body ?? ({} as any);
    const html = typeof b.contentHtml === 'string' ? sanitizeHtml(b.contentHtml) : typeof b.contentMd === 'string' ? mdToHtml(b.contentMd) : null;
    if (html === null) throw badRequest('contentHtml erforderlich');
    if (b.baseVersion !== undefined && b.baseVersion !== page.version) throw conflict(`Seite wurde zwischenzeitlich geändert (Version ${page.version}). Bitte neu laden.`);
    if (html === page.content_html && (!b.title || b.title.trim() === page.title)) return { page: mapPage(page) };
    const u = await db.one(
      `update doc_pages set content_html = $2, content_md = $3, title = coalesce($4, title), version = version + 1, updated_by = null, updated_by_external = $5, updated_at = now() where id = $1 returning *`,
      [page.id, html, htmlToMd(html), b.title?.trim() || null, sh.email]
    );
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by, external_editor) values ($1,$2,$3,$4,$5,$6,null,$7)`, [u.id, u.version, u.title, u.content_md, u.content_html, u.status, sh.email]);
    await audit(db, { orgId: (await db.one(`select org_id from projects where id = $1`, [page.project_id])).org_id, projectId: page.project_id, userId: null, action: 'page.external_edit', objectType: 'doc_page', objectId: page.id, details: { email: sh.email, version: u.version, shareId: sh.id } });
    const targets = new Set<string>([sh.created_by, page.created_by].filter(Boolean));
    await notifyMany(db, targets, { projectId: page.project_id, type: 'page.external_edit', title: `Extern bearbeitet: ${u.title}`, body: `${sh.email} hat Version ${u.version} gespeichert`, link: `/projekte/${page.project_id}/doku/${u.id}` });
    return { page: { ...mapPage(u), updatedByName: sh.email } };
  });

  // PDF-Ansicht / Download einer Seite
  app.get<{ Params: { pid: string } }>('/docs/pages/:pid/pdf', async (req, reply) => {
    const user = requireUser(req);
    const r = await db.maybeOne(`select p.*, pr.name as project_name from doc_pages p join projects pr on pr.id = p.project_id where p.id = $1`, [req.params.pid]);
    if (!r) throw notFound('Seite nicht gefunden');
    await requireProject(db, user, r.project_id);
    const pdf = await htmlToPdf(db, r.content_html ?? mdToHtml(r.content_md), { title: r.title, project: r.project_name, version: r.version, status: r.status, author: user.name, folder: await folderName(r.folder_id) }, await layoutFor(r.id));
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `inline; filename="${encodeURIComponent(r.title)}_v${r.version}.pdf"`);
    return reply.send(pdf);
  });

  app.get<{ Params: { token: string; pid: string } }>('/share/:token/pages/:pid/pdf', async (req, reply) => {
    const sh = await resolveShare(db, req.params.token);
    if (!sh) throw notFound('Freigabe ungültig');
    if (!(await sharedPageIds(db, sh)).includes(req.params.pid)) throw forbidden('Seite nicht Teil der Freigabe');
    const r = await db.one(`select p.*, pr.name as project_name from doc_pages p join projects pr on pr.id = p.project_id where p.id = $1`, [req.params.pid]);
    const pdf = await htmlToPdf(db, r.content_html ?? mdToHtml(r.content_md), { title: r.title, project: r.project_name, version: r.version, status: r.status, folder: await folderName(r.folder_id) }, await layoutFor(r.id));
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `inline; filename="${encodeURIComponent(r.title)}_v${r.version}.pdf"`);
    return reply.send(pdf);
  });

  app.get('/docs/templates', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(`select distinct on (key) * from doc_templates where org_id = $1 or org_id is null order by key, org_id nulls last`, [user.orgId]);
    return { templates: rows.rows.map(mapTemplate).sort((a: any, b: any) => a.name.localeCompare(b.name)) };
  });

  app.put<{ Params: { key: string }; Body: { name: string; contentMd?: string; contentHtml?: string } }>('/docs/templates/:key', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Vorlagen pflegt der Org-Admin');
    const b = req.body ?? ({} as any);
    if (!b.name || (b.contentMd === undefined && b.contentHtml === undefined)) throw badRequest('Name und Inhalt erforderlich');
    const html = b.contentHtml !== undefined ? sanitizeHtml(b.contentHtml) : mdToHtml(b.contentMd ?? '');
    const r = await db.one(
      `insert into doc_templates (org_id, key, name, content_md, content_html) values ($1,$2,$3,$4,$5)
       on conflict (org_id, key) do update set name = excluded.name, content_md = excluded.content_md, content_html = excluded.content_html returning *`,
      [user.orgId, req.params.key, b.name, htmlToMd(html), html]
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

import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { User } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { getMembership, requireProject } from '../rights.js';
import { seal, unseal } from '../secrets.js';
import { PROJECT_LABEL_SQL, SQL } from '../projectPolicy.js';
import { BINDING_OK_SQL, fileForUser, listProjectFiles, sourceAvailable, syncSource, targetOf } from '../files/service.js';
import { getFile, normPath, parseSourceUrl, propfind, type DavTarget } from '../files/webdav.js';

/**
 * Dateiquellen (Nextcloud-Freigabelink oder WebDAV-Konto, nur lesend) und Doku › Dateien.
 * Org-Admin: Org-Quellen mit Projektfreigabe (alle/ausgewählte/keine) und Freigabe für persönliche Projekte (none/all/users).
 * PL: eigene Projektquellen anlegen, Org-Quellen einbinden (Unterordner, Anzeigename), Einbindung lösen, Sync von Hand.
 * Mitglieder mit Leserecht: Ordner/Datei-Liste aus dem Index, Download live über WebDAV, Textauszug.
 */
export async function fileRoutes(app: FastifyInstance) {
  const db = app.db;
  const isAdmin = (u: User) => u.globalRole === 'org_admin';
  const requireAdmin = (u: User) => { if (!isAdmin(u)) throw forbidden('Nur der Org-Admin verwaltet Dateiquellen der Organisation'); };
  const isPlOf = async (u: User, projectId: string | null | undefined) => Boolean(projectId) && (await getMembership(db, projectId!, u.id))?.role === 'pl';

  const validScope = (v: unknown) => { if (!['all', 'selected', 'none'].includes(String(v))) throw badRequest('projectScope: all, selected oder none'); return String(v) as 'all' | 'selected' | 'none'; };
  const validPersonalUse = (v: unknown) => { if (!['none', 'all', 'users'].includes(String(v))) throw badRequest('personalUse: none, all oder users'); return String(v) as 'none' | 'all' | 'users'; };
  const subPathOf = (v: unknown): string | null => { if (v == null || v === '') return null; const p = normPath(v); return p === '/' ? null : p; };

  /** Eingaben einer Quelle prüfen; Verbindungstest (PROPFIND auf den Startordner), außer check === false. */
  async function validInput(b: any, cur?: any): Promise<{ name: string; target: DavTarget; baseUrl: string; rootPath: string }> {
    const name = String(b.name ?? cur?.name ?? '').trim();
    if (!name) throw badRequest('Name erforderlich');
    const baseUrl = String(b.url ?? cur?.base_url ?? '').trim();
    if (!baseUrl) throw badRequest('Adresse erforderlich (Freigabelink https://…/s/<token> oder WebDAV-Adresse)');
    const secret = b.secret === null ? null : typeof b.secret === 'string' && b.secret.trim() ? b.secret.trim() : cur ? unseal(cur.secret) : null;
    const target = parseSourceUrl(baseUrl, b.username !== undefined ? b.username : cur?.username, secret);
    const rootPath = normPath(b.rootPath ?? cur?.root_path ?? '/');
    const changed = !cur || baseUrl !== cur.base_url || b.secret !== undefined || (b.username !== undefined && b.username !== cur.username) || rootPath !== cur.root_path;
    if (changed && b.check !== false) {
      try { await propfind(app.fetchFn, target, rootPath); } catch (e: any) { throw badRequest(`Verbindung fehlgeschlagen: ${String(e?.message ?? e).slice(0, 300)}`); }
    }
    return { name, target, baseUrl, rootPath };
  }

  async function setReleased(orgId: string, sourceId: string, ids: unknown[]) {
    await db.query(`delete from file_source_release_projects where source_id = $1`, [sourceId]);
    for (const id of [...new Set(ids.map(String))]) if (await db.maybeOne(`select 1 from projects p where p.id = $1 and p.org_id = $2 and ${SQL.notPersonal('p')}`, [id, orgId])) await db.query(`insert into file_source_release_projects (source_id, project_id) values ($1,$2) on conflict do nothing`, [sourceId, id]);
  }
  async function setPersonalUsers(orgId: string, sourceId: string, ids: unknown[]) {
    await db.query(`delete from file_source_personal_users where source_id = $1`, [sourceId]);
    for (const id of [...new Set(ids.map(String))]) if (await db.maybeOne(`select 1 from users where id = $1 and org_id = $2 and kind = 'person'`, [id, orgId])) await db.query(`insert into file_source_personal_users (source_id, user_id) values ($1,$2) on conflict do nothing`, [sourceId, id]);
  }

  /** Vollständige Sicht (Org-Admin bzw. PL der eigenen Projektquelle); Geheimnis nie, nur hasSecret. */
  async function mapSource(r: any) {
    const extra = await db.one(`select (select count(*)::int from files f where f.source_id = $1 and f.deleted_at is null) as files,
        coalesce((select json_agg(x.project_id) from file_source_release_projects x where x.source_id = $1), '[]'::json) as project_ids,
        coalesce((select json_agg(x.user_id) from file_source_personal_users x where x.source_id = $1), '[]'::json) as personal_user_ids,
        coalesce((select json_agg(json_build_object('id', b.id, 'projectId', b.project_id, 'project', ${PROJECT_LABEL_SQL}, 'subPath', b.sub_path, 'label', b.folder_label) order by b.created_at) from file_source_projects b join projects p on p.id = b.project_id left join users ow on ow.id = p.created_by where b.source_id = $1), '[]'::json) as bindings`, [r.id]);
    return { id: r.id, name: r.name, kind: r.kind, url: r.base_url, davUrl: r.dav_url, username: r.username ?? null, hasSecret: Boolean(r.secret), rootPath: r.root_path, scope: r.scope, ownerProjectId: r.owner_project_id ?? null,
      projectScope: r.project_scope, projectIds: extra.project_ids, personalUse: r.personal_use, personalUserIds: extra.personal_user_ids, active: r.active,
      lastSyncAt: r.last_sync_at ?? null, lastError: r.last_error ?? null, lastStats: r.last_stats ?? null, files: extra.files, bindings: extra.bindings, createdAt: r.created_at };
  }
  /** Knappe Sicht einer Org-Quelle für die PL (ohne Adresse und Zugangsdaten). */
  const mapAvailable = (r: any) => ({ id: r.id, name: r.name, kind: r.kind, scope: r.scope, rootPath: r.root_path, lastSyncAt: r.last_sync_at ?? null, lastError: r.last_error ?? null });
  const mapBinding = (b: any) => ({ id: b.id, sourceId: b.source_id, sourceName: b.source_name, scope: b.scope, kind: b.kind, subPath: b.sub_path ?? null, label: b.folder_label, lastSyncAt: b.last_sync_at ?? null, lastError: b.last_error ?? null, active: Boolean(b.ok) });

  // ---- Org-Admin: Quellen der Organisation
  app.get('/file-sources', async (req) => {
    const user = requireUser(req); requireAdmin(user);
    const rows = (await db.query(`select * from file_sources where org_id = $1 and scope = 'org' order by name`, [user.orgId])).rows;
    // Projektquellen nur als Metadaten (ohne Adresse und Zugangsdaten); persönliche Projekte nur als „persönlich (Eigentümer)“
    const own = (await db.query(`select s.id, s.name, s.kind, s.active, s.last_sync_at, s.last_error, ${PROJECT_LABEL_SQL} as project, (select count(*)::int from files f where f.source_id = s.id and f.deleted_at is null) as files from file_sources s join projects p on p.id = s.owner_project_id left join users ow on ow.id = p.created_by where s.org_id = $1 and s.scope = 'project' order by s.created_at`, [user.orgId])).rows;
    return { sources: await Promise.all(rows.map(mapSource)), projectSources: own.map((r: any) => ({ id: r.id, name: r.name, kind: r.kind, active: r.active, project: r.project, files: r.files, lastSyncAt: r.last_sync_at ?? null, lastError: r.last_error ?? null })) };
  });
  app.post<{ Body: any }>('/file-sources', async (req) => {
    const user = requireUser(req); requireAdmin(user);
    const b: any = req.body ?? {};
    const v = await validInput(b);
    const scope = validScope(b.projectScope ?? 'all');
    const personalUse = validPersonalUse(b.personalUse ?? 'none');
    const r = await db.one(`insert into file_sources (org_id, name, kind, base_url, dav_url, share_token, username, secret, root_path, scope, project_scope, personal_use, created_by, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'org',$10,$11,$12,$13) returning *`,
      [user.orgId, v.name, v.target.kind, v.baseUrl, v.target.davUrl, v.target.shareToken, v.target.username, seal(v.target.secret), v.rootPath, scope, personalUse, user.id, b.active !== false]);
    if (Array.isArray(b.projectIds)) await setReleased(user.orgId, r.id, b.projectIds);
    if (Array.isArray(b.personalUserIds)) await setPersonalUsers(user.orgId, r.id, b.personalUserIds);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'files.source.create', objectType: 'file_source', objectId: r.id, details: { name: v.name, kind: v.target.kind, davUrl: v.target.davUrl, scope: 'org', projectScope: scope, personalUse } });
    return { source: await mapSource(r) };
  });

  /** Quelle laden und Verwaltungsrecht prüfen: Org-Quelle Org-Admin, Projektquelle PL des eigenen Projekts. */
  async function manageable(user: User, id: string) {
    const s = await db.maybeOne(`select * from file_sources where id = $1 and org_id = $2`, [id, user.orgId]);
    if (!s) throw notFound('Dateiquelle nicht gefunden');
    if (s.scope === 'org' ? !isAdmin(user) : !(await isPlOf(user, s.owner_project_id))) throw forbidden(s.scope === 'org' ? 'Nur der Org-Admin verwaltet Dateiquellen der Organisation' : 'Nur die PL des Projekts verwaltet diese Dateiquelle');
    return s;
  }
  app.patch<{ Params: { id: string }; Body: any }>('/file-sources/:id', async (req) => {
    const user = requireUser(req);
    const cur = await manageable(user, req.params.id);
    const b: any = req.body ?? {};
    const v = await validInput(b, cur);
    const secret = b.secret === null ? null : typeof b.secret === 'string' && b.secret.trim() ? seal(b.secret.trim()) : cur.secret;
    await db.query(`update file_sources set name = $2, kind = $3, base_url = $4, dav_url = $5, share_token = $6, username = $7, secret = $8, root_path = $9, active = $10 where id = $1`,
      [cur.id, v.name, v.target.kind, v.baseUrl, v.target.davUrl, v.target.shareToken, v.target.username, secret, v.rootPath, typeof b.active === 'boolean' ? b.active : cur.active]);
    if (cur.scope === 'org') {
      if (b.projectScope !== undefined) await db.query(`update file_sources set project_scope = $2 where id = $1`, [cur.id, validScope(b.projectScope)]);
      if (b.personalUse !== undefined) await db.query(`update file_sources set personal_use = $2 where id = $1`, [cur.id, validPersonalUse(b.personalUse)]);
      if (Array.isArray(b.projectIds)) await setReleased(user.orgId, cur.id, b.projectIds);
      if (Array.isArray(b.personalUserIds)) await setPersonalUsers(user.orgId, cur.id, b.personalUserIds);
    }
    // Anderer Startordner: der Index passt nicht mehr, der nächste Sync baut ihn neu auf
    if (v.rootPath !== cur.root_path || v.target.davUrl !== cur.dav_url) await db.query(`delete from files where source_id = $1`, [cur.id]);
    await audit(db, { orgId: user.orgId, projectId: cur.owner_project_id ?? null, userId: user.id, action: 'files.source.update', objectType: 'file_source', objectId: cur.id, details: { name: v.name, davUrl: v.target.davUrl, rootPath: v.rootPath, active: b.active, secretChanged: b.secret !== undefined, projectScope: b.projectScope, personalUse: b.personalUse } });
    return { source: await mapSource(await db.one(`select * from file_sources where id = $1`, [cur.id])) };
  });
  app.delete<{ Params: { id: string } }>('/file-sources/:id', async (req) => {
    const user = requireUser(req);
    const cur = await manageable(user, req.params.id);
    await db.query(`delete from file_sources where id = $1`, [cur.id]);
    await audit(db, { orgId: user.orgId, projectId: cur.owner_project_id ?? null, userId: user.id, action: 'files.source.delete', objectType: 'file_source', objectId: cur.id, details: { name: cur.name } });
    return { ok: true };
  });

  // Sync von Hand: Org-Admin, PL der Projektquelle oder PL eines Projekts, in das die Quelle eingebunden ist
  app.post<{ Params: { id: string } }>('/file-sources/:id/sync', async (req) => {
    const user = requireUser(req);
    const s = await db.maybeOne(`select * from file_sources where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!s) throw notFound('Dateiquelle nicht gefunden');
    const bound = (await db.query(`select project_id from file_source_projects where source_id = $1`, [s.id])).rows.map((r: any) => r.project_id as string);
    let ok = isAdmin(user) && s.scope === 'org';
    for (const p of [s.owner_project_id, ...bound]) if (!ok && p) ok = await isPlOf(user, p);
    if (!ok) throw forbidden('Sync nur durch Org-Admin oder die PL eines eingebundenen Projekts');
    if (!s.active) throw badRequest('Dateiquelle ist deaktiviert');
    const stats = await syncSource(db, app.fetchFn, s.id);
    return { stats, source: s.scope === 'org' && !isAdmin(user) ? mapAvailable(await db.one(`select * from file_sources where id = $1`, [s.id])) : await mapSource(await db.one(`select * from file_sources where id = $1`, [s.id])) };
  });

  // Ordnerwahl: PROPFIND Depth 1 auf eine eingegebene Adresse (Anlegen) oder eine gespeicherte Quelle (Einbinden mit Unterordner)
  app.post<{ Body: any }>('/file-sources/browse', async (req) => {
    const user = requireUser(req);
    const b: any = req.body ?? {};
    let target: DavTarget; let base = '/';
    if (b.sourceId) {
      const s = await db.maybeOne(`select * from file_sources where id = $1 and org_id = $2`, [String(b.sourceId), user.orgId]);
      if (!s) throw notFound('Dateiquelle nicht gefunden');
      let ok = s.scope === 'org' ? isAdmin(user) : await isPlOf(user, s.owner_project_id);
      if (!ok && b.projectId && (await isPlOf(user, String(b.projectId)))) ok = await sourceAvailable(db, s.id, String(b.projectId));
      if (!ok) throw forbidden('Keine Berechtigung für diese Dateiquelle');
      target = targetOf(s); base = normPath(s.root_path);
    } else {
      const pl = Boolean(await db.maybeOne(`select 1 from project_members where user_id = $1 and role = 'pl' limit 1`, [user.id]));
      if (!isAdmin(user) && !pl) throw forbidden('Nur Org-Admin oder Projektleitung');
      target = parseSourceUrl(String(b.url ?? ''), b.user ?? b.username ?? null, b.secret ?? null);
    }
    const rel = normPath(b.path ?? '/');
    const abs = normPath(base + rel);
    let entries;
    try { entries = await propfind(app.fetchFn, target, abs); } catch (e: any) { throw badRequest(String(e?.message ?? e).slice(0, 300)); }
    const toRel = (p: string) => (base === '/' ? p : normPath(p.slice(base.length)));
    return { kind: target.kind, path: rel, parent: rel === '/' ? null : normPath(rel.split('/').slice(0, -1).join('/')),
      folders: entries.filter((e) => e.dir).map((e) => ({ name: e.name, path: toRel(e.path) })).sort((a, z) => a.name.localeCompare(z.name, 'de')),
      files: entries.filter((e) => !e.dir).length };
  });

  // ---- Projekt: verfügbare und eingebundene Quellen (PL)
  app.get<{ Params: { id: string } }>('/projects/:id/file-sources', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const pid = req.params.id;
    const available = (await db.query(`select s.* from file_sources s, projects p, (select $1::uuid as project_id) b where p.id = $1 and s.org_id = p.org_id and s.scope = 'org' and ${BINDING_OK_SQL} order by s.name`, [pid])).rows.map(mapAvailable);
    const own = await Promise.all((await db.query(`select * from file_sources where owner_project_id = $1 order by created_at`, [pid])).rows.map(mapSource));
    const bindings = (await db.query(`select b.*, s.name as source_name, s.scope, s.kind, s.last_sync_at, s.last_error, ${BINDING_OK_SQL} as ok from file_source_projects b join file_sources s on s.id = b.source_id join projects p on p.id = b.project_id where b.project_id = $1 order by b.folder_label`, [pid])).rows.map(mapBinding);
    return { available, own, bindings };
  });
  app.post<{ Params: { id: string }; Body: any }>('/projects/:id/file-sources', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const pid = req.params.id;
    const b: any = req.body ?? {};
    let source: any;
    if (b.sourceId) {
      source = await db.maybeOne(`select * from file_sources where id = $1 and org_id = $2`, [String(b.sourceId), user.orgId]);
      if (!source || !(await sourceAvailable(db, source.id, pid))) throw forbidden('Diese Dateiquelle ist für das Projekt nicht freigegeben');
    } else {
      const v = await validInput(b);
      source = await db.one(`insert into file_sources (org_id, name, kind, base_url, dav_url, share_token, username, secret, root_path, scope, owner_project_id, project_scope, personal_use, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'project',$10,'none','none',$11) returning *`,
        [user.orgId, v.name, v.target.kind, v.baseUrl, v.target.davUrl, v.target.shareToken, v.target.username, seal(v.target.secret), v.rootPath, pid, user.id]);
      await audit(db, { orgId: user.orgId, projectId: pid, userId: user.id, action: 'files.source.create', objectType: 'file_source', objectId: source.id, details: { name: v.name, kind: v.target.kind, davUrl: v.target.davUrl, scope: 'project' } });
    }
    const sub = subPathOf(b.subPath);
    const label = String(b.label ?? '').trim().slice(0, 120) || (sub ? `${source.name} › ${sub.split('/').pop()}` : source.name);
    if (await db.maybeOne(`select 1 from file_source_projects where source_id = $1 and project_id = $2 and coalesce(sub_path, '') = coalesce($3, '')`, [source.id, pid, sub])) throw conflict('Dieser Ordner ist schon eingebunden');
    const bind = await db.one(`insert into file_source_projects (source_id, project_id, sub_path, folder_label, created_by) values ($1,$2,$3,$4,$5) returning *`, [source.id, pid, sub, label, user.id]);
    await audit(db, { orgId: user.orgId, projectId: pid, userId: user.id, action: 'files.bind', objectType: 'file_source', objectId: source.id, details: { subPath: sub, label } });
    const row = await db.one(`select b.*, s.name as source_name, s.scope, s.kind, s.last_sync_at, s.last_error, ${BINDING_OK_SQL} as ok from file_source_projects b join file_sources s on s.id = b.source_id join projects p on p.id = b.project_id where b.id = $1`, [bind.id]);
    return { binding: mapBinding(row), source: source.scope === 'project' ? await mapSource(source) : mapAvailable(source) };
  });
  app.delete<{ Params: { id: string; sourceId: string }; Querystring: { bindingId?: string } }>('/projects/:id/file-sources/:sourceId', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const pid = req.params.id;
    const s = await db.maybeOne(`select * from file_sources where id = $1 and org_id = $2`, [req.params.sourceId, user.orgId]);
    if (!s) throw notFound('Dateiquelle nicht gefunden');
    const r = await db.query(`delete from file_source_projects where source_id = $1 and project_id = $2 and ($3::uuid is null or id = $3::uuid) returning id`, [s.id, pid, req.query.bindingId ?? null]);
    // Eigene Projektquelle ohne verbleibende Einbindung: Quelle samt Index löschen
    let deletedSource = false;
    if (s.scope === 'project' && s.owner_project_id === pid && !(await db.maybeOne(`select 1 from file_source_projects where source_id = $1`, [s.id]))) { await db.query(`delete from file_sources where id = $1`, [s.id]); deletedSource = true; }
    if (!r.rows.length && !deletedSource) throw notFound('Keine Einbindung dieser Quelle im Projekt');
    await audit(db, { orgId: user.orgId, projectId: pid, userId: user.id, action: deletedSource ? 'files.source.delete' : 'files.unbind', objectType: 'file_source', objectId: s.id, details: { name: s.name, bindings: r.rows.length } });
    return { ok: true, removed: r.rows.length, deletedSource };
  });

  // ---- Doku › Dateien: Liste aus dem Index (Mitglieder mit Leserecht)
  app.get<{ Params: { id: string }; Querystring: { binding?: string; path?: string } }>('/projects/:id/files', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const r = await listProjectFiles(db, req.params.id, req.query.binding || null, req.query.path ?? '/');
    if (!r) throw notFound('Ordner nicht gefunden');
    return r;
  });
  app.get<{ Params: { id: string } }>('/files/:id/text', async (req) => {
    const user = requireUser(req);
    const hit = await fileForUser(db, user, req.params.id);
    if (!hit) throw notFound('Datei nicht gefunden');
    const f = hit.file; const sub = hit.binding.sub_path && hit.binding.sub_path !== '/' ? hit.binding.sub_path : '';
    return { id: f.id, name: f.name, path: f.path, projectId: hit.binding.project_id, bindingId: hit.binding.id, displayPath: `${hit.binding.folder_label}${sub ? f.path.slice(sub.length) : f.path}`, mime: f.mime, size: f.size == null ? null : Number(f.size), modifiedAt: f.modified_at, textStatus: f.text_status, textNote: f.text_note ?? null, text: f.text_content ?? null };
  });
  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>('/files/:id/download', async (req, reply) => {
    const user = requireUser(req);
    const hit = await fileForUser(db, user, req.params.id);
    if (!hit) throw notFound('Datei nicht gefunden');
    if (!hit.source.active) throw badRequest('Dateiquelle ist deaktiviert');
    let r: Response;
    try { r = await getFile(app.fetchFn, targetOf(hit.source), normPath(hit.source.root_path + '/' + hit.file.path), 10 * 60_000); } catch (e: any) { throw new HttpError(502, `Datei nicht abrufbar: ${String(e?.message ?? e).slice(0, 200)}`); }
    const name = String(hit.file.name);
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const type = (r.headers.get('content-type') || hit.file.mime || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    // Inline nur für ungefährliche Typen (PDF, Bilder, reiner Text); HTML/SVG aus fremden Quellen nie im eigenen Ursprung anzeigen
    const inline = req.query.inline === '1' && /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/.test(type);
    reply.header('content-type', inline && type === 'text/plain' ? 'text/plain; charset=utf-8' : inline ? type : (type.startsWith('text/html') || type.includes('svg') || type.includes('javascript') ? 'application/octet-stream' : type));
    const len = r.headers.get('content-length'); if (len) reply.header('content-length', len);
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header('x-content-type-options', 'nosniff');
    // Sandbox gegen aktive Inhalte; nicht beim PDF inline (der PDF-Betrachter des Browsers läuft in einer Sandbox nicht)
    if (!(inline && type === 'application/pdf')) reply.header('content-security-policy', "sandbox; default-src 'none'; img-src 'self' data:");
    reply.header('cache-control', 'private, no-store');
    await audit(db, { orgId: user.orgId, projectId: hit.binding.project_id, userId: user.id, action: 'files.download', objectType: 'file', objectId: hit.file.id, details: { name } });
    return reply.send(r.body ? Readable.fromWeb(r.body as any) : '');
  });
}

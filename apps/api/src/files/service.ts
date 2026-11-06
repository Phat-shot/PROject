import type { Db } from '../db.js';
import type { User } from '@projekttool/shared';
import { audit } from '../audit.js';
import { effectiveMembership } from '../rights.js';
import { SQL } from '../projectPolicy.js';
import { unseal } from '../secrets.js';
import { MAX_EXTRACT_BYTES, extractText, extractable } from './extract.js';
import { getFile, listRecursive, normPath, readLimited, underPath, type DavTarget } from './webdav.js';

/**
 * Dateiquellen (Nextcloud/WebDAV, nur lesend): Index je Quelle einmal (files), Zuordnung zu Projekten mit Unterordner
 * (file_source_projects). Rechte: wer in einem Projekt Leserecht hat, dem die Quelle zugeordnet ist und dessen Unterordner die
 * Datei enthält, sieht und lädt sie. Persönliche Projekte nur eigene Quellen und freigegebene Org-Quellen (personal_use).
 */
export const targetOf = (s: any): DavTarget => ({ kind: s.kind, davUrl: s.dav_url, shareToken: s.share_token ?? null, username: s.username ?? null, secret: unseal(s.secret) });

/**
 * Gilt eine Einbindung (Alias b = file_source_projects, s = file_sources, p = projects)? Quelle aktiv; Projektquelle nur im
 * eigenen Projekt; Org-Quelle in persönlichen Projekten nur mit personal_use (all oder users mit dem Eigentümer), sonst nach
 * project_scope (all, selected mit Freigabeliste).
 */
export const BINDING_OK_SQL = `(s.active and p.org_id = s.org_id and p.status <> 'archived' and (
  (s.scope = 'project' and s.owner_project_id = b.project_id)
  or (s.scope = 'org' and ${SQL.orgFileSourceReleased('s', 'p')})))`;

/** Ist die Quelle für das Projekt verfügbar (einbindbar)? Gleiche Regel wie BINDING_OK_SQL. */
export async function sourceAvailable(db: Db, sourceId: string, projectId: string): Promise<boolean> {
  return Boolean(await db.maybeOne(`select 1 from file_sources s, projects p, (select $2::uuid as project_id) b where s.id = $1 and p.id = $2 and ${BINDING_OK_SQL}`, [sourceId, projectId]));
}

export interface FileScope { sourceId: string; subPath: string; label: string; projectId: string; bindingId: string }
/**
 * Erlaubte (Quelle, Unterordner)-Paare für Projekte: nur gültige Einbindungen. Mehrfach erreichbare Paare (gleiche Quelle in
 * mehreren Projekten oder überlappende Unterordner) werden zusammengefasst: ein Paar, das in einem breiteren derselben Quelle
 * liegt, entfällt (keine Doppelsuche, keine Doppeltreffer).
 */
export async function fileScopes(db: Db, projectIds: string[]): Promise<FileScope[]> {
  if (!projectIds.length) return [];
  const rows = (await db.query(`select b.id, b.source_id, b.project_id, coalesce(b.sub_path, '') as sub_path, b.folder_label from file_source_projects b join file_sources s on s.id = b.source_id join projects p on p.id = b.project_id where b.project_id = any($1::uuid[]) and ${BINDING_OK_SQL} order by b.created_at`, [projectIds])).rows as any[];
  const all: FileScope[] = rows.map((r) => ({ sourceId: r.source_id, subPath: r.sub_path === '/' ? '' : r.sub_path, label: r.folder_label, projectId: r.project_id, bindingId: r.id }));
  const covers = (o: FileScope, a: FileScope) => o.sourceId === a.sourceId && (o.subPath === '' || a.subPath === o.subPath || a.subPath.startsWith(o.subPath + '/'));
  return all.filter((a, i) => !all.some((o, j) => j !== i && covers(o, a) && (o.subPath !== a.subPath || j < i)));
}
/** Anzeigepfad einer Datei: Label der ersten passenden Einbindung und Pfad relativ zu deren Unterordner. */
export function displayPath(scopes: FileScope[], sourceId: string, path: string): string {
  const s = scopes.find((x) => x.sourceId === sourceId && underPath(path, x.subPath || null));
  return s ? `${s.label}${s.subPath ? path.slice(s.subPath.length) : path}` : path;
}

/** Datei mit Lesezugriff der Person (Mitglied mit Leserecht in einem Projekt mit passender Einbindung); null = kein Zugriff. */
export async function fileForUser(db: Db, user: User, fileId: string): Promise<{ file: any; source: any; binding: any } | null> {
  const file = await db.maybeOne(`select f.*, s.org_id from files f join file_sources s on s.id = f.source_id where f.id = $1 and f.deleted_at is null`, [fileId]);
  if (!file || file.org_id !== user.orgId) return null;
  const bindings = (await db.query(`select b.*, p.visibility from file_source_projects b join file_sources s on s.id = b.source_id join projects p on p.id = b.project_id where b.source_id = $1 and ${BINDING_OK_SQL} order by b.created_at`, [file.source_id])).rows as any[];
  for (const b of bindings) {
    if (!underPath(file.path, b.sub_path)) continue;
    if (user.kind === 'agent' && user.agentRole === 'assistant' && user.agentProjectId !== b.project_id) continue;
    if (await effectiveMembership(db, user, b.project_id, b.visibility)) return { file, source: await db.one(`select * from file_sources where id = $1`, [file.source_id]), binding: b };
  }
  return null;
}

/** Ist die Datei über ein Projekt der Liste erreichbar (Agent/Chat: Projekte vorher auf Mitgliedschaft geprüft)? */
export async function fileInProjects(db: Db, fileId: string, projectIds: string[]): Promise<{ file: any; scopes: FileScope[] } | null> {
  const file = await db.maybeOne(`select f.*, s.name as source_name from files f join file_sources s on s.id = f.source_id where f.id = $1 and f.deleted_at is null`, [fileId]);
  if (!file) return null;
  const scopes = await fileScopes(db, projectIds);
  return scopes.some((s) => s.sourceId === file.source_id && underPath(file.path, s.subPath || null)) ? { file, scopes } : null;
}

export const searchCounters = { files: 0, mails: 0 };

/**
 * Volltextsuche über Dateien (Name und Textauszug) als EINE Abfrage über die Vereinigung der erlaubten (Quelle, Unterordner)-
 * Paare; jede Datei (files.id) höchstens einmal. Rangfolge: Zahl der getroffenen Begriffe, dann Änderungsdatum.
 */
export async function searchFiles(db: Db, q: { scopes: FileScope[]; terms: string[]; since?: string | null; until?: string | null; limit?: number }): Promise<any[]> {
  if (!q.scopes.length || (!q.terms.length && !q.since && !q.until)) return [];
  const like = q.terms.map((t) => `%${t.replace(/[%_\\]/g, '')}%`);
  searchCounters.files++;
  const r = await db.query(
    `with allowed as (select * from unnest($1::uuid[], $2::text[]) as a(source_id, sub_path))
     select f.id, f.source_id, f.path, f.name, f.mime, f.size, f.modified_at, f.text_status, s.name as source_name,
       (select count(*) from unnest($3::text[]) t where f.name ilike t or f.text_content ilike t) as score,
       left(f.text_content, 20000) as text_head
     from files f join file_sources s on s.id = f.source_id
     where f.deleted_at is null and s.active
       and exists (select 1 from allowed a where a.source_id = f.source_id and (a.sub_path = '' or f.path = a.sub_path or left(f.path, length(a.sub_path) + 1) = a.sub_path || '/'))
       and (cardinality($3::text[]) = 0 or exists (select 1 from unnest($3::text[]) t where f.name ilike t or f.text_content ilike t))
       and ($4::timestamptz is null or f.modified_at >= $4::timestamptz) and ($5::timestamptz is null or f.modified_at < $5::timestamptz + interval '1 day')
     order by score desc, f.modified_at desc nulls last limit $6`,
    [q.scopes.map((s) => s.sourceId), q.scopes.map((s) => s.subPath), like, q.since || null, q.until || null, q.limit ?? 8]);
  return r.rows;
}

/** Projektansicht der Dateien: Wurzeln (Einbindungen) oder Ordner/Dateien unter einer Einbindung (Pfad relativ zum Unterordner). */
export async function listProjectFiles(db: Db, projectId: string, bindingId: string | null, relPath: string): Promise<any> {
  const roots = (await db.query(`select b.id, b.source_id, b.sub_path, b.folder_label, s.name as source_name, s.kind, s.scope, s.last_sync_at, s.last_error from file_source_projects b join file_sources s on s.id = b.source_id join projects p on p.id = b.project_id where b.project_id = $1 and ${BINDING_OK_SQL} order by b.folder_label`, [projectId])).rows as any[];
  const mapRoot = (r: any) => ({ bindingId: r.id, sourceId: r.source_id, label: r.folder_label, sourceName: r.source_name, kind: r.kind, scope: r.scope, subPath: r.sub_path ?? null, lastSyncAt: r.last_sync_at, lastError: r.last_error });
  if (!bindingId) return { binding: null, path: '/', parent: null, roots: roots.map(mapRoot), entries: roots.map((r) => ({ type: 'folder', name: r.folder_label, path: '/', bindingId: r.id })) };
  const b = roots.find((r) => r.id === bindingId);
  if (!b) return null;
  const rel = normPath(relPath);
  const sub = b.sub_path && b.sub_path !== '/' ? b.sub_path : '';
  const abs = normPath(sub + rel);
  const prefix = abs === '/' ? '/' : abs + '/';
  const rows = (await db.query(`select id, path, name, mime, size, modified_at, text_status from files where source_id = $1 and deleted_at is null and left(path, length($2)) = $2 order by path limit 20000`, [b.source_id, prefix])).rows as any[];
  const folders = new Map<string, number>(); const files: any[] = [];
  for (const f of rows) {
    const rest = f.path.slice(prefix.length);
    const i = rest.indexOf('/');
    if (i >= 0) { const name = rest.slice(0, i); folders.set(name, (folders.get(name) ?? 0) + 1); }
    else files.push({ type: 'file', id: f.id, name: f.name, path: normPath(rel + '/' + f.name), mime: f.mime, size: f.size == null ? null : Number(f.size), modifiedAt: f.modified_at, textStatus: f.text_status, bindingId: b.id });
  }
  const entries = [...[...folders.entries()].sort((a, z) => a[0].localeCompare(z[0], 'de')).map(([name, n]) => ({ type: 'folder', name, path: normPath(rel + '/' + name), files: n, bindingId: b.id })), ...files];
  return { binding: mapRoot(b), path: rel, parent: rel === '/' ? null : normPath(rel.split('/').slice(0, -1).join('/')), roots: roots.map(mapRoot), entries };
}

export interface SyncStats { files: number; added: number; changed: number; deleted: number; extracted: number; truncated: boolean; error?: string | null }
/**
 * Synchronisation einer Quelle: rekursive Liste (Grenzen siehe listRecursive), Änderungen per etag, Textauszug für neue und
 * geänderte Dateien (höchstens 20 MB, je Lauf höchstens maxExtract Dateien; der Rest folgt im nächsten Lauf), gelöschte
 * Dateien deleted_at. Fehler stehen in last_error; ist die Liste unvollständig, wird nichts als gelöscht markiert.
 */
export async function syncSource(db: Db, fetchFn: typeof fetch, sourceId: string, o: { maxFiles?: number; maxExtract?: number } = {}): Promise<SyncStats> {
  const s = await db.maybeOne(`select * from file_sources where id = $1`, [sourceId]);
  const stats: SyncStats = { files: 0, added: 0, changed: 0, deleted: 0, extracted: 0, truncated: false };
  if (!s) return { ...stats, error: 'Quelle nicht gefunden' };
  const t = targetOf(s);
  const root = normPath(s.root_path);
  try {
    const list = await listRecursive(fetchFn, t, root, { maxFiles: o.maxFiles ?? Number(process.env.FILE_SYNC_MAX_FILES ?? 5000) });
    stats.truncated = list.truncated; stats.files = list.files.length;
    const existing = new Map<string, any>(((await db.query(`select id, path, etag, deleted_at, text_status from files where source_id = $1`, [sourceId])).rows as any[]).map((r) => [r.path, r]));
    let budget = o.maxExtract ?? 300;
    const seen = new Set<string>();
    for (const e of list.files) {
      const rel = root === '/' ? e.path : e.path.slice(root.length) || '/';
      seen.add(rel);
      const cur = existing.get(rel);
      if (cur && !cur.deleted_at && cur.etag && e.etag && cur.etag === e.etag) continue;
      let text: string | null = null; let status: 'ok' | 'skipped' | 'error' = 'skipped'; let note: string | null = null; let etag = e.etag;
      if (!extractable(e.name)) note = 'Dateityp ohne Textauszug';
      else if (e.size != null && e.size > MAX_EXTRACT_BYTES) note = 'größer als 20 MB';
      else if (budget <= 0) { note = 'Textauszug folgt im nächsten Lauf'; etag = null; }
      else {
        budget--;
        try {
          const r = await getFile(fetchFn, t, e.path, 60_000);
          const x = await extractText(e.name, await readLimited(r, MAX_EXTRACT_BYTES));
          status = x.status; text = x.text; note = x.note ?? null;
          if (x.status === 'ok') stats.extracted++;
        } catch (err: any) { status = 'error'; note = String(err?.message ?? err).slice(0, 200); }
      }
      await db.query(
        `insert into files (source_id, path, name, mime, size, etag, modified_at, text_content, text_status, text_note, indexed_at, changed_at, deleted_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now(),null)
         on conflict (source_id, path) do update set name = excluded.name, mime = excluded.mime, size = excluded.size, etag = excluded.etag, modified_at = excluded.modified_at, text_content = excluded.text_content, text_status = excluded.text_status, text_note = excluded.text_note, indexed_at = now(), changed_at = now(), deleted_at = null`,
        [sourceId, rel, e.name, e.mime, e.size, etag, e.modifiedAt, text, status, note]);
      if (cur && !cur.deleted_at) stats.changed++; else stats.added++;
    }
    if (!list.truncated) {
      const gone = [...existing.values()].filter((r) => !r.deleted_at && !seen.has(r.path)).map((r) => r.id);
      if (gone.length) await db.query(`update files set deleted_at = now() where id = any($1::uuid[])`, [gone]);
      stats.deleted = gone.length;
    }
    await db.query(`update file_sources set last_sync_at = now(), last_error = $2, last_stats = $3 where id = $1`, [sourceId, list.truncated ? `Index unvollständig: Grenze von ${o.maxFiles ?? 5000} Dateien bzw. Ordnertiefe erreicht` : null, JSON.stringify(stats)]);
    if (stats.added || stats.changed || stats.deleted) await audit(db, { orgId: s.org_id, userId: null, action: 'files.sync', objectType: 'file_source', objectId: sourceId, details: { ...stats } });
    return stats;
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 500);
    await db.query(`update file_sources set last_sync_at = now(), last_error = $2 where id = $1`, [sourceId, msg]);
    return { ...stats, error: msg };
  }
}

/** Worker: alle aktiven Quellen mit mindestens einer Einbindung synchronisieren (Intervall FILE_SYNC_INTERVAL_MS, Standard 15 min). */
export async function runFileSync(db: Db, fetchFn: typeof fetch): Promise<number> {
  const rows = (await db.query(`select s.id from file_sources s where s.active and exists (select 1 from file_source_projects b where b.source_id = s.id) order by s.last_sync_at nulls first`)).rows as any[];
  for (const r of rows) {
    const st = await syncSource(db, fetchFn, r.id);
    if (st.error) console.warn(`[worker] Dateiquelle ${r.id}: ${st.error}`);
  }
  return rows.length;
}

/** Neue oder geänderte Dateien seit einem Zeitpunkt in den Einbindungen eines Projekts (für den Projektdurchlauf). */
export async function changedFiles(db: Db, projectId: string, since: Date | null, limit = 20): Promise<{ id: string; label: string; modifiedAt: string | null }[]> {
  const scopes = await fileScopes(db, [projectId]);
  if (!scopes.length) return [];
  const r = await db.query(
    `with allowed as (select * from unnest($1::uuid[], $2::text[]) as a(source_id, sub_path))
     select f.id, f.source_id, f.path, f.modified_at from files f where f.deleted_at is null and f.changed_at > coalesce($3::timestamptz, now() - interval '7 days')
       and exists (select 1 from allowed a where a.source_id = f.source_id and (a.sub_path = '' or left(f.path, length(a.sub_path) + 1) = a.sub_path || '/'))
     order by f.changed_at desc limit $4`, [scopes.map((s) => s.sourceId), scopes.map((s) => s.subPath), since, limit]);
  return r.rows.map((f: any) => ({ id: f.id, label: displayPath(scopes, f.source_id, f.path), modifiedAt: f.modified_at }));
}

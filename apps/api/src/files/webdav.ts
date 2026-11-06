import { badRequest } from '../errors.js';
import { pinnedFetch } from '../netGuard.js';

/**
 * WebDAV-Zugriff auf Dateiquellen (nur lesend): Nextcloud-Freigabelink oder WebDAV-Konto. Alle Aufrufe gehen über
 * netGuard.pinnedFetch (SSRF-Prüfung, DNS-Pinning, keine Weiterleitungen) mit Zeitlimit und Größenlimit.
 */
export interface DavTarget {
  kind: 'nextcloud_share' | 'webdav';
  /** WebDAV-Wurzel ohne abschließenden Schrägstrich, z. B. https://cloud.example/public.php/webdav */
  davUrl: string;
  shareToken: string | null;
  username: string | null;
  secret: string | null;
}
export interface DavEntry { path: string; name: string; dir: boolean; size: number | null; etag: string | null; mime: string | null; modifiedAt: string | null }

export const DAV_TIMEOUT_MS = 30_000;
/** Größenlimit einer PROPFIND-Antwort */
const MAX_PROPFIND_BYTES = 8 * 1024 * 1024;

/**
 * Eingabe der Verwaltung in ein WebDAV-Ziel: https://host[/pfad]/s/<token> (auch /index.php/s/<token>) → Freigabelink
 * (/public.php/webdav, Basic <token>:<Passwort>); https://host ohne Pfad mit Benutzer → /remote.php/dav/files/<user>;
 * sonst die Adresse als WebDAV-Wurzel (Konto: Benutzer + App-Passwort).
 */
export function parseSourceUrl(raw: string, user?: string | null, secret?: string | null): DavTarget {
  let u: URL;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw badRequest('Ungültige Adresse (https://… erwartet)'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('Nur http(s)-Adressen');
  if (u.username || u.password) throw badRequest('Zugangsdaten nicht in der Adresse angeben');
  const share = u.pathname.match(/^(.*?)\/(?:index\.php\/)?s\/([A-Za-z0-9]+)\/?$/);
  if (share) return { kind: 'nextcloud_share', davUrl: `${u.origin}${share[1]}/public.php/webdav`, shareToken: share[2], username: null, secret: secret?.trim() || null };
  const name = String(user ?? '').trim();
  if (!name) throw badRequest('Benutzername erforderlich (oder einen Freigabelink …/s/<token> angeben)');
  const path = u.pathname.replace(/\/+$/, '');
  const davUrl = path ? `${u.origin}${path}` : `${u.origin}/remote.php/dav/files/${encodeURIComponent(name)}`;
  return { kind: 'webdav', davUrl, shareToken: null, username: name, secret: secret?.trim() || null };
}

/** Pfad normalisieren: führender Schrägstrich, keiner am Ende, keine Punkte-Segmente; '/' = Wurzel. */
export function normPath(p: unknown): string {
  const parts = String(p ?? '').split('/').map((x) => x.trim()).filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..')) throw badRequest('Pfad ungültig');
  return '/' + parts.join('/');
}
/** Liegt path unter sub (Wurzel '/' bzw. leer = alles)? */
export const underPath = (path: string, sub: string | null | undefined) => !sub || sub === '/' || path === sub || path.startsWith(sub + '/');

const authHeader = (t: DavTarget): string | null => {
  if (t.kind === 'nextcloud_share') return 'Basic ' + Buffer.from(`${t.shareToken}:${t.secret ?? ''}`).toString('base64');
  return t.username ? 'Basic ' + Buffer.from(`${t.username}:${t.secret ?? ''}`).toString('base64') : null;
};
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
export const davFileUrl = (t: DavTarget, path: string) => `${t.davUrl}${encodePath(normPath(path))}`;

/** Text einer Antwort mit Byte-Grenze lesen (bricht ab, statt den Speicher zu füllen). */
export async function readLimited(r: Response, max: number): Promise<Buffer> {
  const len = Number(r.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > max) { await r.body?.cancel().catch(() => undefined); throw new Error(`Antwort zu groß (${len} Byte)`); }
  if (!r.body) return Buffer.alloc(0);
  const chunks: Buffer[] = []; let n = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => undefined); throw new Error(`Antwort zu groß (mehr als ${max} Byte)`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Anfrage an das WebDAV-Ziel mit Zeitlimit; Fehlertexte ohne Zugangsdaten. */
export async function davRequest(fetchFn: typeof fetch, t: DavTarget, path: string, init: { method: string; headers?: Record<string, string>; body?: string }, timeoutMs = DAV_TIMEOUT_MS): Promise<Response> {
  const auth = authHeader(t);
  const ctl = new AbortController();
  // Das Zeitlimit gilt für Anfrage und Lesen des Inhalts (der Timer bricht auch einen hängenden Body ab)
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await pinnedFetch(fetchFn, davFileUrl(t, path), { method: init.method, headers: { ...(auth ? { authorization: auth } : {}), ...(init.headers ?? {}) }, body: init.body, signal: ctl.signal }, 'Dateiquelle');
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError' || ctl.signal.aborted) throw new Error(`Zeitlimit überschritten (${Math.round(timeoutMs / 1000)} s)`);
    throw e;
  }
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/><d:getcontenttype/></d:prop></d:propfind>`;
const xmlDecode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  const k = e.toLowerCase();
  if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
  return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});
const tag = (xml: string, name: string): string | null => { const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, 'i')); return m ? xmlDecode((m[1] ?? '').trim()) : null; };

/** Multistatus-Antwort in Einträge (Pfad relativ zur WebDAV-Wurzel). */
export function parseMultistatus(xml: string, davUrl: string): DavEntry[] {
  const basePath = decodeURIComponent(new URL(davUrl).pathname).replace(/\/+$/, '');
  const out: DavEntry[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const body = m[1];
    const hrefRaw = tag(body, 'href');
    if (!hrefRaw) continue;
    let hrefPath: string;
    try { hrefPath = decodeURIComponent(new URL(hrefRaw, davUrl).pathname); } catch { continue; }
    if (!hrefPath.startsWith(basePath)) continue;
    // Nur Einträge mit Status 200 (Nextcloud liefert fehlende Eigenschaften als eigenen propstat 404)
    const ok = [...body.matchAll(/<(?:[\w-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi)].map((p) => p[1]).filter((p) => /HTTP\/[\d.]+\s+200/.test(tag(p, 'status') ?? 'HTTP/1.1 200'));
    const props = ok.join('\n') || body;
    const rel = hrefPath.slice(basePath.length);
    let path: string;
    try { path = normPath(rel); } catch { continue; }
    const rt = props.match(/<(?:[\w-]+:)?resourcetype\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?resourcetype>)/i);
    const dir = Boolean(rt?.[1] && /<(?:[\w-]+:)?collection\b/i.test(rt[1])) || /\/$/.test(hrefRaw) && !tag(props, 'getcontentlength');
    const len = tag(props, 'getcontentlength');
    const lm = tag(props, 'getlastmodified');
    const d = lm ? new Date(lm) : null;
    out.push({ path, name: path === '/' ? '' : path.split('/').pop()!, dir, size: len && /^\d+$/.test(len) ? Number(len) : null, etag: (tag(props, 'getetag') ?? '').replace(/^"|"$/g, '') || null, mime: tag(props, 'getcontenttype') || null, modifiedAt: d && !isNaN(d.getTime()) ? d.toISOString() : null });
  }
  return out;
}

/** PROPFIND Depth 1: der Ordner selbst und seine direkten Einträge (ohne den Ordner). */
export async function propfind(fetchFn: typeof fetch, t: DavTarget, path: string): Promise<DavEntry[]> {
  const dir = normPath(path);
  const r = await davRequest(fetchFn, t, dir === '/' ? '/' : dir + '/', { method: 'PROPFIND', headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY });
  if (r.status === 401 || r.status === 403) { await r.body?.cancel().catch(() => undefined); throw new Error(`Zugriff verweigert (HTTP ${r.status}): Freigabe-Passwort bzw. Benutzer und App-Passwort prüfen`); }
  if (r.status === 404) { await r.body?.cancel().catch(() => undefined); throw new Error(`Ordner ${dir} nicht gefunden (HTTP 404)`); }
  if (r.status !== 207) { await r.body?.cancel().catch(() => undefined); throw new Error(`WebDAV antwortet mit HTTP ${r.status} statt 207`); }
  const xml = (await readLimited(r, MAX_PROPFIND_BYTES)).toString('utf8');
  return parseMultistatus(xml, t.davUrl).filter((e) => e.path !== dir);
}

/**
 * Rekursive Liste unter root (Breitensuche mit Depth 1, weil Nextcloud Depth infinity meist abweist): höchstens maxDepth Ebenen,
 * maxFiles Dateien und maxDirs Ordner; truncated = Grenze erreicht (der Index bleibt dann unvollständig, nichts wird gelöscht).
 */
export async function listRecursive(fetchFn: typeof fetch, t: DavTarget, root: string, o: { maxDepth?: number; maxFiles?: number; maxDirs?: number } = {}): Promise<{ files: DavEntry[]; dirs: string[]; truncated: boolean }> {
  const maxDepth = o.maxDepth ?? 12; const maxFiles = o.maxFiles ?? 5000; const maxDirs = o.maxDirs ?? 1000;
  const files: DavEntry[] = []; const dirs: string[] = [];
  let queue: string[] = [normPath(root)]; let truncated = false;
  for (let depth = 0; queue.length && depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const d of queue) {
      if (dirs.length >= maxDirs) { truncated = true; break; }
      dirs.push(d);
      for (const e of await propfind(fetchFn, t, d)) {
        if (e.dir) { if (depth < maxDepth) next.push(e.path); else truncated = true; continue; }
        if (files.length >= maxFiles) { truncated = true; continue; }
        files.push(e);
      }
    }
    queue = next;
  }
  if (queue.length) truncated = true;
  return { files, dirs, truncated };
}

/** Datei per GET (Antwort ungelesen, für Streaming bzw. readLimited). */
export async function getFile(fetchFn: typeof fetch, t: DavTarget, path: string, timeoutMs = 120_000): Promise<Response> {
  const r = await davRequest(fetchFn, t, path, { method: 'GET' }, timeoutMs);
  if (r.status !== 200) { await r.body?.cancel().catch(() => undefined); throw new Error(`Datei nicht abrufbar (HTTP ${r.status})`); }
  return r;
}

/**
 * Erreichbarkeit einer Datei prüfen, ohne den Inhalt zu übertragen: HEAD; lehnt der Server HEAD ab (405/501), PROPFIND Depth 0.
 * Wirft mit verständlichem Grund (Zugriff verweigert, nicht gefunden, HTTP-Status, Zeitlimit, Netzfehler).
 */
export async function checkFile(fetchFn: typeof fetch, t: DavTarget, path: string, timeoutMs = 15_000): Promise<void> {
  let r = await davRequest(fetchFn, t, path, { method: 'HEAD' }, timeoutMs);
  await r.body?.cancel().catch(() => undefined);
  if (r.status === 405 || r.status === 501) {
    r = await davRequest(fetchFn, t, path, { method: 'PROPFIND', headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY }, timeoutMs);
    await r.body?.cancel().catch(() => undefined);
    if (r.status === 207) return;
  }
  if (r.status === 401 || r.status === 403) throw new Error(`Zugriff verweigert (HTTP ${r.status})`);
  if (r.status === 404) throw new Error('Datei in der Quelle nicht gefunden (HTTP 404)');
  if (r.status !== 200 && r.status !== 204) throw new Error(`Quelle antwortet mit HTTP ${r.status}`);
}

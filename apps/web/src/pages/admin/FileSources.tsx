import { useState } from 'react';
import type { FileSource, FileSourceKind, FileSyncStats, PersonalUse, User } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync, useDialog, useToast } from '../../components/ui';
import { IconFolder, IconUp } from '../../components/icons';
import { PersonalUsersPicker } from './Ai';

/** Antwort von POST /file-sources/browse: Unterordner eines Ordners (Pfade relativ zur Wurzel der Abfrage). */
export interface BrowseResult { kind: FileSourceKind; path: string; parent: string | null; folders: { name: string; path: string }[]; files: number }
interface ProjectSourceRow { id: string; name: string; kind: FileSourceKind; active: boolean; project: string; files: number; lastSyncAt: string | null; lastError: string | null }

export const KIND_LABEL: Record<FileSourceKind, string> = { nextcloud_share: 'Freigabelink', webdav: 'WebDAV-Konto' };
/** Freigabelink (…/s/<token>) oder WebDAV-Adresse eines Kontos? */
export const isShareUrl = (url: string) => /\/s\/[^/?#]+/.test(url.trim());

/** Ergebnis eines Abgleichs als ein Satz für den Toast. */
export function syncMessage(name: string, s: FileSyncStats): string {
  if (s.error) return `${name}: Abgleich fehlgeschlagen – ${s.error}`;
  return `${name} synchronisiert: ${s.files} Dateien, ${s.added} neu, ${s.changed} geändert, ${s.deleted} entfernt, ${s.extracted} Textauszüge${s.ocr ? `, davon ${s.ocr} per Texterkennung` : ''}${s.truncated ? ' (nicht vollständig, der Rest folgt beim nächsten Lauf)' : ''}.`;
}

/** Sync-Stand einer Quelle: Fehler, Zeitpunkt oder „noch nie“. */
export function SyncState({ lastSyncAt, lastError }: { lastSyncAt: string | null; lastError: string | null }) {
  if (lastError) return <span className="badge danger" title={lastError}>Fehler</span>;
  return lastSyncAt ? <span className="small">{fmtDateTime(lastSyncAt)}</span> : <span className="muted small">noch nie</span>;
}

/**
 * Ordnerwahl über POST /file-sources/browse: navigierbare Liste der Unterordner mit „hoch“ und Pfad; der angezeigte Ordner ist
 * die Auswahl. `body` trägt entweder die eingegebene Adresse samt Zugang oder sourceId (+ projectId) einer gespeicherten Quelle.
 */
export function FolderPicker({ label, body, value, onChange, disabledHint }: { label: string; body: Record<string, unknown>; value: string; onChange: (path: string) => void; disabledHint?: string | null }) {
  const [res, setRes] = useState<BrowseResult | null>(null);
  const { busy, error, run } = useAsync();
  const load = (path: string) => run(async () => { const r = await api.post<BrowseResult>('/file-sources/browse', { ...body, path }); setRes(r); onChange(r.path); });
  const segs = (res?.path ?? value).split('/').filter(Boolean);
  return (
    <div className="field full folder-picker">
      <span>{label}</span>
      <div className="row gap-1 wrap">
        <code className="folder-path">{value || '/'}</code>
        {res ? <button type="button" className="btn sm" onClick={() => setRes(null)}>Ordnerwahl schließen</button>
          : <button type="button" className="btn sm" disabled={busy || Boolean(disabledHint)} onClick={() => void load(value || '/')}>Ordner wählen</button>}
      </div>
      {disabledHint && !res && <span className="muted small">{disabledHint}</span>}
      {error && <div className="error small">{error}</div>}
      {res && (
        <div className="folder-browser">
          <nav className="breadcrumb small" aria-label="Ordnerpfad">
            <button type="button" className="btn sm link" disabled={busy} onClick={() => void load('/')}>Wurzel</button>
            {segs.map((s, i) => <span key={i}> / <button type="button" className="btn sm link" disabled={busy} onClick={() => void load('/' + segs.slice(0, i + 1).join('/'))}>{s}</button></span>)}
          </nav>
          <ul className="folder-list" aria-label="Unterordner">
            {res.parent != null && <li><button type="button" className="btn sm link" disabled={busy} onClick={() => void load(res.parent!)}><IconUp size={14} /> hoch</button></li>}
            {res.folders.map((f) => <li key={f.path}><button type="button" className="btn sm link" disabled={busy} onClick={() => void load(f.path)}><IconFolder size={14} /> {f.name}</button></li>)}
            {res.folders.length === 0 && <li className="muted small">Keine Unterordner.</li>}
          </ul>
          <span className="muted small">{res.files} {res.files === 1 ? 'Datei' : 'Dateien'} direkt in diesem Ordner. Gewählt ist der angezeigte Ordner.</span>
        </div>
      )}
    </div>
  );
}

/** Eingaben einer Quelle (Anlegen in Verwaltung und Projekt): Name, Adresse, Zugang, Startordner. */
export interface SourceDraft { name: string; url: string; username: string; secret: string; rootPath: string }
export const EMPTY_DRAFT: SourceDraft = { name: '', url: '', username: '', secret: '', rootPath: '/' };

/** Gespeicherte Quelle beim Bearbeiten: Adresse und Benutzer wie gespeichert → Ordnerwahl über sourceId (ohne Passwort). */
export interface SavedSource { id: string; url: string; username: string | null; hasSecret: boolean }

/**
 * Felder für Name, Adresse, Benutzer/App-Passwort (Konto) bzw. Passwort (Freigabelink) und Startordner per Ordnerwahl. Beim Bearbeiten
 * (saved) mit unveränderter Adresse und Benutzer und ohne neues Passwort durchsucht die Ordnerwahl die gespeicherte Quelle
 * (sourceId, absolute Pfade ab der WebDAV-Wurzel); sonst die eingegebene Adresse samt Zugang.
 */
export function SourceFields({ f, setF, saved = null }: { f: SourceDraft; setF: (f: SourceDraft) => void; saved?: SavedSource | null }) {
  const share = isShareUrl(f.url);
  const hasSecret = Boolean(saved?.hasSecret);
  const unchanged = Boolean(saved) && f.url.trim() === saved!.url.trim() && (share || f.username.trim() === (saved!.username ?? '').trim());
  const useSaved = unchanged && !f.secret;
  const browseBody: Record<string, unknown> = useSaved ? { sourceId: saved!.id, absolute: true } : { url: f.url.trim(), username: share ? null : f.username.trim() || null, secret: f.secret || null };
  // Gespeichertes Passwort kennt die Oberfläche nicht: nur bei geänderter Adresse bzw. geändertem Benutzer neu eingeben
  const hint = !f.url.trim() ? 'Erst die Adresse eingeben.' : !share && !f.username.trim() ? 'Erst Benutzer und App-Passwort eingeben.' : hasSecret && !unchanged && !f.secret ? 'Adresse oder Benutzer geändert: zum Durchsuchen das Passwort erneut eingeben (es wird nicht angezeigt).' : null;
  return (
    <>
      <label className="field full"><span className="req">Name</span><input type="text" value={f.name} autoFocus placeholder="z. B. Pläne Kunde Müller" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="field full"><span className="req">Adresse</span>
        <input type="url" value={f.url} placeholder="https://cloud.example.de/s/AbC123" onChange={(e) => setF({ ...f, url: e.target.value })} />
        <span className="muted small">Freigabelink „https://cloud/s/…“ oder WebDAV-Adresse eines Kontos „https://cloud/remote.php/dav/files/&lt;user&gt;/“. Das Tool liest nur.</span></label>
      {share
        ? <label className="field full"><span>Passwort des Freigabelinks (optional){hasSecret && <span className="muted"> · gesetzt, leer = unverändert</span>}</span><input type="password" value={f.secret} autoComplete="new-password" onChange={(e) => setF({ ...f, secret: e.target.value })} /></label>
        : <>
          <label className="field"><span>Benutzer</span><input type="text" value={f.username} autoComplete="off" onChange={(e) => setF({ ...f, username: e.target.value })} /></label>
          <label className="field"><span>App-Passwort{hasSecret && <span className="muted"> · gesetzt, leer = unverändert</span>}</span><input type="password" value={f.secret} autoComplete="new-password" onChange={(e) => setF({ ...f, secret: e.target.value })} />
            <span className="muted small">Nextcloud: Einstellungen › Sicherheit › „Neues App-Passwort erstellen“, nie das Anmeldepasswort.</span></label>
        </>}
      <FolderPicker key={useSaved ? `saved|${saved!.id}` : `${String(browseBody.url)}|${String(browseBody.username ?? '')}`} label="Startordner" body={browseBody} value={f.rootPath} onChange={(rootPath) => setF({ ...f, rootPath })} disabledHint={hint} />
    </>
  );
}

/** Felder einer Quelle als Anfragekörper; Passwort nur, wenn eingegeben. */
export const draftBody = (f: SourceDraft) => {
  const share = isShareUrl(f.url);
  return { name: f.name.trim(), url: f.url.trim(), username: share ? null : f.username.trim() || null, ...(f.secret ? { secret: f.secret } : {}), rootPath: f.rootPath || '/' };
};

/** Mehrfachauswahl von Projekten (ohne persönliche) mit Suchfeld, für die Projektfreigabe einer Org-Quelle. */
function ProjectPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const projects = useData<{ projects: { id: string; label: string }[] }>('/ai/release-projects');
  const [q, setQ] = useState('');
  const n = q.trim().toLowerCase();
  const list = (projects.data?.projects ?? []).filter((p) => !p.label.startsWith('persönlich (') && (!n || p.label.toLowerCase().includes(n)));
  return (
    <div className="field full">
      <span>Freigegebene Projekte ({value.length})</span>
      <input type="search" aria-label="Projekte suchen" placeholder="Kürzel oder Name …" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-list">
        {list.map((p) => <label key={p.id} className={`check small ${value.includes(p.id) ? 'on' : ''}`}><input type="checkbox" aria-label={`Projekt ${p.label}`} checked={value.includes(p.id)} onChange={(e) => onChange(e.target.checked ? [...value.filter((x) => x !== p.id), p.id] : value.filter((x) => x !== p.id))} /> {p.label}</label>)}
        {projects.data && list.length === 0 && <span className="muted small">Kein Projekt gefunden.</span>}
      </div>
    </div>
  );
}

interface AdminDraft extends SourceDraft { projectScope: 'all' | 'selected' | 'none'; projectIds: string[]; personalUse: PersonalUse; personalUserIds: string[]; active: boolean }

function SourceModal({ source, onClose, onSaved }: { source: FileSource | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState<AdminDraft>(source
    ? { name: source.name, url: source.url, username: source.username ?? '', secret: '', rootPath: source.rootPath, projectScope: source.projectScope, projectIds: source.projectIds, personalUse: source.personalUse, personalUserIds: source.personalUserIds, active: source.active }
    : { ...EMPTY_DRAFT, projectScope: 'all', projectIds: [], personalUse: 'none', personalUserIds: [], active: true });
  const people = useData<{ users: User[] }>(f.personalUse === 'users' ? '/users' : null, [f.personalUse]);
  const { busy, error, run } = useAsync();
  const save = () => run(async () => {
    const body = { ...draftBody(f), projectScope: f.projectScope, projectIds: f.projectScope === 'selected' ? f.projectIds : [], personalUse: f.personalUse, personalUserIds: f.personalUse === 'users' ? f.personalUserIds : [], active: f.active };
    if (source) await api.patch(`/file-sources/${source.id}`, body); else await api.post('/file-sources', body);
    await onSaved();
  });
  return (
    <Modal title={source ? `Dateiquelle: ${source.name}` : 'Dateiquelle anlegen'} onClose={onClose} wide>
      <div className="form cols-2">
        <SourceFields f={f} setF={(d) => setF({ ...f, ...d })} saved={source ? { id: source.id, url: source.url, username: source.username, hasSecret: source.hasSecret } : null} />
        <label className="field full"><span>Projektfreigabe</span>
          <select value={f.projectScope} onChange={(e) => setF({ ...f, projectScope: e.target.value as AdminDraft['projectScope'] })}><option value="all">alle Projekte</option><option value="selected">ausgewählte Projekte</option><option value="none">keine (noch nicht freigegeben)</option></select>
          <span className="muted small">Freigegeben heißt: die PL kann die Quelle in ihrem Projekt einbinden (Einstellungen › Dateien).</span></label>
        {f.projectScope === 'selected' && <ProjectPicker value={f.projectIds} onChange={(projectIds) => setF({ ...f, projectIds })} />}
        <div className="full stack gap-1">
          <label className="field"><span>Für persönliche Projekte</span>
            <select className="w-auto" aria-label="Für persönliche Projekte" value={f.personalUse} onChange={(e) => setF({ ...f, personalUse: e.target.value as PersonalUse })}>
              <option value="none">gesperrt</option><option value="all">alle</option><option value="users">bestimmte Personen</option>
            </select></label>
          {f.personalUse === 'users' && <PersonalUsersPicker label="Personen, die die Quelle in ihr persönliches Projekt einbinden dürfen" users={(people.data?.users ?? []).filter((u) => u.active && u.kind !== 'agent')} value={f.personalUserIds} onChange={(personalUserIds) => setF({ ...f, personalUserIds })} />}
        </div>
        <label className="check full"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv (wird abgeglichen und angezeigt)</label>
        <p className="muted small full mb-0">Beim Speichern prüft das Tool die Verbindung zum Startordner.</p>
        {error && <div className="error full">{error}</div>}
        <div className="full row">
          <button className="btn primary" disabled={busy || !f.name.trim() || !f.url.trim()} onClick={() => void save()}>Speichern</button>
          <button className="btn" onClick={onClose}>Abbrechen</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Verwaltung › Dateiquellen (Org-Admin): Quellen der Organisation (Nextcloud-Freigabelink oder WebDAV-Konto, nur lesend) mit
 * Projektfreigabe und Freigabe für persönliche Projekte, Abgleich von Hand; darunter die eigenen Quellen der Projekte (nur lesend).
 */
export function FileSourcesSection() {
  const d = useData<{ sources: FileSource[]; projectSources: ProjectSourceRow[] }>('/file-sources');
  const [edit, setEdit] = useState<FileSource | 'new' | null>(null);
  const dialog = useDialog();
  const t = useToast();
  const { busy, error, run } = useAsync();
  const sources = d.data?.sources ?? [];
  const own = d.data?.projectSources ?? [];
  const sync = (s: FileSource) => run(async () => { const r = await api.post<{ stats: FileSyncStats }>(`/file-sources/${s.id}/sync`); (r.stats.error ? t.error : t.ok)(syncMessage(s.name, r.stats)); await d.reload(); });
  const remove = (s: FileSource) => void dialog.confirm({ title: 'Dateiquelle löschen', text: `„${s.name}“ löschen? Alle Einbindungen in Projekten und der Index verschwinden; in der Cloud bleibt alles unverändert.`, confirmLabel: 'Löschen', danger: true })
    .then((ok) => { if (ok) void run(async () => { await api.del(`/file-sources/${s.id}`); await d.reload(); }); });
  const scopeText = (s: FileSource) => s.projectScope === 'all' ? 'alle Projekte' : s.projectScope === 'selected' ? `${s.projectIds.length} Projekte` : 'keine Projekte';
  return (
    <>
      <div className="card">
        <div className="row between"><h2 className="m-0">Dateiquellen</h2><button className="btn sm primary" onClick={() => setEdit('new')}>Quelle anlegen</button></div>
        <p className="muted small">Ordner einer Nextcloud oder eines anderen WebDAV-Speichers, die Projekte unter Doku › Dateien lesen und durchsuchen. Das Tool liest nur: es legt nichts an, ändert und löscht nichts in der Cloud.</p>
        {(error || d.error) && <div className="error mb">{error ?? d.error}</div>}
        {d.data && sources.length === 0 && <div className="empty">Noch keine Dateiquelle der Organisation.</div>}
        {sources.length > 0 && <div className="table-wrap"><table className="table">
          <thead><tr><th>Name</th><th>Art</th><th>Freigabe</th><th>Dateien</th><th>Letzter Sync</th><th>Aktiv</th><th /></tr></thead>
          <tbody>{sources.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong><div className="muted small" title={s.davUrl}>{s.rootPath !== '/' ? `Startordner ${s.rootPath}` : 'ganze Quelle'}{s.bindings.length > 0 && ` · eingebunden in ${s.bindings.length}`}</div>{s.lastError && <div className="error small">{s.lastError}</div>}</td>
              <td>{KIND_LABEL[s.kind]}</td>
              <td className="small">{scopeText(s)}{s.personalUse === 'all' ? ' · persönliche: alle' : s.personalUse === 'users' ? ` · persönliche: ${s.personalUserIds.length} Personen` : ''}</td>
              <td>{s.files}</td>
              <td><SyncState lastSyncAt={s.lastSyncAt} lastError={s.lastError} /></td>
              <td>{s.active ? <span className="badge ok">aktiv</span> : <span className="badge">inaktiv</span>}</td>
              <td className="nowrap">
                <button className="btn sm" disabled={busy || !s.active} title={s.active ? undefined : 'Quelle ist deaktiviert'} onClick={() => void sync(s)}>Jetzt synchronisieren</button>{' '}
                <button className="btn sm" onClick={() => setEdit(s)}>Bearbeiten</button>{' '}
                <button className="btn sm danger" disabled={busy} onClick={() => remove(s)}>Löschen</button>
              </td>
            </tr>
          ))}</tbody>
        </table></div>}
      </div>
      <div className="card">
        <h2 className="m-0">Eigene Quellen der Projekte</h2>
        <p className="muted small">Quellen, die eine PL nur für ihr Projekt angelegt hat (ohne Adresse und Zugangsdaten). Sie verwaltet die PL unter Einstellungen › Dateien.</p>
        {d.data && own.length === 0 && <div className="empty">Keine.</div>}
        {own.length > 0 && <div className="table-wrap"><table className="table">
          <thead><tr><th>Name</th><th>Projekt</th><th>Art</th><th>Dateien</th><th>Letzter Sync</th><th>Aktiv</th></tr></thead>
          <tbody>{own.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.project}</td><td>{KIND_LABEL[s.kind]}</td><td>{s.files}</td><td><SyncState lastSyncAt={s.lastSyncAt} lastError={s.lastError} /></td><td>{s.active ? 'ja' : 'nein'}</td></tr>)}</tbody>
        </table></div>}
      </div>
      {edit && <SourceModal source={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await d.reload(); }} />}
    </>
  );
}

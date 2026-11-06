import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { FileEntry, FileListing, FileRoot, FileText } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Loading, Markdown, Modal } from '../../components/ui';
import { IconAlert, IconCloud, IconDownload, IconFile, IconFolder, IconUp } from '../../components/icons';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { useProjectOptional } from '../ProjectPage';

type FileItem = Extract<FileEntry, { type: 'file' }>;

/** Größe lesbar (B, kB, MB, GB). */
export function fmtSize(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

const TEXT_HINT: Record<string, string> = { skipped: 'Kein Textauszug (Dateityp oder Größe); nur über den Namen auffindbar', error: 'Textauszug fehlgeschlagen; nur über den Namen auffindbar' };
/** Badge „durchsuchbar“ / „nicht durchsuchbar“; Tooltip mit dem Grund (textNote, sonst allgemein). */
export function TextBadge({ status, note }: { status: FileItem['textStatus']; note?: string | null }) {
  if (status === 'ok') return <span className="badge ok" title={note ?? 'Inhalt durchsuchbar (Textauszug gespeichert)'}>durchsuchbar</span>;
  return <span className="badge" title={note ?? (status ? TEXT_HINT[status] : 'Noch nicht ausgelesen')}>nicht durchsuchbar</span>;
}

const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
const isPdf = (f: { name: string; mime: string | null }) => f.mime === 'application/pdf' || ext(f.name) === 'pdf';
const isImage = (f: { name: string; mime: string | null }) => /^image\/(png|jpeg|gif|webp)$/.test(f.mime ?? '') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext(f.name));
const isMarkdown = (f: { name: string; mime: string | null }) => f.mime === 'text/markdown' || ['md', 'markdown'].includes(ext(f.name));

/** Pfad in der Adresse: Segmente einzeln kodiert. */
export const filesPath = (base: string, bindingId: string, path = '/') => `${base}/dateien/${bindingId}${path.split('/').filter(Boolean).map((s) => `/${encodeURIComponent(s)}`).join('')}`;

/**
 * Vorschau: PDF und Bilder inline aus der Quelle, sonst der Textauszug (Markdown gerendert); immer mit Download. Vor dem PDF-iframe
 * ein Vorab-Check (GET /files/:id/download?check=1), damit eine nicht erreichbare Quelle als Meldung statt als leerer Rahmen erscheint.
 */
function Preview({ file, onClose }: { file: FileItem; onClose: () => void }) {
  const inline = isPdf(file) || isImage(file);
  const text = useData<FileText>(inline ? null : `/files/${file.id}/text`, [file.id]);
  const [imgError, setImgError] = useState(false);
  const [pdfCheck, setPdfCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const src = `/api/files/${file.id}/download?inline=1`;
  const pdf = isPdf(file);
  useEffect(() => {
    if (!pdf) return;
    let live = true;
    setPdfCheck(null);
    api.get<{ ok: boolean }>(`/files/${file.id}/download?check=1`)
      .then(() => { if (live) setPdfCheck({ ok: true }); })
      .catch((e: any) => { if (live) setPdfCheck({ ok: false, error: String(e?.message ?? e) }); });
    return () => { live = false; };
  }, [file.id, pdf]);
  // Textstatus aus dem Index (Liste); bei Textdateien der aktuelle Stand aus /text
  return (
    <Modal title={file.name} onClose={onClose} wide>
      <div className="file-preview">
        <div className="row between wrap gap-1 mb">
          <span className="muted small">{[fmtSize(file.size), file.modifiedAt ? `geändert ${fmtDateTime(file.modifiedAt)}` : ''].filter(Boolean).join(' · ')} {text.data ? <TextBadge status={text.data.textStatus} note={text.data.textNote} /> : <TextBadge status={file.textStatus} note={file.textNote} />}</span>
          <a className="btn sm" href={`/api/files/${file.id}/download`} download={file.name}><IconDownload size={14} /> Herunterladen</a>
        </div>
        {pdf && (!pdfCheck ? <Loading>Prüft die Quelle …</Loading>
          : pdfCheck.ok ? <iframe title={`Vorschau ${file.name}`} src={src} className="file-frame" />
          : <div className="error" role="alert">Quelle nicht erreichbar: {pdfCheck.error}</div>)}
        {isImage(file) && (imgError
          ? <div className="error">Bild nicht abrufbar: die Quelle ist gerade nicht erreichbar. Später erneut versuchen oder herunterladen.</div>
          : <img src={src} alt={file.name} className="file-image" onError={() => setImgError(true)} />)}
        {!inline && (text.error ? <div className="error">{text.error}</div>
          : !text.data ? <Loading>Lädt Text …</Loading>
          : text.data.text == null ? <div className="empty">Keine Textvorschau{text.data.textNote ? `: ${text.data.textNote}` : ''}. Die Datei lässt sich herunterladen.</div>
          : isMarkdown(file) ? <div className="file-text"><Markdown md={text.data.text} /></div>
          : <pre className="file-text">{text.data.text}</pre>)}
      </div>
    </Modal>
  );
}

/** Kopf mit Quelle und Sync-Stand; Fehler der Quelle verständlich. */
function SourceNote({ root }: { root: FileRoot }) {
  return (
    <>
      <p className="muted small"><IconCloud size={14} /> Nur lesend · Quelle: {root.sourceName}{root.subPath ? ` › ${root.subPath}` : ''} · {root.lastSyncAt ? `zuletzt synchronisiert ${fmtDateTime(root.lastSyncAt)}` : 'noch nicht synchronisiert'}</p>
      {root.lastError && <div className="notice small mb" role="status"><IconAlert size={14} /> Quelle nicht erreichbar beim letzten Abgleich: {root.lastError}. Angezeigt wird der zuletzt bekannte Stand; Öffnen und Herunterladen können fehlschlagen.</div>}
    </>
  );
}

/**
 * Doku › Dateien: eingebundene Ordner aus Dateiquellen (Nextcloud/WebDAV, nur lesend). Ohne bindingId die Übersicht der Einbindungen,
 * sonst die Dateiliste eines Ordners (Ordner zuerst) mit Pfad, Klick auf Ordner navigiert, Klick auf Datei öffnet die Vorschau.
 */
export function FilesView({ projectId, base, bindingId, path, canManage }: { projectId: string; base: string; bindingId: string | null; path: string; canManage: boolean }) {
  const nav = useNavigate();
  const project = useProjectOptional();
  const url = bindingId ? `/projects/${projectId}/files?binding=${encodeURIComponent(bindingId)}&path=${encodeURIComponent(path)}` : `/projects/${projectId}/files`;
  const d = useData<FileListing>(url, [url]);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const settings = `/projekte/${projectId}/einstellungen/dateien`;
  if (d.error) return <div className="doc-view"><h1>Dateien</h1><div className="error" role="alert">{/Ordner nicht gefunden/.test(d.error) ? 'Ordner nicht gefunden: die Einbindung wurde entfernt, die Quelle ist deaktiviert oder der Ordner existiert nicht mehr.' : d.error}</div><p><Link to={`${base}/dateien`}>Zur Übersicht der Dateien</Link></p></div>;
  if (!d.data) return <div className="doc-view"><Loading>Lädt Dateien …</Loading></div>;
  const l = d.data;
  if (!l.binding) {
    return (
      <div className="doc-view">
        <h1>Dateien</h1>
        <p className="muted">Ordner aus Nextcloud oder einem WebDAV-Speicher, nur lesend. Inhalte von PDF, Word, Text und Markdown sind durchsuchbar.</p>
        {l.roots.length === 0
          ? <div className="empty">Noch keine Dateiquelle eingebunden.{canManage ? <> <Link to={settings}>Unter Einstellungen › Dateien einbinden</Link>.</> : ' Die PL bindet Quellen unter Einstellungen › Dateien ein.'}</div>
          : <table className="table file-table"><tbody>{l.roots.map((r) => <tr key={r.bindingId} className="clickable" onClick={() => nav(filesPath(base, r.bindingId))}><td><IconCloud size={14} /> {r.label}</td><td className="muted small">{r.sourceName}</td><td className="muted small">{r.lastError ? <span className="badge danger" title={r.lastError}>nicht erreichbar</span> : r.lastSyncAt ? fmtDateTime(r.lastSyncAt) : 'noch nicht synchronisiert'}</td></tr>)}</tbody></table>}
      </div>
    );
  }
  const root = l.binding;
  const segs = l.path.split('/').filter(Boolean);
  return (
    <div className="doc-view files-view">
      <Breadcrumbs label="Pfad" className="breadcrumb" items={[
        ...(project ? [{ label: project.detail.project.name, to: `/projekte/${project.detail.project.id}/board` }] : []),
        { label: 'Doku', to: base },
        { label: 'Dateien', to: `${base}/dateien` },
        { label: root.label, to: filesPath(base, root.bindingId) },
        ...segs.map((x, i) => ({ label: x, to: filesPath(base, root.bindingId, '/' + segs.slice(0, i + 1).join('/')) }))
      ]} />
      <h1>{segs.length ? segs[segs.length - 1] : root.label}</h1>
      <SourceNote root={root} />
      {l.entries.length === 0
        ? <div className="empty">{root.lastSyncAt ? 'Dieser Ordner ist leer.' : 'Noch nicht synchronisiert: die Dateien erscheinen nach dem ersten Abgleich (alle 15 Minuten oder „Jetzt synchronisieren“ in den Einstellungen).'}</div>
        : <table className="table file-table">
          <thead><tr><th>Name</th><th>Größe</th><th>Geändert</th><th>Text</th></tr></thead>
          <tbody>
            {l.parent != null && <tr className="clickable" onClick={() => nav(filesPath(base, root.bindingId, l.parent!))}><td colSpan={4}><IconUp size={14} /> hoch</td></tr>}
            {l.entries.map((e) => e.type === 'folder'
              ? <tr key={`d${e.path}`} className="clickable" onClick={() => nav(filesPath(base, root.bindingId, e.path))}><td><Link to={filesPath(base, root.bindingId, e.path)} onClick={(ev) => ev.stopPropagation()}><IconFolder size={14} /> {e.name}</Link></td><td className="muted small">{e.files != null ? `${e.files} ${e.files === 1 ? 'Datei' : 'Dateien'}` : ''}</td><td /><td /></tr>
              : <tr key={e.id} className="clickable" onClick={() => setPreview(e)}><td><button type="button" className="btn sm link file-name" onClick={(ev) => { ev.stopPropagation(); setPreview(e); }}><IconFile size={14} /> {e.name}</button></td><td className="small nowrap">{fmtSize(e.size)}</td><td className="small nowrap">{fmtDateTime(e.modifiedAt)}</td><td><TextBadge status={e.textStatus} note={e.textNote} /></td></tr>)}
          </tbody>
        </table>}
      {preview && <Preview file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

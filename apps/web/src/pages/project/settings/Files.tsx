import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { FileListing, FileSource, FileSourceAvailable, FileSourceBinding, FileSyncStats } from '@projekttool/shared';
import { api } from '../../../lib/api';
import { useData } from '../../../lib/useData';
import { Modal, useAsync, useDialog, useToast } from '../../../components/ui';
import { ReadOnlyNote, SettingsCard } from '../../../components/settings/Settings';
import { EMPTY_DRAFT, FolderPicker, KIND_LABEL, SourceFields, SyncState, draftBody, syncMessage, type SourceDraft } from '../../admin/FileSources';
import { useProject } from '../../ProjectPage';

interface PlData { available: FileSourceAvailable[]; own: FileSource[]; bindings: FileSourceBinding[] }

/** Abgleich direkt nach dem Einbinden bzw. von Hand; Ergebnis als Toast. */
function useSync() {
  const t = useToast();
  return async (sourceId: string, name: string) => {
    try { const r = await api.post<{ stats: FileSyncStats }>(`/file-sources/${sourceId}/sync`); (r.stats.error ? t.error : t.ok)(syncMessage(name, r.stats)); }
    catch (e: any) { t.error(`${name}: Abgleich nicht möglich – ${e?.message ?? e}`); }
  };
}

/** Freigegebene Quelle der Organisation einbinden: Quelle, Unterordner (Ordnerwahl innerhalb der Quelle) und Anzeigename. */
function BindModal({ projectId, available, onClose, onDone }: { projectId: string; available: FileSourceAvailable[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [sourceId, setSourceId] = useState(available[0]?.id ?? '');
  const [subPath, setSubPath] = useState('/');
  const [label, setLabel] = useState('');
  const { busy, error, run } = useAsync();
  const sync = useSync();
  const src = available.find((s) => s.id === sourceId);
  const save = () => run(async () => {
    const r = await api.post<{ binding: FileSourceBinding }>(`/projects/${projectId}/file-sources`, { sourceId, subPath: subPath === '/' ? null : subPath, label: label.trim() || undefined });
    await sync(r.binding.sourceId, r.binding.label);
    await onDone();
  });
  return (
    <Modal title="Freigegebene Quelle einbinden" onClose={onClose}>
      <div className="form">
        <label className="field"><span>Quelle</span><select value={sourceId} onChange={(e) => { setSourceId(e.target.value); setSubPath('/'); }}>{available.map((s) => <option key={s.id} value={s.id}>{s.name} ({KIND_LABEL[s.kind]})</option>)}</select></label>
        <FolderPicker key={sourceId} label="Unterordner (leer bzw. / = die ganze Quelle)" body={{ sourceId, projectId }} value={subPath} onChange={setSubPath} />
        <label className="field"><span>Anzeigename in der Doku</span><input type="text" value={label} placeholder={src ? (subPath !== '/' ? `${src.name} › ${subPath.split('/').pop()}` : src.name) : ''} onChange={(e) => setLabel(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || !sourceId} onClick={() => void save()}>Einbinden</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/** Eigene Quelle des Projekts anlegen (gilt nur hier) und gleich einbinden, bzw. eine bestehende bearbeiten (source). */
function OwnSourceModal({ projectId, source = null, onClose, onDone }: { projectId: string; source?: FileSource | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState<SourceDraft>(source ? { name: source.name, url: source.url, username: source.username ?? '', secret: '', rootPath: source.rootPath } : EMPTY_DRAFT);
  const [label, setLabel] = useState('');
  const { busy, error, run } = useAsync();
  const sync = useSync();
  const save = () => run(async () => {
    if (source) await api.patch(`/file-sources/${source.id}`, draftBody(f));
    else {
      const r = await api.post<{ binding: FileSourceBinding }>(`/projects/${projectId}/file-sources`, { ...draftBody(f), label: label.trim() || undefined });
      await sync(r.binding.sourceId, r.binding.label);
    }
    await onDone();
  });
  return (
    <Modal title={source ? `Eigene Quelle: ${source.name}` : 'Eigene Quelle anlegen'} onClose={onClose} wide>
      <div className="form cols-2">
        <SourceFields f={f} setF={setF} saved={source ? { id: source.id, url: source.url, username: source.username, hasSecret: source.hasSecret } : null} />
        {!source && <label className="field full"><span>Anzeigename in der Doku</span><input type="text" value={label} placeholder={f.name || 'wie der Name'} onChange={(e) => setLabel(e.target.value)} /></label>}
        <p className="muted small full mb-0">Die Quelle gilt nur in diesem Projekt. Beim Speichern prüft das Tool die Verbindung.</p>
        {error && <div className="error full">{error}</div>}
        <div className="full row"><button className="btn primary" disabled={busy || !f.name.trim() || !f.url.trim()} onClick={() => void save()}>{source ? 'Speichern' : 'Anlegen und einbinden'}</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/**
 * Projekt › Einstellungen › Dateien: eingebundene Ordner aus Dateiquellen (Nextcloud, WebDAV; nur lesend). Die PL bindet freigegebene
 * Quellen der Organisation ein oder legt eine eigene an; alle anderen sehen die Einbindungen.
 */
export function FilesTab() {
  const { detail } = useProject();
  const pid = detail.project.id;
  const isPl = detail.project.myMembership.role === 'pl';
  const pl = useData<PlData>(isPl ? `/projects/${pid}/file-sources` : null, [pid, isPl]);
  const roots = useData<FileListing>(isPl ? null : `/projects/${pid}/files`, [pid, isPl]);
  const [modal, setModal] = useState<'bind' | 'own' | FileSource | null>(null);
  const dialog = useDialog();
  const sync = useSync();
  const { busy, error, run } = useAsync();
  const docs = `/projekte/${pid}/doku/dateien`;
  const own = new Map((pl.data?.own ?? []).map((s) => [s.id, s]));
  const done = async () => { setModal(null); await pl.reload(); };
  const unbind = (b: FileSourceBinding) => void dialog.confirm({ title: 'Einbindung entfernen', text: `„${b.label}“ aus dem Projekt entfernen?${b.scope === 'project' ? ' Ohne weitere Einbindung wird die eigene Quelle samt Index gelöscht.' : ''} In der Cloud bleibt alles unverändert.`, confirmLabel: 'Entfernen', danger: true })
    .then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${pid}/file-sources/${b.sourceId}?bindingId=${b.id}`); await pl.reload(); }); });
  if (!isPl) {
    const list = roots.data?.roots ?? [];
    return (
      <SettingsCard title="Eingebundene Ordner">
        <ReadOnlyNote who="PL" />
        {roots.error && <div className="error">{roots.error}</div>}
        {roots.data && list.length === 0 && <div className="empty">Keine Dateiquelle eingebunden.</div>}
        {list.length > 0 && <table className="table"><thead><tr><th>Ordner</th><th>Quelle</th><th>Unterordner</th><th>Sync</th></tr></thead>
          <tbody>{list.map((r) => <tr key={r.bindingId}><td><Link to={`${docs}/${r.bindingId}`}>{r.label}</Link></td><td>{r.sourceName}</td><td>{r.subPath ?? '/'}</td><td><SyncState lastSyncAt={r.lastSyncAt} lastError={r.lastError} /></td></tr>)}</tbody></table>}
      </SettingsCard>
    );
  }
  const bindings = pl.data?.bindings ?? [];
  const available = pl.data?.available ?? [];
  return (
    <>
      <SettingsCard title="Eingebundene Ordner" action={<div className="row gap-1">
        <button className="btn sm" disabled={!pl.data || available.length === 0} title={available.length === 0 ? 'Keine Quelle der Organisation für dieses Projekt freigegeben' : undefined} onClick={() => setModal('bind')}>Freigegebene Quelle einbinden</button>
        <button className="btn sm primary" onClick={() => setModal('own')}>Eigene Quelle anlegen</button>
      </div>}>
        {(error || pl.error) && <div className="error mb">{error ?? pl.error}</div>}
        {pl.data && bindings.length === 0 && <div className="empty">Noch nichts eingebunden. Eingebundene Ordner erscheinen in der Doku unter „Dateien“.</div>}
        {bindings.length > 0 && <table className="table">
          <thead><tr><th>Ordner</th><th>Quelle</th><th>Unterordner</th><th>Dateien</th><th>Sync</th><th /></tr></thead>
          <tbody>{bindings.map((b) => (
            <tr key={b.id}>
              <td><Link to={`${docs}/${b.id}`}>{b.label}</Link>{!b.active && <span className="badge ml-1" title="Quelle deaktiviert oder nicht mehr freigegeben">ruht</span>}
                <Link to={`/projekte/${pid}/einstellungen/ki`} className={`badge ml-1${b.agentEnabled === false ? ' muted' : ''}`} title="Dürfen KI-Agenten diesen Ordner durchsuchen und lesen? Einstellen unter Einstellungen › KI › Quellen für den Agenten">KI: {b.agentEnabled === false ? 'aus' : 'an'}</Link></td>
              <td>{b.sourceName} <span className="muted small">· {b.scope === 'org' ? 'Organisation' : 'eigene'}</span></td>
              <td>{b.subPath ?? '/'}</td>
              <td>{b.files ?? own.get(b.sourceId)?.files ?? '–'}</td>
              <td><SyncState lastSyncAt={b.lastSyncAt} lastError={b.lastError} /></td>
              <td className="nowrap">
                <button className="btn sm" disabled={busy || !b.active} onClick={() => void run(async () => { await sync(b.sourceId, b.label); await pl.reload(); })}>Jetzt synchronisieren</button>{' '}
                {own.has(b.sourceId) && <><button className="btn sm" onClick={() => setModal(own.get(b.sourceId)!)}>Bearbeiten</button>{' '}</>}
                <button className="btn sm danger" disabled={busy} onClick={() => unbind(b)}>Entfernen</button>
              </td>
            </tr>
          ))}</tbody>
        </table>}
        {pl.data && available.length > 0 && <p className="muted small mb-0">Freigegeben von der Organisation: {available.map((s) => s.name).join(', ')}.</p>}
      </SettingsCard>
      {modal === 'bind' && <BindModal projectId={pid} available={available} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'own' && <OwnSourceModal projectId={pid} onClose={() => setModal(null)} onDone={done} />}
      {modal && typeof modal === 'object' && <OwnSourceModal projectId={pid} source={modal} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { DocFolder, DocPage, DocPageVersion, DocShare, DocTemplate } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Markdown, Modal, statusLabel, useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';

interface DocsData { folders: DocFolder[]; pages: DocPage[]; templates: DocTemplate[] }

export function DocsView() {
  const { detail } = useProject();
  const { pageId } = useParams();
  const nav = useNavigate();
  const docs = useData<DocsData>(`/projects/${detail.project.id}/docs`);
  const [newPage, setNewPage] = useState<{ folderId: string | null; parentPageId: string | null } | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [editFolder, setEditFolder] = useState<DocFolder | null>(null);
  const me = detail.project.myMembership;
  const base = `/projekte/${detail.project.id}/doku`;
  const byFolder = useMemo(() => {
    const map = new Map<string | null, DocPage[]>();
    for (const p of docs.data?.pages ?? []) { const k = p.folderId; map.set(k, [...(map.get(k) ?? []), p]); }
    return map;
  }, [docs.data]);
  const tree = (pages: DocPage[], parent: string | null, depth: number): JSX.Element[] =>
    pages.filter((p) => (p.parentPageId ?? null) === parent).flatMap((p) => [
      <div key={p.id} className={`page ${pageId === p.id ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => nav(`${base}/${p.id}`)}>
        <span className="t">{p.title}</span><span className={`badge ${p.status}`}>{statusLabel[p.status]}</span>
      </div>,
      ...tree(pages, p.id, depth + 1)
    ]);
  return (
    <div className="docs-layout">
      <div className="doc-tree">
        <div className="row between"><strong>Doku</strong>{me.role !== 'reader' && <button className="btn sm" onClick={() => setNewPage({ folderId: docs.data?.folders[0]?.id ?? null, parentPageId: null })}>+ Seite</button>}</div>
        {docs.data?.folders.filter((f) => !f.parentId).map((f) => (
          <div key={f.id}>
            <div className="folder"><span>{f.name}{f.distributionList.length > 0 && <span title={`Verteiler: ${f.distributionList.join(', ')}`}> ✉</span>}</span>
              {me.role === 'pl' && <button className="btn sm link" onClick={() => setEditFolder(f)}>⋯</button>}</div>
            {tree(byFolder.get(f.id) ?? [], null, 0)}
            {(byFolder.get(f.id) ?? []).length === 0 && <div className="muted small" style={{ padding: '2px 8px' }}>leer</div>}
          </div>
        ))}
        {(byFolder.get(null) ?? []).length > 0 && <><div className="folder">Ohne Ordner</div>{tree(byFolder.get(null) ?? [], null, 0)}</>}
        {me.role === 'pl' && <button className="btn sm link mt" onClick={() => setNewFolder(true)}>+ Ordner</button>}
      </div>
      {pageId ? <PageView key={pageId} pageId={pageId} docs={docs.data} reloadTree={docs.reload} onNewChild={(p) => setNewPage({ folderId: p.folderId, parentPageId: p.id })} /> : (
        <div className="doc-view">
          <h1>Dokumentation</h1>
          <p className="muted">Seiten in Ordnern, Seitenbaum, Markdown, Versionen, Status Entwurf → In Prüfung → Final. Finale Seiten sind gesperrt und gehen auf Wunsch an den Verteiler des Ordners.</p>
          <div className="grid cols-2 mt">
            <div className="card"><h3>Zuletzt geändert</h3><table className="table"><tbody>
              {[...(docs.data?.pages ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map((p) => <tr key={p.id} className="clickable" onClick={() => nav(`${base}/${p.id}`)}><td>{p.title}</td><td><span className={`badge ${p.status}`}>{statusLabel[p.status]}</span></td><td className="muted small nowrap">{p.updatedByName} · {fmtDateTime(p.updatedAt)}</td></tr>)}
            </tbody></table></div>
            <div className="card"><h3>Vorlagen</h3><ul>{docs.data?.templates.map((t) => <li key={t.id}>{t.name} <button className="btn sm link" onClick={() => setNewPage({ folderId: docs.data?.folders.find((f) => f.name === (t.key === 'protokoll' ? 'Protokolle' : t.key === 'statusbericht' ? 'Berichte' : 'Konzepte'))?.id ?? null, parentPageId: null })}>Seite anlegen</button></li>)}</ul></div>
          </div>
        </div>
      )}
      {newPage && docs.data && <NewPage folders={docs.data.folders} templates={docs.data.templates} init={newPage} onClose={() => setNewPage(null)} onCreated={async (id) => { setNewPage(null); await docs.reload(); nav(`${base}/${id}`); }} />}
      {newFolder && <FolderForm onClose={() => setNewFolder(false)} onSaved={async () => { setNewFolder(false); await docs.reload(); }} />}
      {editFolder && <FolderForm existing={editFolder} onClose={() => setEditFolder(null)} onSaved={async () => { setEditFolder(null); await docs.reload(); }} />}
    </div>
  );
}

function PageView({ pageId, docs, reloadTree, onNewChild }: { pageId: string; docs: DocsData | null; reloadTree: () => Promise<void>; onNewChild: (p: DocPage) => void }) {
  const { detail } = useProject();
  const nav = useNavigate();
  const d = useData<{ page: DocPage; versions: DocPageVersion[]; attachments: { id: string; filename: string; size: number }[]; activeShares: number }>(`/docs/pages/${pageId}`);
  const [edit, setEdit] = useState(false);
  const [share, setShare] = useState(false);
  const [showVersion, setShowVersion] = useState<DocPageVersion | null>(null);
  const { busy, error, run, setError } = useAsync();
  const me = detail.project.myMembership;
  if (d.error) return <div className="doc-view"><div className="error">{d.error}</div></div>;
  if (!d.data) return <div className="doc-view muted">Lade …</div>;
  const p = d.data.page;
  const folder = docs?.folders.find((f) => f.id === p.folderId);
  const canEdit = me.role !== 'reader' && p.status !== 'final';
  const canFinal = me.role === 'pl' || me.canFinalize;
  const setStatus = (status: string) => run(async () => { await api.post(`/docs/pages/${p.id}/status`, { status }); await d.reload(); await reloadTree(); });
  return (
    <div className="doc-view">
      <div className="row mb">
        <span className="muted small">{folder?.name ?? 'Ohne Ordner'} · Version {p.version} · {p.updatedByName} · {fmtDateTime(p.updatedAt)}</span>
        <span className={`badge ${p.status}`}>{statusLabel[p.status]}</span>
        <span className="right" />
        {canEdit && !edit && <button className="btn sm" onClick={() => setEdit(true)}>Bearbeiten</button>}
        {me.role !== 'reader' && <button className="btn sm" onClick={() => onNewChild(p)}>+ Unterseite</button>}
        {canFinal && <button className="btn sm" onClick={() => setShare(true)}>Teilen{d.data.activeShares > 0 && <span className="badge" style={{ marginLeft: 4 }}>{d.data.activeShares}</span>}</button>}
        {p.status === 'draft' && me.role !== 'reader' && <button className="btn sm" disabled={busy} onClick={() => void setStatus('review')}>In Prüfung geben</button>}
        {p.status === 'review' && me.role !== 'reader' && <button className="btn sm" disabled={busy} onClick={() => void setStatus('draft')}>Zurück auf Entwurf</button>}
        {p.status !== 'final' && canFinal && <button className="btn sm primary" disabled={busy} onClick={() => void setStatus('final')}>Final setzen</button>}
        {p.status === 'final' && canFinal && <>
          <button className="btn sm" disabled={busy} onClick={() => { if (confirm('Finale Seite wieder öffnen? Es entsteht eine neue Version.')) void setStatus('draft'); }}>Wieder öffnen</button>
          <button className="btn sm primary" disabled={busy || !folder?.distributionList.length} title={folder?.distributionList.length ? `An: ${folder.distributionList.join(', ')}` : 'Ordner hat keinen Verteiler'} onClick={() => void run(async () => { const r = await api.post<{ to: string[] }>(`/docs/pages/${p.id}/distribute`, {}); setError(null); alert(`Versendet an: ${r.to.join(', ')}`); })}>An Verteiler senden</button>
        </>}
        {me.role === 'pl' && <button className="btn sm danger" onClick={() => { if (confirm('Seite löschen?')) void run(async () => { await api.del(`/docs/pages/${p.id}`); await reloadTree(); nav(`/projekte/${detail.project.id}/doku`); }); }}>Löschen</button>}
      </div>
      {p.status === 'final' && <div className="success mb small">Final seit {fmtDateTime(p.finalizedAt)}. Die Seite ist gesperrt und versioniert.</div>}
      {error && <div className="error mb">{error}</div>}
      {edit ? <Editor page={p} onCancel={() => setEdit(false)} onSaved={async () => { setEdit(false); await d.reload(); await reloadTree(); }} /> : <Markdown md={p.contentMd} />}
      <div className="grid cols-2 mt">
        <div className="card">
          <h3>Versionen</h3>
          <table className="table"><tbody>
            {d.data.versions.map((v) => <tr key={v.id}><td>v{v.version}</td><td><span className={`badge ${v.status}`}>{statusLabel[v.status]}</span></td><td className="muted small">{v.savedByName} · {fmtDateTime(v.savedAt)}</td><td>{v.version !== p.version && <button className="btn sm link" onClick={() => void api.get<{ version: DocPageVersion }>(`/docs/pages/${p.id}/versions/${v.version}`).then((r) => setShowVersion(r.version))}>Ansehen</button>}</td></tr>)}
          </tbody></table>
        </div>
        <div className="card">
          <h3>Anhänge</h3>
          <ul>{d.data.attachments.map((a) => <li key={a.id}><a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.filename}</a> <span className="muted small">({Math.round(a.size / 1024)} KB)</span></li>)}</ul>
          {me.role !== 'reader' && <input type="file" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); void run(async () => { await api.post(`/attachments?pageId=${p.id}`, fd); await d.reload(); }); }} />}
        </div>
      </div>
      {showVersion && <Modal title={`${showVersion.title} – Version ${showVersion.version}`} onClose={() => setShowVersion(null)}><Markdown md={showVersion.contentMd} /></Modal>}
      {share && <ShareDialog page={p} onClose={() => { setShare(false); void d.reload(); }} />}
    </div>
  );
}

function ShareDialog({ page, onClose }: { page: DocPage; onClose: () => void }) {
  const shares = useData<{ shares: DocShare[] }>(`/docs/pages/${page.id}/shares`);
  const [f, setF] = useState({ email: '', mode: 'read', includeChildren: true, expiresDays: '30', send: true, message: '' });
  const [created, setCreated] = useState<{ url: string; sent: boolean } | null>(null);
  const { busy, error, run } = useAsync();
  return (
    <Modal title={`Teilen: ${page.title}`} onClose={onClose}>
      <p className="muted small">Freigabe per persönlichem Link an eine Mail-Adresse, ohne Login. Lesend oder schreibend, wahlweise inkl. Unterseiten, mit Ablaufdatum, jederzeit widerrufbar. Externe Änderungen werden mit der Mail-Adresse versioniert und gemeldet.</p>
      <div className="form cols-2">
        <label className="field full"><span>Mail-Adresse</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="extern@partner.de" /></label>
        <label className="field"><span>Rechte</span><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="read">Nur lesen</option><option value="write">Lesen und bearbeiten</option></select></label>
        <label className="field"><span>Gültig (Tage, leer = unbegrenzt)</span><input type="number" min={1} value={f.expiresDays} onChange={(e) => setF({ ...f, expiresDays: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.includeChildren} onChange={(e) => setF({ ...f, includeChildren: e.target.checked })} /> Unterseiten einschließen</label>
        <label className="check"><input type="checkbox" checked={f.send} onChange={(e) => setF({ ...f, send: e.target.checked })} /> Link per Mail über das Projektkonto senden</label>
        {f.send && <label className="field full"><span>Nachricht (optional)</span><textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></label>}
        {error && <div className="error full">{error}</div>}
        <div className="full row"><button className="btn primary" disabled={busy || !f.email} onClick={() => void run(async () => {
          const r = await api.post<{ share: DocShare; sent: boolean }>(`/docs/pages/${page.id}/shares`, { email: f.email, mode: f.mode, includeChildren: f.includeChildren, expiresDays: f.expiresDays ? Number(f.expiresDays) : null, send: f.send, message: f.message });
          setCreated({ url: r.share.url, sent: r.sent }); setF({ ...f, email: '' }); await shares.reload();
        })}>Freigeben</button></div>
        {created && <div className="success full small">Freigabe erstellt{created.sent ? ' und per Mail gesendet' : ''}. Link: <code style={{ userSelect: 'all' }}>{created.url}</code></div>}
      </div>
      <h3 className="mt">Bestehende Freigaben</h3>
      {shares.data?.shares.length === 0 && <p className="muted small">Keine.</p>}
      {shares.data && shares.data.shares.length > 0 && (
        <table className="table"><thead><tr><th>Empfänger</th><th>Rechte</th><th>Gültig bis</th><th>Zugriffe</th><th /></tr></thead><tbody>
          {shares.data.shares.map((s) => (
            <tr key={s.id} style={{ opacity: s.revokedAt ? 0.5 : 1 }}>
              <td>{s.email}<div className="muted small">{s.includeChildren ? 'inkl. Unterseiten' : 'nur diese Seite'}</div></td>
              <td>{s.mode === 'write' ? 'schreibend' : 'lesend'}</td>
              <td className="small">{s.revokedAt ? 'widerrufen' : s.expiresAt ? fmtDateTime(s.expiresAt) : 'unbegrenzt'}</td>
              <td className="small">{s.accessCount}{s.lastAccessAt && <div className="muted">zuletzt {fmtDateTime(s.lastAccessAt)}</div>}</td>
              <td className="nowrap">{!s.revokedAt && <><button className="btn sm" onClick={() => void navigator.clipboard?.writeText(s.url)}>Link kopieren</button> <button className="btn sm danger" onClick={() => void run(async () => { await api.del(`/docs/shares/${s.id}`); await shares.reload(); })}>Widerrufen</button></>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </Modal>
  );
}

function Editor({ page, onCancel, onSaved }: { page: DocPage; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState(page.title);
  const [md, setMd] = useState(page.contentMd);
  const { busy, error, run } = useAsync();
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void save(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const save = () => run(async () => { await api.patch(`/docs/pages/${page.id}`, { title, contentMd: md, baseVersion: page.version }); await onSaved(); });
  return (
    <div>
      <div className="row mb"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={{ fontSize: 18, fontWeight: 600 }} /><button className="btn primary" disabled={busy} onClick={() => void save()}>Speichern (Strg+S)</button><button className="btn" onClick={onCancel}>Abbrechen</button></div>
      {error && <div className="error mb">{error}</div>}
      <div className="doc-editor">
        <textarea value={md} onChange={(e) => setMd(e.target.value)} />
        <div className="card" style={{ overflow: 'auto' }}><Markdown md={md} /></div>
      </div>
      <p className="muted small mt">Markdown. Tabellen mit | Spalte | Spalte |. Jede Speicherung erzeugt eine neue Version; Speichern auf einer veralteten Version wird abgelehnt.</p>
    </div>
  );
}

function NewPage({ folders, templates, init, onClose, onCreated }: { folders: DocFolder[]; templates: DocTemplate[]; init: { folderId: string | null; parentPageId: string | null }; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const { detail } = useProject();
  const [f, setF] = useState({ title: '', folderId: init.folderId ?? '', templateKey: '' });
  const { busy, error, run } = useAsync();
  return (
    <Modal title={init.parentPageId ? 'Neue Unterseite' : 'Neue Seite'} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Titel</span><input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></label>
        <label className="field"><span>Ordner</span><select value={f.folderId} onChange={(e) => setF({ ...f, folderId: e.target.value })}><option value="">– ohne –</option>{folders.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="field"><span>Vorlage</span><select value={f.templateKey} onChange={(e) => setF({ ...f, templateKey: e.target.value })}><option value="">– leer –</option>{templates.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={busy || !f.title.trim()} onClick={() => void run(async () => { const r = await api.post<{ page: DocPage }>(`/projects/${detail.project.id}/docs/pages`, { title: f.title, folderId: f.folderId || null, parentPageId: init.parentPageId, templateKey: f.templateKey || null }); await onCreated(r.page.id); })}>Anlegen</button></div>
      </div>
    </Modal>
  );
}

function FolderForm({ existing, onClose, onSaved }: { existing?: DocFolder; onClose: () => void; onSaved: () => Promise<void> }) {
  const { detail } = useProject();
  const [name, setName] = useState(existing?.name ?? '');
  const [list, setList] = useState(existing?.distributionList.join(', ') ?? '');
  const { busy, error, run } = useAsync();
  return (
    <Modal title={existing ? 'Ordner bearbeiten' : 'Neuer Ordner'} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Verteiler (Mail-Adressen, Komma)</span><input type="text" value={list} onChange={(e) => setList(e.target.value)} placeholder="gf@firma.de, kunde@extern.de" /></label>
        <p className="muted small">Finale Seiten dieses Ordners können an den Verteiler gesendet werden (W5). Versand über das Projektkonto.</p>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || !name} onClick={() => void run(async () => {
          const body = { name, distributionList: list.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean) };
          if (existing) await api.patch(`/projects/${detail.project.id}/docs/folders/${existing.id}`, body); else await api.post(`/projects/${detail.project.id}/docs/folders`, body);
          await onSaved();
        })}>Speichern</button>
          {existing && <button className="btn danger right" onClick={() => void run(async () => { await api.del(`/projects/${detail.project.id}/docs/folders/${existing.id}`); await onSaved(); })}>Löschen</button>}</div>
      </div>
    </Modal>
  );
}

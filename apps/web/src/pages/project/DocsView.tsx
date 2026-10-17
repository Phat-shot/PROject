import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { DocFolder, DocPage, DocPageSettings, DocPageVersion, DocShare, DocTemplate } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, statusLabel, useAsync, useDialog } from '../../components/ui';
import { HtmlView, RichEditor } from '../../components/RichEditor';
import { useProject } from '../ProjectPage';
import { useIsMobile } from '../../lib/useMedia';

interface DocsData { folders: DocFolder[]; pages: DocPage[]; templates: DocTemplate[] }
interface ChildRow { id: string; title: string; status: string; version: number; updatedAt: string; templateKey: string | null }
interface PageData { page: DocPage; versions: DocPageVersion[]; attachments: { id: string; filename: string; size: number }[]; activeShares: number; children: ChildRow[]; inheritedTemplateKey: string | null }

const KIND_LABEL: Record<string, string> = { series: 'Besprechungsreihe', subproject: 'Teilprojekt', report: 'Berichte', custom: 'Sammlung', folder: 'Ordner' };

export function DocsView() {
  const { detail } = useProject();
  const { pageId } = useParams();
  const nav = useNavigate();
  const docs = useData<DocsData>(`/projects/${detail.project.id}/docs`);
  const mobile = useIsMobile();
  const [treeOpen, setTreeOpen] = useState(false);
  const showTree = !mobile || !pageId || treeOpen;
  const [newPage, setNewPage] = useState<{ folderId: string | null; parentPageId: string | null; inherited?: string | null } | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [editFolder, setEditFolder] = useState<DocFolder | null>(null);
  const me = detail.project.myMembership;
  const base = `/projekte/${detail.project.id}/doku`;
  const byFolder = useMemo(() => {
    const map = new Map<string | null, DocPage[]>();
    for (const p of docs.data?.pages ?? []) { const k = p.folderId; map.set(k, [...(map.get(k) ?? []), p]); }
    return map;
  }, [docs.data]);
  // Unterseiten können in einem anderen Ordner liegen: Baum je Ordner nur mit Wurzeln dieses Ordners, Kinder aus allen Seiten
  const all = docs.data?.pages ?? [];
  /** Vorlage für Unterseiten: eigene Einstellung oder die der nächsten Oberseite, die eine hat. */
  const childTemplateOf = (p: DocPage): string | null => {
    let cur: DocPage | undefined = p;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); if (cur.settings?.childTemplateKey) return cur.settings.childTemplateKey; cur = all.find((x) => x.id === cur!.parentPageId); }
    return null;
  };
  const canWrite = me.role !== 'reader';
  const row = (p: DocPage, depth: number) => (
    <div key={p.id} className={`page ${pageId === p.id ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => nav(`${base}/${p.id}`)}>
      <span className="t">{(p.childCount ?? 0) > 0 ? '▾ ' : ''}{p.title}</span>
      {canWrite && <span className="acts" onClick={(e) => e.stopPropagation()}>
        <button title="Unterseite anlegen" onClick={() => setNewPage({ folderId: p.folderId, parentPageId: p.id, inherited: childTemplateOf(p) })}>+</button>
        <button title="Seiteneinstellungen" onClick={() => nav(`${base}/${p.id}?einstellungen=1`)}>⋯</button>
      </span>}
      <span className={`badge ${p.status}`}>{statusLabel[p.status]}</span>
    </div>
  );
  const tree = (pages: DocPage[], parent: string | null, depth: number): JSX.Element[] =>
    pages.filter((p) => (p.parentPageId ?? null) === parent).flatMap((p) => [row(p, depth), ...tree(pages, p.id, depth + 1)]);
  const rootsIn = (folderId: string | null) => (byFolder.get(folderId) ?? []).filter((p) => !p.isFolderPage && (!p.parentPageId || !all.some((x) => x.id === p.parentPageId)));
  /** Ordner öffnen: seine Seite (wird beim ersten Mal angelegt). */
  const openFolder = async (f: DocFolder) => {
    try { const r = await api.post<{ page: DocPage; created: boolean }>(`/projects/${detail.project.id}/docs/folders/${f.id}/page`); if (r.created) await docs.reload(); nav(`${base}/${r.page.id}`); }
    catch { /* Leser ohne Ordnerseite: nichts zu öffnen */ }
  };
  return (
    <div className="docs-layout">
      {mobile && pageId && <button className="btn sm tree-toggle" onClick={() => setTreeOpen(!treeOpen)}>{treeOpen ? '▾ Seitenbaum ausblenden' : '▸ Seitenbaum'}</button>}
      {showTree && <div className="doc-tree" onClick={() => { if (mobile) setTreeOpen(false); }}>
        <div className="row between"><strong>Doku</strong>{me.role !== 'reader' && <button className="btn sm" onClick={() => setNewPage({ folderId: docs.data?.folders[0]?.id ?? null, parentPageId: null })}>+ Seite</button>}</div>
        {docs.data?.folders.filter((f) => !f.parentId).map((f) => (
          <div key={f.id}>
            <div className={`folder ${f.pageId && pageId === f.pageId ? 'active' : ''}`}>
              <span className="t" title="Ordnerseite öffnen" onClick={() => void openFolder(f)}>{f.name}{f.distributionList.length > 0 && <span title={`Verteiler: ${f.distributionList.join(', ')}`}> ✉</span>}</span>
              {canWrite && <span className="acts">
                <button title="Seite in diesem Ordner anlegen" onClick={() => setNewPage({ folderId: f.id, parentPageId: null })}>+</button>
                {me.role === 'pl' && <button title="Ordner bearbeiten (Name, Verteiler)" onClick={() => setEditFolder(f)}>⋯</button>}
              </span>}
            </div>
            {rootsIn(f.id).flatMap((root) => [row(root, 0), ...tree(all, root.id, 1)])}
            {rootsIn(f.id).length === 0 && <div className="muted small" style={{ padding: '2px 8px' }}>leer</div>}
          </div>
        ))}
        {rootsIn(null).length > 0 && <><div className="folder">Ohne Ordner</div>{rootsIn(null).flatMap((root) => [row(root, 0), ...tree(all, root.id, 1)])}</>}
        {me.role === 'pl' && <button className="btn sm link mt" onClick={(e) => { e.stopPropagation(); setNewFolder(true); }}>+ Ordner</button>}
      </div>}
      {pageId ? <PageView key={pageId} pageId={pageId} docs={docs.data} reloadTree={docs.reload} onNewChild={(p, inherited) => setNewPage({ folderId: p.folderId, parentPageId: p.id, inherited })} onNewInFolder={(folderId) => setNewPage({ folderId, parentPageId: null })} /> : (
        <div className="doc-view">
          <h1>Dokumentation</h1>
          <p className="muted">Seiten mit Unterseiten, WYSIWYG-Editor, Versionen, Status Entwurf → In Prüfung → Final. Eine Oberseite (z. B. „JF Auftraggeber“ oder ein Teilprojekt) trägt Zusammenfassung und Teilnehmer, legt die Vorlage für ihre Unterseiten fest und das PDF-Layout.</p>
          <div className="grid cols-2 mt">
            <div className="card"><h3>Zuletzt geändert</h3><table className="table"><tbody>
              {[...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map((p) => <tr key={p.id} className="clickable" onClick={() => nav(`${base}/${p.id}`)}><td>{p.title}</td><td><span className={`badge ${p.status}`}>{statusLabel[p.status]}</span></td><td className="muted small nowrap">{p.updatedByName} · {fmtDateTime(p.updatedAt)}</td></tr>)}
            </tbody></table></div>
            <div className="card"><h3>Neue Seite aus Vorlage</h3><ul>{docs.data?.templates.map((t) => <li key={t.id}>{t.name} <button className="btn sm link" onClick={() => setNewPage({ folderId: docs.data?.folders.find((f) => f.name === (t.key === 'protokoll' || t.key === 'reihe' ? 'Protokolle' : t.key === 'statusbericht' ? 'Berichte' : 'Konzepte'))?.id ?? null, parentPageId: null, inherited: t.key })}>anlegen</button></li>)}</ul></div>
          </div>
        </div>
      )}
      {newPage && docs.data && <NewPage folders={docs.data.folders} templates={docs.data.templates} init={newPage} onClose={() => setNewPage(null)} onCreated={async (id) => { setNewPage(null); await docs.reload(); nav(`${base}/${id}`); }} />}
      {newFolder && <FolderForm onClose={() => setNewFolder(false)} onSaved={async () => { setNewFolder(false); await docs.reload(); }} />}
      {editFolder && <FolderForm existing={editFolder} onClose={() => setEditFolder(null)} onSaved={async () => { setEditFolder(null); await docs.reload(); }} />}
    </div>
  );
}

function PageView({ pageId, docs, reloadTree, onNewChild, onNewInFolder }: { pageId: string; docs: DocsData | null; reloadTree: () => Promise<void>; onNewChild: (p: DocPage, inherited: string | null) => void; onNewInFolder: (folderId: string | null) => void }) {
  const { detail } = useProject();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const d = useData<PageData>(`/docs/pages/${pageId}`);
  const [edit, setEdit] = useState(false);
  const [editor, setEditor] = useState<{ save: () => Promise<void>; busy: boolean } | null>(null);
  const [share, setShare] = useState(false);
  const [settings, setSettingsState] = useState(() => params.get('einstellungen') === '1');
  const setSettings = (v: boolean) => { setSettingsState(v); if (!v && params.get('einstellungen')) { const n = new URLSearchParams(params); n.delete('einstellungen'); setParams(n, { replace: true }); } };
  const [menu, setMenu] = useState(false);
  const [editFolder, setEditFolder] = useState(false);
  const [showVersion, setShowVersion] = useState<DocPageVersion | null>(null);
  const dialog = useDialog();
  const { busy, error, run, setError } = useAsync();
  const me = detail.project.myMembership;
  const base = `/projekte/${detail.project.id}/doku`;
  if (d.error) return <div className="doc-view"><div className="error">{d.error}</div></div>;
  if (!d.data) return <div className="doc-view muted">Lade …</div>;
  const p = d.data.page;
  const folder = docs?.folders.find((f) => f.id === p.folderId);
  const parent = docs?.pages.find((x) => x.id === p.parentPageId);
  const isFolderPage = Boolean(folder && folder.pageId === p.id);
  /** Seiten im Ordner (ohne die Ordnerseite selbst) als Unterseiten einer Ordnerseite */
  const folderChildren: ChildRow[] = isFolderPage ? (docs?.pages ?? []).filter((x) => x.folderId === p.folderId && !x.parentPageId && x.id !== p.id).map((x) => ({ id: x.id, title: x.title, status: x.status, version: x.version, updatedAt: x.updatedAt, templateKey: x.templateKey })) : [];
  const children = isFolderPage ? folderChildren : d.data.children;
  const newChild = () => (isFolderPage ? onNewInFolder(p.folderId) : onNewChild(p, childTemplate ?? null));
  const canEdit = me.role !== 'reader' && p.status !== 'final';
  const canFinal = me.role === 'pl' || me.canFinalize;
  const setStatus = (status: string) => run(async () => { await api.post(`/docs/pages/${p.id}/status`, { status }); await d.reload(); await reloadTree(); });
  const changeStatus = async (status: string) => {
    if (status === p.status) return;
    if (p.status === 'final') { const ok = await dialog.confirm({ title: 'Finale Seite wieder öffnen', text: 'Es entsteht eine neue Version; die Seite ist danach wieder bearbeitbar.', confirmLabel: 'Wieder öffnen' }); if (!ok) return; }
    if (status === 'final') { const ok = await dialog.confirm({ title: 'Final setzen', text: 'Die Seite wird gesperrt und kann als PDF an den Verteiler gehen. Später lässt sie sich wieder öffnen.', confirmLabel: 'Final setzen' }); if (!ok) return; }
    await setStatus(status);
  };
  const s = p.settings ?? {};
  const isTop = d.data.children.length > 0 || Boolean(s.kind) || Boolean(s.childTemplateKey);
  const childTemplate = s.childTemplateKey ?? d.data.inheritedTemplateKey;
  const tplName = (k: string | null | undefined) => docs?.templates.find((t) => t.key === k)?.name ?? k ?? 'leer';
  return (
    <div className="doc-view">
      <div className="row mb small muted">
        <Link to={base}>Doku</Link><span>›</span>{folder && !isFolderPage && (folder.pageId ? <Link to={`${base}/${folder.pageId}`}>{folder.name}</Link> : <span>{folder.name}</span>)}{parent && <><span>›</span><Link to={`${base}/${parent.id}`}>{parent.title}</Link></>}{!isFolderPage && <span>›</span>}<span>{isFolderPage ? `Ordner ${p.title}` : p.title}</span>
      </div>
      <div className="row mb doc-actions">
        <span className="muted small">Version {p.version} · {p.updatedByName} · {fmtDateTime(p.updatedAt)}</span>
        {me.role === 'reader' ? <span className={`badge ${p.status}`}>{statusLabel[p.status]}</span> : (
          <select className={`status-select ${p.status}`} value={p.status} disabled={busy} title="Status: Entwurf, In Prüfung (meldet sich bei der Projektleitung), Final (gesperrt, PDF-Versand)" onChange={(e) => void changeStatus(e.target.value)}>
            <option value="draft">Entwurf</option>
            <option value="review">In Prüfung</option>
            <option value="final" disabled={!canFinal}>Final</option>
          </select>
        )}
        {s.kind && <span className="badge">{KIND_LABEL[s.kind]}</span>}
        <span className="right" />
        {edit ? <>
          <button className="btn sm primary" disabled={!editor || editor.busy} onClick={() => void editor?.save()}>Speichern <kbd>Strg+S</kbd></button>
          <button className="btn sm" onClick={() => setEdit(false)}>Abbrechen</button>
        </> : <>
          {canEdit && <button className="btn sm primary" onClick={() => setEdit(true)}>Bearbeiten</button>}
          {p.status === 'final' && canFinal && <button className="btn sm" disabled={busy || !(folder?.distributionList.length || s.recipients?.length)} title={folder?.distributionList.length ? `An (Ordner): ${folder.distributionList.join(', ')}` : s.recipients?.length ? `An (Seite): ${s.recipients.join(', ')}` : 'Kein Verteiler am Ordner oder an der Seite'} onClick={() => void run(async () => { const r = await api.post<{ to: string[]; filename: string }>(`/docs/pages/${p.id}/distribute`, {}); setError(null); await d.reload(); await dialog.notify({ title: 'PDF versendet', text: `„${r.filename}“ ging an: ${r.to.join(', ')}` }); })}>Als PDF an Verteiler senden</button>}
          {me.role !== 'reader' && <button className="btn sm" onClick={newChild} title={isFolderPage ? 'Neue Seite in diesem Ordner' : childTemplate ? `Vorlage: ${tplName(childTemplate)}` : undefined}>{isFolderPage ? '+ Seite' : '+ Unterseite'}</button>}
          <span className="menu-wrap">
            <button className="btn sm" title="Weitere Aktionen" onClick={() => setMenu(!menu)}>⋯</button>
            {menu && <><div className="menu-backdrop" onClick={() => setMenu(false)} /><div className="menu" onClick={() => setMenu(false)}>
              {me.role !== 'reader' && <button onClick={() => setSettings(true)}>Seiteneinstellungen</button>}
              {isFolderPage && me.role === 'pl' && <button onClick={() => setEditFolder(true)}>Ordner bearbeiten (Name, Verteiler)</button>}
              <a href={`/api/docs/pages/${p.id}/pdf`} target="_blank" rel="noreferrer">PDF öffnen</a>
              {canFinal && <button onClick={() => setShare(true)}>Teilen per Link{d.data.activeShares > 0 ? ` (${d.data.activeShares} aktiv)` : ''}</button>}
              {me.role === 'pl' && !isFolderPage && <button className="danger" onClick={() => void dialog.confirm({ title: 'Seite löschen', text: `„${p.title}“ mit allen Versionen löschen? Unterseiten rücken eine Ebene hoch.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/docs/pages/${p.id}`); await reloadTree(); nav(base); }); })}>Löschen</button>}
            </div></>}
          </span>
        </>}
      </div>
      {p.status === 'final' && <div className="success mb small">Final seit {fmtDateTime(p.finalizedAt)}. Die Seite ist gesperrt und versioniert.</div>}
      {error && <div className="error mb">{error}</div>}
      {edit ? <Editor page={p} onApi={setEditor} onSaved={async () => { setEdit(false); setEditor(null); await d.reload(); await reloadTree(); }} /> : <HtmlView html={p.contentHtml} />}
      {!edit && (isTop || s.showChildren || isFolderPage) && (
        <div className="children-index">
          <h3>{isFolderPage ? 'Seiten in diesem Ordner' : 'Unterseiten'} <span className="badge">{children.length}</span>{me.role !== 'reader' && <button className="btn sm link" onClick={newChild}>{isFolderPage ? '+ neue Seite' : `+ neue Unterseite${childTemplate ? ` aus „${tplName(childTemplate)}“` : ''}`}</button>}</h3>
          {children.length === 0 ? <p className="muted small">{isFolderPage ? 'Noch keine Seiten in diesem Ordner.' : 'Noch keine Unterseiten.'}</p> : (
            <table className="table"><thead><tr><th>Seite</th><th>Status</th><th>Version</th><th>Geändert</th></tr></thead><tbody>
              {children.map((c) => <tr key={c.id} className="clickable" onClick={() => nav(`${base}/${c.id}`)}><td>{c.title}</td><td><span className={`badge ${c.status}`}>{statusLabel[c.status]}</span></td><td>{c.version}</td><td className="muted small">{fmtDateTime(c.updatedAt)}</td></tr>)}
            </tbody></table>
          )}
        </div>
      )}
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
      {showVersion && <Modal title={`${showVersion.title} – Version ${showVersion.version}`} onClose={() => setShowVersion(null)}><HtmlView html={showVersion.contentHtml ?? ''} /></Modal>}
      {share && <ShareDialog page={p} onClose={() => { setShare(false); void d.reload(); }} />}
      {editFolder && folder && <FolderForm existing={folder} onClose={() => setEditFolder(false)} onSaved={async () => { setEditFolder(false); await reloadTree(); await d.reload(); }} />}
      {settings && <SettingsDialog page={p} templates={docs?.templates ?? []} pages={docs?.pages ?? []} inherited={d.data.inheritedTemplateKey} onClose={() => setSettings(false)} onSaved={async () => { setSettings(false); await d.reload(); await reloadTree(); }} />}
    </div>
  );
}

function Editor({ page, onApi, onSaved }: { page: DocPage; onApi: (api: { save: () => Promise<void>; busy: boolean }) => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState(page.title);
  const [html, setHtml] = useState(page.contentHtml);
  const { busy, error, run } = useAsync();
  const save = async () => { await run(async () => { await api.patch(`/docs/pages/${page.id}`, { title, contentHtml: html, baseVersion: page.version }); await onSaved(); }); };
  // Speichern-Knopf liegt in der Aktionsleiste der Seite; Zustand dorthin melden
  useEffect(() => { onApi({ save, busy }); }, [title, html, busy]);
  return (
    <div>
      <div className="row mb"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={{ fontSize: 18, fontWeight: 600 }} placeholder="Titel" /></div>
      {error && <div className="error mb">{error}</div>}
      <RichEditor html={html} onChange={setHtml} pageId={page.id} onSave={() => void save()} />
      <p className="muted small mt">Jede Speicherung erzeugt eine neue Version; Speichern auf einer veralteten Version wird abgelehnt. Bilder werden als Anhang der Seite gespeichert.</p>
    </div>
  );
}

function SettingsDialog({ page, templates, pages, inherited, onClose, onSaved }: { page: DocPage; templates: DocTemplate[]; pages: DocPage[]; inherited: string | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const s = page.settings ?? {};
  const [f, setF] = useState({ kind: s.kind ?? '', childTemplateKey: s.childTemplateKey ?? '', showChildren: s.showChildren ?? false, parentPageId: page.parentPageId ?? '', accentColor: s.pdf?.accentColor ?? '', headerText: s.pdf?.headerText ?? '', footerText: s.pdf?.footerText ?? '', showMeta: s.pdf?.showMeta !== false, recipients: (s.recipients ?? []).join(', ') });
  const { busy, error, run } = useAsync();
  const candidates = pages.filter((x) => x.id !== page.id && x.parentPageId !== page.id);
  return (
    <Modal title={`Seiteneinstellungen: ${page.title}`} onClose={onClose}>
      <div className="form">
        <p className="muted small">Eine Oberseite bündelt Unterseiten (Protokolle einer Reihe, Seiten eines Teilprojekts, Berichte). Vorlage und PDF-Layout gelten für alle Unterseiten, solange diese nichts anderes festlegen.</p>
        <label className="field"><span>Art der Seite</span><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="">Normale Seite</option><option value="series">Besprechungsreihe (Jour fixe)</option><option value="subproject">Teilprojekt</option><option value="report">Berichte</option><option value="custom">Sammlung</option></select></label>
        <label className="field"><span>Vorlage für neue Unterseiten {inherited && !f.childTemplateKey && <span className="muted">(geerbt: {templates.find((t) => t.key === inherited)?.name ?? inherited})</span>}</span>
          <select value={f.childTemplateKey} onChange={(e) => setF({ ...f, childTemplateKey: e.target.value })}><option value="">– wie Oberseite / leer –</option>{templates.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={f.showChildren} onChange={(e) => setF({ ...f, showChildren: e.target.checked })} /> Unterseiten-Index unter dem Inhalt anzeigen</label>
        <label className="field"><span>Oberseite dieser Seite</span><select value={f.parentPageId} onChange={(e) => setF({ ...f, parentPageId: e.target.value })}><option value="">– keine (oberste Ebene) –</option>{candidates.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
        <label className="field"><span>Empfängerkreis für den PDF-Versand dieser Seite <span className="muted">(Vorrang hat ein Verteiler am Ordner)</span></span><input type="text" value={f.recipients} placeholder="gf@kunde.de, lenkungskreis@firma.de" onChange={(e) => setF({ ...f, recipients: e.target.value })} /></label>
        <strong className="small">PDF-Layout (für diese Seite und Unterseiten; leer = Mandanten-Stil)</strong>
        <div className="form cols-2">
          <label className="field"><span>Akzentfarbe</span><input type="text" value={f.accentColor} placeholder="#1f5eff" onChange={(e) => setF({ ...f, accentColor: e.target.value })} /></label>
          <label className="field"><span>Kopfzeile</span><input type="text" value={f.headerText} placeholder="Projekt · Titel" onChange={(e) => setF({ ...f, headerText: e.target.value })} /></label>
          <label className="field"><span>Fußzeile</span><input type="text" value={f.footerText} onChange={(e) => setF({ ...f, footerText: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={f.showMeta} onChange={(e) => setF({ ...f, showMeta: e.target.checked })} /> Metadatenblock (Projekt, Version, Datum) anzeigen</label>
        </div>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={busy} onClick={() => void run(async () => {
          const settings: DocPageSettings = { ...s, kind: (f.kind || null) as any, childTemplateKey: f.childTemplateKey || null, showChildren: f.showChildren, recipients: f.recipients.split(/[,;\s]+/).filter(Boolean), pdf: { accentColor: f.accentColor || undefined, headerText: f.headerText || undefined, footerText: f.footerText || undefined, showMeta: f.showMeta } };
          await api.patch(`/docs/pages/${page.id}`, { settings, parentPageId: f.parentPageId || null });
          await onSaved();
        })}>Speichern</button></div>
      </div>
    </Modal>
  );
}

function NewPage({ folders, templates, init, onClose, onCreated }: { folders: DocFolder[]; templates: DocTemplate[]; init: { folderId: string | null; parentPageId: string | null; inherited?: string | null }; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const { detail } = useProject();
  const [f, setF] = useState({ title: '', folderId: init.folderId ?? '', templateKey: init.inherited ?? '' });
  const { busy, error, run } = useAsync();
  return (
    <Modal title={init.parentPageId ? 'Neue Unterseite' : 'Neue Seite'} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Titel</span><input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></label>
        {!init.parentPageId && <label className="field"><span>Ordner</span><select value={f.folderId} onChange={(e) => setF({ ...f, folderId: e.target.value })}><option value="">– ohne –</option>{folders.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
        <label className="field"><span>Vorlage{init.inherited && <span className="muted"> (von der Oberseite vorgegeben)</span>}</span><select value={f.templateKey} onChange={(e) => setF({ ...f, templateKey: e.target.value })}><option value="">– leer –</option>{templates.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={busy || !f.title.trim()} onClick={() => void run(async () => { const r = await api.post<{ page: DocPage }>(`/projects/${detail.project.id}/docs/pages`, { title: f.title, folderId: init.parentPageId ? undefined : f.folderId || null, parentPageId: init.parentPageId, templateKey: f.templateKey || null }); await onCreated(r.page.id); })}>Anlegen</button></div>
      </div>
    </Modal>
  );
}

function FolderForm({ existing, onClose, onSaved }: { existing?: DocFolder; onClose: () => void; onSaved: () => Promise<void> }) {
  const { detail } = useProject();
  const [name, setName] = useState(existing?.name ?? '');
  const [list, setList] = useState(existing?.distributionList.join(', ') ?? '');
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const nav = useNavigate();
  return (
    <Modal title={existing ? 'Ordner bearbeiten' : 'Neuer Ordner'} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Verteiler (Mail-Adressen, Komma)</span><input type="text" value={list} onChange={(e) => setList(e.target.value)} placeholder="gf@firma.de, kunde@extern.de" /></label>
        <p className="muted small">Finale Seiten dieses Ordners können als PDF an den Verteiler gesendet werden. Versand über das Projektkonto.</p>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || !name} onClick={() => void run(async () => {
          const body = { name, distributionList: list.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean) };
          if (existing) await api.patch(`/projects/${detail.project.id}/docs/folders/${existing.id}`, body); else await api.post(`/projects/${detail.project.id}/docs/folders`, body);
          await onSaved();
        })}>Speichern</button>
          {existing && <button className="btn danger right" onClick={() => void dialog.confirm({ title: 'Ordner löschen', text: `„${existing.name}“ samt Ordnerseite löschen? Geht nur, wenn der Ordner keine weiteren Seiten enthält.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${detail.project.id}/docs/folders/${existing.id}`); await onSaved(); nav(`/projekte/${detail.project.id}/doku`); }); })}>Löschen</button>}</div>
      </div>
    </Modal>
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

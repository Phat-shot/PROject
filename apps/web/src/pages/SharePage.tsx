import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { DocPage } from '@projekttool/shared';
import { api, fmtDateTime } from '../lib/api';
import { Markdown, statusLabel, useAsync } from '../components/ui';

interface ShareData {
  share: { mode: 'read' | 'write'; email: string; includeChildren: boolean; expiresAt: string | null; sharedBy: string | null; projectName: string };
  root: DocPage;
  pages: { id: string; parentPageId: string | null; title: string; status: string; version: number; updatedAt: string }[];
}

/** Öffentliche Ansicht über einen Freigabe-Link, ohne Login. */
export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<DocPage | null>(null);
  const [attachments, setAttachments] = useState<{ id: string; filename: string; size: number }[]>([]);
  const [edit, setEdit] = useState(false);
  const { busy, error: saveError, run } = useAsync();
  const load = async (pid?: string) => {
    if (!data || !pid || pid === data.root.id) {
      const d = await api.get<ShareData>(`/share/${token}`);
      setData(d);
      const r = await api.get<{ page: DocPage; attachments: any[] }>(`/share/${token}/pages/${d.root.id}`);
      setCurrent(r.page); setAttachments(r.attachments);
    } else {
      const r = await api.get<{ page: DocPage; attachments: any[] }>(`/share/${token}/pages/${pid}`);
      setCurrent(r.page); setAttachments(r.attachments);
    }
  };
  useEffect(() => { load().catch((e) => setError(e.message)); }, [token]);
  if (error) return <div className="login"><div className="card"><h1>Freigabe nicht verfügbar</h1><p className="muted">{error}</p><p className="small muted">Der Link ist ungültig, abgelaufen oder wurde widerrufen. Bitte wenden Sie sich an die Person, die ihn geschickt hat.</p></div></div>;
  if (!data || !current) return <div className="content muted">Lade …</div>;
  const tree = (parent: string | null, depth: number): JSX.Element[] =>
    data.pages.filter((p) => p.parentPageId === parent).flatMap((p) => [
      <div key={p.id} className={`page ${current.id === p.id ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => { setEdit(false); void load(p.id); }}>
        <span className="t">{p.title}</span><span className={`badge ${p.status}`}>{statusLabel[p.status]}</span>
      </div>,
      ...tree(p.id, depth + 1)
    ]);
  const canEdit = data.share.mode === 'write' && current.status !== 'final';
  return (
    <div>
      <div className="share-banner">
        <strong>{data.share.projectName}</strong>
        <span>Freigegeben von {data.share.sharedBy ?? 'Projektteam'} für {data.share.email} · {data.share.mode === 'write' ? 'Lesen und Bearbeiten' : 'Nur Lesen'}{data.share.expiresAt ? ` · gültig bis ${fmtDateTime(data.share.expiresAt)}` : ''}</span>
      </div>
      <div className="share-page">
        <div className="tree doc-tree">
          <strong className="small">Seiten</strong>
          {tree(null, 0)}
        </div>
        <div className="main">
          <div className="row mb">
            <span className="muted small">Version {current.version} · {current.updatedByName ?? ''} · {fmtDateTime(current.updatedAt)}</span>
            <span className={`badge ${current.status}`}>{statusLabel[current.status]}</span>
            <a className="btn sm right" href={`/api/share/${token}/pages/${current.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
            {canEdit && !edit && <button className="btn sm" onClick={() => setEdit(true)}>Bearbeiten</button>}
            {data.share.mode === 'write' && current.status === 'final' && <span className="muted small right">Finale Seite: gesperrt</span>}
          </div>
          {saveError && <div className="error mb">{saveError}</div>}
          {edit ? <ShareEditor page={current} busy={busy} onCancel={() => setEdit(false)} onSave={(md) => void run(async () => { const r = await api.patch<{ page: DocPage }>(`/share/${token}/pages/${current.id}`, { contentMd: md, baseVersion: current.version }); setCurrent(r.page); setEdit(false); })} /> : <Markdown md={current.contentMd} />}
          {attachments.length > 0 && <div className="card mt"><h3>Anhänge</h3><ul>{attachments.map((a) => <li key={a.id}><a href={`/api/share/${token}/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.filename}</a></li>)}</ul></div>}
          <p className="muted small mt">Dieser Link ist persönlich. Änderungen werden mit Ihrer Mail-Adresse versioniert und dem Projektteam gemeldet.</p>
        </div>
      </div>
    </div>
  );
}

function ShareEditor({ page, busy, onCancel, onSave }: { page: DocPage; busy: boolean; onCancel: () => void; onSave: (md: string) => void }) {
  const [md, setMd] = useState(page.contentMd);
  return (
    <div>
      <div className="row mb"><button className="btn primary" disabled={busy} onClick={() => onSave(md)}>Speichern</button><button className="btn" onClick={onCancel}>Abbrechen</button><span className="muted small">Markdown. Speichern erzeugt eine neue Version.</span></div>
      <div className="doc-editor"><textarea value={md} onChange={(e) => setMd(e.target.value)} /><div className="card" style={{ overflow: 'auto' }}><Markdown md={md} /></div></div>
    </div>
  );
}

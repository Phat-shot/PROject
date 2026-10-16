import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { InboxMail } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { fmtDateTime } from '../lib/api';
import { TopBar } from '../components/Layout';

/** Gemeinsames Postfach: alle lesbaren Ansichten über alle aktiven Projekte. Öffnen führt in das Projekt-Postfach. */
export function InboxPage() {
  const [folder, setFolder] = useState('INBOX');
  const [project, setProject] = useState('');
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const { data, error } = useData<{ mails: InboxMail[]; views: { id: string; name: string; projectId: string; projectKey: string }[] }>(`/mail/inbox?folder=${folder}${project ? `&projectId=${project}` : ''}`, [folder, project]);
  const projects = Array.from(new Map((data?.views ?? []).map((v) => [v.projectId, v.projectKey])).entries());
  const needle = q.trim().toLowerCase();
  const mails = (data?.mails ?? []).filter((m) => !needle || m.subject.toLowerCase().includes(needle) || m.fromAddr.toLowerCase().includes(needle) || (m.fromName ?? '').toLowerCase().includes(needle));
  return (
    <>
      <TopBar title="Postfach" />
      <div className="content">
        <div className="filterbar">
          <select value={folder} onChange={(e) => setFolder(e.target.value)}><option value="INBOX">Posteingang</option><option value="Sent">Gesendet</option><option value="">Alle Ordner</option></select>
          <select value={project} onChange={(e) => setProject(e.target.value)}><option value="">Alle Projekte</option>{projects.map(([id, key]) => <option key={id} value={id}>{key}</option>)}</select>
          <input type="text" placeholder="Betreff oder Absender …" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="muted small right">{mails.length} Mails aus {data?.views.length ?? 0} Ansichten</span>
        </div>
        {error && <div className="error mb">{error}</div>}
        <div className="card" style={{ padding: 0 }}>
          {data && data.views.length === 0 && <div className="empty" style={{ margin: 12 }}>Keine Mail-Ansicht mit Leserecht. Ansichten werden im Projekt-Postfach angelegt.</div>}
          {data && data.views.length > 0 && mails.length === 0 && <div className="empty" style={{ margin: 12 }}>Keine Mails.</div>}
          {mails.map((m) => (
            <div key={m.id} className="mail-item" onClick={() => nav(`/projekte/${m.projectId}/mail/${m.viewId}/${m.id}`)}>
              <div className="from">
                <span><span className="badge" style={{ marginRight: 6 }}>{m.projectKey}</span>{m.folder.toLowerCase() === 'sent' ? `An: ${m.toJson.join(', ')}` : m.fromName ?? m.fromAddr}</span>
                <span className="date">{fmtDateTime(m.date)}</span>
              </div>
              <div className="subject">{m.subject}{m.linkedTaskIds.length > 0 && <span className="badge" style={{ marginLeft: 6 }}>Aufgabe</span>}{m.hasAttachments && ' 📎'}<span className="muted small" style={{ marginLeft: 8 }}>· {m.viewName}</span></div>
              <div className="snippet">{m.snippet}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

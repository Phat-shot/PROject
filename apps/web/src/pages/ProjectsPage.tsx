import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project, ProjectTemplate } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { api, fmtDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { TopBar } from '../components/Layout';
import { Modal, roleLabel, useAsync } from '../components/ui';

export function ProjectsPage() {
  const { user } = useAuth();
  const { data, reload } = useData<{ projects: Project[] }>('/projects');
  const [create, setCreate] = useState(false);
  const canCreate = user && ['org_admin', 'project_creator'].includes(user.globalRole);
  return (
    <>
      <TopBar title="Projekte">{canCreate && <button className="btn primary" onClick={() => setCreate(true)}>Neues Projekt</button>}</TopBar>
      <div className="content">
        {data && data.projects.length === 0 && <div className="empty">Du bist noch in keinem Projekt Mitglied.</div>}
        <div className="grid cols-3 proj-cards">
          {data?.projects.map((p) => {
            const s = p.stats;
            const total = s ? s.open + s.done : 0;
            return (
              <Link key={p.id} to={`/projekte/${p.id}`} className="card">
                <div className="row between"><span className="badge">{p.key}</span><span className="row" style={{ gap: 4 }}>{p.status === 'archived' && <span className="badge">archiviert</span>}<span className={`badge ${p.myRole}`}>{roleLabel[p.myRole ?? '']}</span></span></div>
                <h2 className="mt">{p.name}</h2>
                <p className="muted small">{p.description}</p>
                {s && p.status === 'active' && <>
                  <div className="bar" title={`${s.done} von ${total} erledigt`}><div className="done" style={{ width: `${total ? (s.done / total) * 100 : 0}%` }} /></div>
                  <div className="stats">
                    <span><b>{s.open}</b> offen</span>
                    <span className={s.overdue ? 'bad' : ''}><b>{s.overdue}</b> überfällig</span>
                    {s.nextMilestone ? <span title="Nächster Meilenstein">◆ {fmtDate(s.nextMilestone.date)} {s.nextMilestone.name}</span> : <span>kein Meilenstein</span>}
                  </div>
                </>}
              </Link>
            );
          })}
        </div>
      </div>
      {create && <CreateProject onClose={() => setCreate(false)} onCreated={() => { setCreate(false); void reload(); }} />}
    </>
  );
}

function CreateProject({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const templates = useData<{ templates: ProjectTemplate[] }>('/project-templates');
  const tpl = templates.data?.templates.find((t) => t.id === templateId);
  const { busy, error, run } = useAsync();
  return (
    <Modal title="Neues Projekt" onClose={onClose}>
      <div className="form">
        <label className="field"><span>Kürzel</span><input type="text" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="z. B. CRM" /></label>
        <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Beschreibung</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        {templates.data && templates.data.templates.length > 0 && <div className="grid cols-2">
          <label className="field"><span>Vorlage</span><select value={templateId} onChange={(e) => setTemplateId(e.target.value)}><option value="">– keine, Standardspalten –</option>{templates.data.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          {tpl && <label className="field"><span>Projektstart (Termine der Vorlage sind relativ dazu)</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>}
        </div>}
        {tpl && <p className="muted small">{tpl.description ? `${tpl.description} · ` : ''}{tpl.spec.columns?.length ?? 0} Spalten, {tpl.spec.subprojects?.length ?? 0} Teilprojekte, {tpl.spec.milestones?.length ?? 0} Meilensteine, {tpl.spec.labels?.length ?? 0} Labels, {tpl.spec.folders?.length ?? 0} Doku-Ordner</p>}
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.post('/projects', { key, name, description, templateId: templateId || null, startDate: tpl ? startDate : null }); onCreated(); })}>Anlegen</button></div>
        <p className="muted small">Du wirst PL. Die Projekt-Mailadresse ergibt sich aus dem angebundenen Projektkonto.</p>
      </div>
    </Modal>
  );
}

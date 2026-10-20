import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { OrgSettings, Project, ProjectTemplate } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { api, fmtDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { TopBar } from '../components/Layout';
import { Modal, roleLabel, useAsync } from '../components/ui';
import { useProjectPolicy } from '../lib/useProjectPolicy';

export function ProjectsPage() {
  const { user } = useAuth();
  const { data, reload } = useData<{ projects: Project[] }>('/projects');
  const [create, setCreate] = useState(false);
  const org = useData<{ settings: OrgSettings }>('/org/settings');
  const canCreate = Boolean(user && ['org_admin', 'project_creator'].includes(user.globalRole));
  // Persönliches Projekt (Assistent): Projektersteller immer, sonst wenn der Mandant es erlaubt
  const canPersonal = canCreate || Boolean(org.data?.settings.personalProjects);
  return (
    <>
      <TopBar title="Projekte">{(canCreate || canPersonal) && <button className="btn primary" onClick={() => setCreate(true)}>{canCreate ? 'Neues Projekt' : 'Persönliches Projekt'}</button>}</TopBar>
      <div className="content">
        {data && data.projects.length === 0 && <div className="empty">Du bist noch in keinem Projekt Mitglied.</div>}
        <div className="grid cols-3 proj-cards">
          {data?.projects.map((p) => {
            const s = p.stats;
            const badge = useProjectPolicy(p).badge;
            const total = s ? s.open + s.done : 0;
            return (
              <Link key={p.id} to={`/projekte/${p.id}`} className="card">
                <div className="row between"><span className="badge">{p.key}</span><span className="row" style={{ gap: 4 }}>{badge && <span className="badge" title={badge.title}>{badge.text}</span>}{p.status === 'archived' && <span className="badge">archiviert</span>}<span className={`badge ${p.myRole}`}>{roleLabel[p.myRole ?? '']}</span></span></div>
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
      {create && <CreateProject personalOnly={!canCreate} onClose={() => setCreate(false)} onCreated={() => { setCreate(false); void reload(); }} />}
    </>
  );
}

function CreateProject({ personalOnly = false, onClose, onCreated }: { personalOnly?: boolean; onClose: () => void; onCreated: () => void }) {
  const [personal, setPersonal] = useState(personalOnly);
  const policy = useProjectPolicy({ personal });
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const templates = useData<{ templates: ProjectTemplate[] }>('/project-templates');
  const tpl = templates.data?.templates.find((t) => t.id === templateId);
  const { busy, error, run } = useAsync();
  return (
    <Modal title={policy.scaffold.title} onClose={onClose}>
      <div className="form">
        <label className="check"><input type="checkbox" checked={personal} disabled={personalOnly} onChange={(e) => setPersonal(e.target.checked)} /> Persönlich (Assistent): nur du und KI-Agenten</label>
        {policy.scaffold.hint && <p className="muted small">{policy.scaffold.hint}</p>}
        <label className="field"><span>Kürzel</span><input type="text" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="z. B. CRM" /></label>
        <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Beschreibung</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        {policy.scaffold.template && templates.data && templates.data.templates.length > 0 && <div className="grid cols-2">
          <label className="field"><span>Vorlage</span><select value={templateId} onChange={(e) => setTemplateId(e.target.value)}><option value="">– keine, Standardspalten –</option>{templates.data.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          {tpl && <label className="field"><span>Projektstart (Termine der Vorlage sind relativ dazu)</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>}
        </div>}
        {policy.scaffold.template && tpl && <p className="muted small">{tpl.description ? `${tpl.description} · ` : ''}{tpl.spec.columns?.length ?? 0} Spalten, {tpl.spec.subprojects?.length ?? 0} Teilprojekte, {tpl.spec.milestones?.length ?? 0} Meilensteine, {tpl.spec.labels?.length ?? 0} Labels, {tpl.spec.folders?.length ?? 0} Doku-Ordner</p>}
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.post('/projects', { key, name, description, personal, templateId: policy.scaffold.template ? templateId || null : null, startDate: policy.scaffold.template && tpl ? startDate : null }); onCreated(); })}>Anlegen</button></div>
        <p className="muted small">Du wirst PL. Die Projekt-Mailadresse ergibt sich aus dem angebundenen Projektkonto.</p>
      </div>
    </Modal>
  );
}

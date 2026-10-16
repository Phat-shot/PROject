import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { api } from '../lib/api';
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
        <div className="grid cols-3">
          {data?.projects.map((p) => (
            <Link key={p.id} to={`/projekte/${p.id}`} className="card" style={{ color: 'inherit' }}>
              <div className="row between"><span className="badge">{p.key}</span><span className={`badge ${p.myRole}`}>{roleLabel[p.myRole ?? '']}</span></div>
              <h2 className="mt">{p.name}</h2>
              <p className="muted small">{p.description}</p>
              {p.status === 'archived' && <span className="badge">archiviert</span>}
            </Link>
          ))}
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
  const { busy, error, run } = useAsync();
  return (
    <Modal title="Neues Projekt" onClose={onClose}>
      <div className="form">
        <label className="field"><span>Kürzel</span><input type="text" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="z. B. CRM" /></label>
        <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Beschreibung</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.post('/projects', { key, name, description }); onCreated(); })}>Anlegen</button></div>
        <p className="muted small">Du wirst PL. Die Projekt-Mailadresse ergibt sich aus dem angebundenen Projektkonto.</p>
      </div>
    </Modal>
  );
}

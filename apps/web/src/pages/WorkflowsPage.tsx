import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Project, User } from '@projekttool/shared';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { useAsync, useDialog } from '../components/ui';
import { TopBar } from '../components/Layout';
import { ProjectScope } from './ProjectPage';
import { RunDetail, RunRow, StartRunDialog, WorkflowEditor, STEP_LABEL, stepSummary, type WorkflowDef, type WorkflowRun } from './project/WorkflowsView';

/**
 * Bereich „Workflows“ (nur global): Vorlagen (Schrittfolgen) werden hier gebaut und gelten mandantenweit.
 * Eine Instanz startet isoliert (eigenes Mini-Projekt), im gefilterten Projekt oder dort über „+ Workflow“ im Board.
 * Der Projektfilter (?projekt=) zeigt nur die Läufe dieses Projekts.
 */
export function WorkflowsPage() {
  const d = useData<{ definitions: WorkflowDef[]; runs: WorkflowRun[]; canBuild: boolean }>('/workflows');
  const users = useData<{ users: User[] }>('/users');
  const projects = useData<{ projects: Project[] }>('/projects');
  const [params, setParams] = useSearchParams();
  const pf = params.get('projekt') ?? '';
  const project = projects.data?.projects.find((p) => p.id === pf) ?? null;
  const [edit, setEdit] = useState<WorkflowDef | 'new' | null>(null);
  const [start, setStart] = useState<WorkflowDef | null>(null);
  const [startIn, setStartIn] = useState<WorkflowDef | null>(null);
  const dialog = useDialog();
  const { error, run } = useAsync();
  const nav = useNavigate();
  if (d.error) return <><TopBar title="Workflows" /><div className="content"><div className="error">{d.error}</div></div></>;
  if (!d.data) return <><TopBar title="Workflows" /><div className="content muted">Lade …</div></>;
  const runs = pf ? d.data.runs.filter((r) => r.projectId === pf) : d.data.runs;
  const active = runs.filter((r) => r.status === 'active');
  const finished = runs.filter((r) => r.status !== 'active');
  const members = (users.data?.users ?? []).filter((u) => u.kind !== 'agent').map((u) => ({ id: u.id, name: u.name }));
  return (
    <>
      <TopBar title="Workflows" />
      <div className="content">
        <p className="muted small" style={{ marginTop: 0 }}>Vorlagen für feste Abläufe: Arbeitspaket → Timer → Arbeitspaket → Warten auf Ereignis → Abschlussmail. Der Start ist der definierte Punkt, danach löst jeder Schritt den nächsten aus. Eine Instanz läuft isoliert als eigenes Mini-Projekt (hier starten) oder in einem Projekt statt eines Arbeitspakets (im Board „+ Workflow“).</p>
        {error && <div className="error mb">{error}</div>}
        <div className="filterbar mb">
          <select value={pf} onChange={(e) => { const n = new URLSearchParams(params); if (e.target.value) n.set('projekt', e.target.value); else n.delete('projekt'); setParams(n, { replace: true }); }} aria-label="Projektfilter">
            <option value="">Alle Projekte</option>
            {projects.data?.projects.filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
          </select>
          {project && <span className="muted small">Läufe in {project.key}; Vorlagen lassen sich direkt in diesem Projekt starten.</span>}
        </div>
        <div className="row between mb"><h2 style={{ margin: 0 }}>Vorlagen</h2>{d.data.canBuild && <button className="btn primary" onClick={() => setEdit('new')}>+ Workflow</button>}</div>
        {d.data.definitions.length === 0 && <div className="card muted small">Noch keine Vorlagen. {d.data.canBuild ? 'Lege die erste mit „+ Workflow“ an.' : 'Org-Admins und Projektersteller legen sie an.'}</div>}
        {d.data.definitions.map((w) => (
          <div key={w.id} className={`card ${w.active ? '' : 'muted'}`}>
            <div className="row between">
              <div><strong>{w.name}</strong>{!w.active && <span className="badge" style={{ marginLeft: 6 }}>inaktiv</span>}{w.description && <div className="muted small">{w.description}</div>}</div>
              <div className="row" style={{ gap: 6 }}>
                <span className="muted small">{w.runCount} Läufe{w.activeRuns > 0 ? `, ${w.activeRuns} aktiv` : ''}</span>
                {w.active && project && project.myRole !== 'reader' && <button className="btn sm primary" title={`Im Projekt ${project.key} starten: Arbeitspakete landen im Board`} onClick={() => setStartIn(w)}>In {project.key} starten</button>}
                {w.active && <button className={`btn sm ${project ? '' : 'primary'}`} title="Isoliert starten: eigener Lauf mit eigenem Mini-Projekt" onClick={() => setStart(w)}>Instanz starten</button>}
                {d.data!.canBuild && <button className="btn sm" onClick={() => setEdit(w)}>Bearbeiten</button>}
                {d.data!.canBuild && <button className="btn sm link" title="Löschen" onClick={() => void dialog.confirm({ title: 'Workflow löschen', text: `„${w.name}“ löschen? Bisherige Läufe bleiben als Historie.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/workflows/${w.id}`); await d.reload(); }); })}>✕</button>}
              </div>
            </div>
            <ol className="wf-steps small">{w.steps.map((s, i) => <li key={s.key}><strong>{i + 1}.</strong> {STEP_LABEL[s.type]}: {stepSummary(s)}</li>)}</ol>
          </div>
        ))}
        <h2 className="mt">Aktive Läufe {active.length > 0 && <span className="badge">{active.length}</span>}</h2>
        {active.length === 0 && <div className="muted small">Keine aktiven Läufe.</div>}
        {active.map((r) => <RunRow key={r.id} r={r} showProject onOpen={() => nav(`/workflows/laeufe/${r.id}`)} />)}
        {finished.length > 0 && <><h2 className="mt">Abgeschlossen</h2>{finished.slice(0, 40).map((r) => <RunRow key={r.id} r={r} showProject onOpen={() => nav(`/workflows/laeufe/${r.id}`)} />)}</>}
        {edit && <WorkflowEditor existing={edit === 'new' ? null : edit} members={members} contacts={[]} save={async (body) => { if (edit === 'new') await api.post('/workflows', body); else await api.patch(`/workflows/${edit.id}`, body); }} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await d.reload(); }} />}
        {startIn && project && <ProjectScope projectId={project.id}><StartRunDialog def={startIn} columnId={null} subprojectId={null} onClose={() => setStartIn(null)} onStarted={async (r) => { setStartIn(null); await d.reload(); nav(`/workflows/laeufe/${r.id}`); }} /></ProjectScope>}
        {start && <StartIsolatedDialog def={start} onClose={() => setStart(null)} onStarted={async (r) => { setStart(null); await d.reload(); nav(`/workflows/laeufe/${r.id}`); }} />}
      </div>
    </>
  );
}

function StartIsolatedDialog({ def, onClose, onStarted }: { def: WorkflowDef; onClose: () => void; onStarted: (r: WorkflowRun) => unknown }) {
  return <StartRunDialog def={def} standalone onClose={onClose} onStarted={onStarted} start={async (body) => (await api.post<{ run: WorkflowRun }>(`/workflows/${def.id}/start`, body)).run} />;
}

/** Lauf-Detail außerhalb des Projekts: lädt den Lauf, stellt den Projektkontext (Mini-Projekt oder Projekt) her. */
export function WorkflowRunPage() {
  const { rid } = useParams<{ rid: string }>();
  const nav = useNavigate();
  const d = useData<{ run: WorkflowRun }>(`/workflow-runs/${rid}`, [rid]);
  if (d.error) return <><TopBar title="Workflow" /><div className="content"><div className="error">{d.error}</div></div></>;
  if (!d.data) return <><TopBar title="Workflow" /><div className="content muted">Lade …</div></>;
  const r = d.data.run;
  return (
    <ProjectScope projectId={r.projectId} openTask={(tid) => { if (tid) nav(`/projekte/${r.projectId}/board?task=${tid}`); }}>
      <TopBar title={<><Link to="/workflows" style={{ color: 'inherit' }}>Workflows</Link><span className="muted" style={{ fontWeight: 400, marginLeft: 10 }}>› {r.name}</span></>} />
      <RunDetail runId={r.id} backTo="/workflows" />
    </ProjectScope>
  );
}


import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import type { AiCapabilities, BoardColumn, Label, Membership, Project, ProjectGroup, Subproject, Task, User } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { BoardView } from './project/BoardView';
import { PlanView } from './project/PlanView';
import { DocsView } from './project/DocsView';
import { PROJECT_SETTINGS_TABS, ProjectSettingsPage } from './project/settings/ProjectSettings';
import { CalendarView } from './project/CalendarView';
import { TimeView } from './project/TimeView';
import { TaskDrawer } from './project/TaskDrawer';
import { RaidView } from './project/RaidView';
import { AiView } from './project/AiView';
import { AnalyticsView } from './project/AnalyticsView';
import { MeetingsView } from './project/MeetingsView';
import { useOpenChat } from '../components/Messenger';
import { api } from '../lib/api';
import { useProjectPolicy } from '../lib/useProjectPolicy';
import { useAiStatus } from '../lib/useAi';

export interface Milestone { id: string; projectId: string; subprojectId: string | null; name: string; date: string }
export interface MemberRow extends Membership { name: string; email: string; kind?: 'person' | 'agent' }
export interface ProjectDetail {
  project: Project & { myMembership: Membership };
  members: MemberRow[];
  columns: BoardColumn[];
  subprojects: Subproject[];
  milestones: Milestone[];
  labels: Label[];
  /** Gruppen als Projektmitglied (Regel M) */
  groups?: ProjectGroup[];
}

interface ProjectCtx {
  detail: ProjectDetail;
  tasks: Task[];
  users: User[];
  reload: () => Promise<void>;
  reloadTasks: () => Promise<void>;
  openTask: (id: string | null) => void;
  /** KI-Fähigkeiten der angemeldeten Person im Projekt (Freigaben mit Begründung); null, solange sie laden */
  ai: AiCapabilities | null;
  reloadAi: () => Promise<void>;
}

const Ctx = createContext<ProjectCtx | null>(null);
export const useProject = () => useContext(Ctx)!;
/** Projektkontext, falls vorhanden (z. B. globales Postfach außerhalb eines Projekts). */
export const useProjectOptional = () => useContext(Ctx);

/** Lädt Projekt, Arbeitspakete und Benutzer und stellt den Projektkontext bereit; auch außerhalb der Projektseite nutzbar. */
export function ProjectScope({ projectId, openTask, children }: { projectId: string; openTask?: (id: string | null) => void; children: ReactNode }) {
  const nav = useNavigate();
  const detail = useData<ProjectDetail>(`/projects/${projectId}`, [projectId]);
  const tasks = useData<{ tasks: Task[] }>(`/projects/${projectId}/tasks`, [projectId]);
  const users = useData<{ users: User[] }>('/users');
  const ai = useData<AiCapabilities>(`/projects/${projectId}/ai/capabilities`, [projectId]);
  if (detail.error) return <div className="content"><div className="error">{detail.error}</div></div>;
  if (!detail.data || !tasks.data || !users.data) return <div className="content muted">Lade …</div>;
  const ctx: ProjectCtx = {
    detail: detail.data, tasks: tasks.data.tasks, users: users.data.users, reload: async () => { await detail.reload(); await ai.reload(); }, reloadTasks: tasks.reload, ai: ai.data, reloadAi: ai.reload,
    openTask: openTask ?? ((tid) => { if (tid) nav(`/projekte/${projectId}/board?task=${tid}`); })
  };
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const openTask = (tid: string | null) => {
    const next = new URLSearchParams(params);
    if (tid) next.set('task', tid); else next.delete('task');
    setParams(next, { replace: true });
  };
  return <ProjectScope projectId={id!} openTask={openTask}><ProjectBody /></ProjectScope>;
}

function ProjectBody() {
  const { detail, openTask } = useProject();
  const [params] = useSearchParams();
  const loc = useLocation();
  const { timeTracking } = useAuth();
  const id = detail.project.id;
  const p = detail.project;
  const badge = useProjectPolicy(p).badge;
  const base = `/projekte/${id}`;
  const sub = loc.pathname.slice(base.length).split('/')[1] ?? '';
  const isPl = p.myMembership.role === 'pl';
  const aiStatus = useAiStatus();
  // Die Leiste zeigt nur Projekte; alle Bereiche des Projekts stehen als Reiter in der Kopfzeile, Einstellungen zuletzt
  const tabs = [
    { to: `${base}/board`, label: 'Board' },
    { to: `${base}/plan`, label: 'Plan' },
    { to: `${base}/kalender`, label: 'Kalender' },
    { to: `${base}/besprechungen`, label: 'Besprechungen' },
    { to: `${base}/doku`, label: 'Doku' },
    { to: `${base}/raid`, label: 'Risiken' },
    ...(timeTracking && (p.timeTrackingEnabled || isPl) ? [{ to: `${base}/zeiten`, label: 'Zeiten' }] : []),
    { to: `${base}/auswertung`, label: 'Auswertung' },
    ...(aiStatus?.enabled || aiStatus?.killswitch ? [{ to: `${base}/ki`, label: 'KI' }] : []),
    { to: `${base}/einstellungen`, label: 'Einstellungen' }
  ];
  const taskId = params.get('task');
  return (
    <>
      <TopBar title={<><Link to={`/dashboard?projekt=${id}`} style={{ color: 'inherit' }} title="Dashboard dieses Projekts"><span className="badge" style={{ marginRight: 8 }}>{p.key}</span>{p.name}</Link>{badge && <span className="badge" style={{ marginLeft: 8 }} title={badge.title}>{badge.text}</span>}{p.status === 'archived' && <span className="badge" style={{ marginLeft: 8 }}>archiviert</span>}</>} tabs={tabs} tabsBelow />
      {sub === 'einstellungen' && <nav className="subtabs">{PROJECT_SETTINGS_TABS.map((t) => <NavLink key={t.key} to={`${base}/einstellungen/${t.key}`}>{t.label}</NavLink>)}</nav>}
      <Routes>
        <Route index element={<Navigate to={`${base}/board`} replace />} />
        <Route path="board" element={<BoardView />} />
        <Route path="plan" element={<PlanView />} />
        <Route path="kalender" element={<CalendarView />} />
        <Route path="zeiten" element={<TimeView />} />
        <Route path="auswertung" element={<AnalyticsView />} />
        <Route path="besprechungen" element={<MeetingsView />} />
        <Route path="mail/*" element={<MailRedirect />} />
        <Route path="doku/:pageId?" element={<DocsView />} />
        <Route path="einstellungen/*" element={<ProjectSettingsPage />} />
        <Route path="mitglieder" element={<Navigate to={`${base}/einstellungen/personen`} replace />} />
        <Route path="audit" element={<Navigate to={`${base}/einstellungen/daten`} replace />} />
        <Route path="raid" element={<RaidView />} />
        <Route path="ki" element={<AiView />} />
        <Route path="chat" element={<ProjectChatRedirect />} />
        <Route path="workflows" element={<Navigate to={`/workflows?projekt=${id}`} replace />} />
        <Route path="workflows/:runId" element={<RunRedirect />} />
        <Route path="*" element={<Navigate to={`${base}/board`} replace />} />
      </Routes>
      {taskId && <TaskDrawer taskId={taskId} onClose={() => openTask(null)} />}
    </>
  );
}

/** Postfach gibt es nur global: alte Projektlinks (Liste, Mail, Entwürfe, neue Mail) öffnen es mit Projektfilter. */
function MailRedirect() {
  const { detail } = useProject();
  const loc = useLocation();
  const id = detail.project.id;
  const rest = loc.pathname.replace(/^\/projekte\/[^/]+\/mail\/?/, '');
  const q = new URLSearchParams(loc.search);
  if (!q.has('projekt')) q.set('projekt', id);
  const to = rest.startsWith('m/') ? `/postfach/${rest}` : rest === 'freigaben' ? '/postfach/freigaben' : rest === 'neu' ? '/postfach/neu' : rest === 'ki' ? `/projekte/${id}/ki` : '/postfach';
  return <Navigate to={`${to}?${q.toString()}`} replace />;
}

/** Chat und Workflows gibt es nur global: alte Projektlinks öffnen den Messenger mit dem Projektkanal bzw. den Lauf. */
function ProjectChatRedirect() {
  const { detail } = useProject();
  const openChat = useOpenChat();
  const nav = useNavigate();
  const [params] = useSearchParams();
  useEffect(() => {
    let alive = true;
    void api.get<{ channel: { id: string } }>(`/projects/${detail.project.id}/chat`).then((r) => {
      if (!alive) return;
      nav(`/projekte/${detail.project.id}/board`, { replace: true });
      openChat(r.channel.id, params.get('thread'));
    }).catch(() => nav(`/projekte/${detail.project.id}/board`, { replace: true }));
    return () => { alive = false; };
  }, []);
  return <div className="content muted">Öffne Chat …</div>;
}

function RunRedirect() {
  const { runId } = useParams<{ runId: string }>();
  return <Navigate to={`/workflows/laeufe/${runId}`} replace />;
}

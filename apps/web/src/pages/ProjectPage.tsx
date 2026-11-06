import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import type { AiCapabilities, AiProposal, BoardColumn, Label, Membership, Project, ProjectGroup, Subproject, Task, User } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { TopBar, type TopTab } from '../components/Layout';
import { BoardView } from './project/BoardView';
import { PlanView } from './project/PlanView';
import { DocsView } from './project/DocsView';
import { PROJECT_SETTINGS_TABS, ProjectSettingsPage } from './project/settings/ProjectSettings';
import { CalendarView } from './project/CalendarView';
import { TimeView } from './project/TimeView';
import { SubprojectDrawer } from './project/SubprojectDrawer';
import { TaskDrawer } from './project/TaskDrawer';
import { RaidView } from './project/RaidView';
import { AnalyticsView } from './project/AnalyticsView';
import { NotFoundPage } from './NotFoundPage';
import { useOpenChat } from '../components/Messenger';
import { api } from '../lib/api';
import { useProjectPolicy } from '../lib/useProjectPolicy';
import { useAiStatus } from '../lib/useAi';
import { useRefresh } from '../lib/useRefresh';
import { Loading } from '../components/ui';

export type { Milestone } from '@projekttool/shared';
import type { Milestone } from '@projekttool/shared';
import { Breadcrumbs } from '../components/Breadcrumbs';
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
  /** Maske eines Teilprojekts öffnen (?sp=), null schließt */
  openSubproject: (id: string | null) => void;
  /** KI-Fähigkeiten der angemeldeten Person im Projekt (Freigaben mit Begründung); null, solange sie laden */
  ai: AiCapabilities | null;
  reloadAi: () => Promise<void>;
}

const Ctx = createContext<ProjectCtx | null>(null);
export const useProject = () => useContext(Ctx)!;
/** Projektkontext, falls vorhanden (z. B. globales Postfach außerhalb eines Projekts). */
export const useProjectOptional = () => useContext(Ctx);

/** Lädt Projekt, Arbeitspakete und Benutzer und stellt den Projektkontext bereit; auch außerhalb der Projektseite nutzbar. */
export function ProjectScope({ projectId, openTask, openSubproject, children }: { projectId: string; openTask?: (id: string | null) => void; openSubproject?: (id: string | null) => void; children: ReactNode }) {
  const nav = useNavigate();
  const detail = useData<ProjectDetail>(`/projects/${projectId}`, [projectId]);
  const tasks = useData<{ tasks: Task[] }>(`/projects/${projectId}/tasks`, [projectId]);
  const users = useData<{ users: User[] }>('/users');
  const ai = useData<AiCapabilities>(`/projects/${projectId}/ai/capabilities`, [projectId]);
  if (detail.error) return <div className="content"><div className="error" role="alert">{detail.error}</div></div>;
  if (!detail.data || !tasks.data || !users.data) return <div className="content"><Loading>Lädt Projekt …</Loading></div>;
  const ctx: ProjectCtx = {
    detail: detail.data, tasks: tasks.data.tasks, users: users.data.users, reload: async () => { await detail.reload(); await ai.reload(); }, reloadTasks: tasks.reload, ai: ai.data, reloadAi: ai.reload,
    openTask: openTask ?? ((tid) => { if (tid) nav(`/projekte/${projectId}/board?task=${tid}`); }),
    openSubproject: openSubproject ?? ((sid) => { if (sid) nav(`/projekte/${projectId}/board?sp=${sid}`); })
  };
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  // Eine Maske zur Zeit: Arbeitspaket (?task=) oder Teilprojekt (?sp=)
  const open = (key: 'task' | 'sp', v: string | null) => {
    const next = new URLSearchParams(params);
    next.delete('task'); next.delete('sp');
    if (v) next.set(key, v);
    setParams(next, { replace: true });
  };
  return <ProjectScope projectId={id!} openTask={(t) => open('task', t)} openSubproject={(s) => open('sp', s)}><ProjectBody /></ProjectScope>;
}

/** Zahl offener KI-Vorschläge (Badge am Reiter „KI“); nur mit Agent im Projekt. */
function useOpenProposals(projectId: string, enabled: boolean) {
  const d = useData<{ proposals: AiProposal[] }>(enabled ? `/projects/${projectId}/ai/proposals?status=pending` : null, [projectId, enabled]);
  useRefresh(d.reload, 60_000);
  return d.data?.proposals.length ?? 0;
}

/**
 * Bereiche des Projekts als Reiter, Einstellungen zuletzt; Kalender gehört zum Plan, Besprechungen zur Doku, KI-Läufe zu den
 * Einstellungen. Schlankes persönliches Projekt (project.slim): nur Board, Doku und Einstellungen (plus KI); die Routen bleiben.
 */
export function projectTabs({ base, slim, timeTracking, aiTab, openProposals }: { base: string; slim: boolean; timeTracking: boolean; aiTab: boolean; openProposals: number }): TopTab[] {
  return [
    { to: `${base}/board`, label: 'Board' },
    ...(slim ? [] : [{ to: `${base}/plan`, label: 'Plan' }]),
    { to: `${base}/doku`, label: 'Doku' },
    ...(slim ? [] : [{ to: `${base}/raid`, label: 'Risiken' }]),
    ...(!slim && timeTracking ? [{ to: `${base}/zeiten`, label: 'Zeiten' }] : []),
    ...(slim ? [] : [{ to: `${base}/auswertung`, label: 'Auswertung' }]),
    ...(aiTab ? [{ to: `${base}/einstellungen/ki-laeufe`, label: 'KI', badge: openProposals, badgeTitle: `${openProposals} offene KI-Vorschläge zur Freigabe` }] : []),
    { to: `${base}/einstellungen`, label: 'Einstellungen', end: false, exclude: aiTab ? `${base}/einstellungen/ki-laeufe` : undefined }
  ];
}

function ProjectBody() {
  const { detail, openTask, openSubproject, ai: caps } = useProject();
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
  const ai = Boolean(aiStatus?.enabled || aiStatus?.killswitch);
  // Reiter „KI“ nur mit Agent im Projekt: zeigt die Zahl offener Vorschläge (Freigaben) und führt zu Einstellungen › KI-Läufe
  const hasAgent = Boolean(caps && caps.agents.length > 0);
  const openProposals = useOpenProposals(id, hasAgent && ai);
  const tabs = projectTabs({ base, slim: Boolean(p.slim), timeTracking: Boolean(timeTracking && (p.timeTrackingEnabled || isPl)), aiTab: hasAgent && ai, openProposals });
  const settingsTabs = [...PROJECT_SETTINGS_TABS, ...(ai ? [{ key: 'ki-laeufe', label: 'KI-Läufe' }] : [])];
  const taskId = params.get('task');
  const spId = params.get('sp');
  const SECTION: Record<string, string> = { board: 'Board', plan: 'Plan', doku: 'Doku', raid: 'Risiken', zeiten: 'Zeiten', auswertung: 'Auswertung', einstellungen: 'Einstellungen' };
  const crumbs = <Breadcrumbs className="topbar-crumbs" items={[{ label: 'Projekte', to: '/projekte' }, { label: p.name, to: `${base}/board`, title: `${p.key} · Board` }, ...(SECTION[sub] ? [{ label: SECTION[sub], to: `${base}/${sub}` }] : [])]} />;
  return (
    <>
      <TopBar crumbs={crumbs} title={<><Link to={`/dashboard?projekt=${id}`} className="title-link" title="Dashboard dieses Projekts"><span className="badge mr-2">{p.key}</span>{p.name}</Link>{badge && <span className="badge ml-2" title={badge.title}>{badge.text}</span>}{p.status === 'archived' && <span className="badge ml-2">archiviert</span>}</>} tabs={tabs} tabsBelow />
      {sub === 'einstellungen' && <nav className="subtabs" aria-label="Einstellungen">{settingsTabs.map((t) => <NavLink key={t.key} to={`${base}/einstellungen/${t.key}`}>{t.label}{t.key === 'ki-laeufe' && openProposals > 0 && <span className="badge warn ml-1" title="offene KI-Vorschläge">{openProposals}</span>}</NavLink>)}</nav>}
      {sub === 'plan' && <nav className="subtabs" aria-label="Plan"><NavLink to={`${base}/plan`} end>Gantt und Listen</NavLink><NavLink to={`${base}/plan/kalender`}>Kalender</NavLink></nav>}
      <Routes>
        <Route index element={<Navigate to={`${base}/board`} replace />} />
        <Route path="board" element={<BoardView />} />
        <Route path="plan" element={<PlanView />} />
        <Route path="plan/kalender" element={<CalendarView />} />
        <Route path="kalender" element={<Navigate to={`${base}/plan/kalender`} replace />} />
        <Route path="zeiten" element={<TimeView />} />
        <Route path="auswertung" element={<AnalyticsView />} />
        <Route path="besprechungen" element={<Navigate to={`${base}/doku/besprechungen`} replace />} />
        <Route path="doku/besprechungen" element={<DocsView meetings />} />
        <Route path="mail/*" element={<MailRedirect />} />
        <Route path="doku/dateien" element={<DocsView files />} />
        <Route path="doku/dateien/:bindingId/*" element={<DocsView files />} />
        <Route path="doku/:pageId?" element={<DocsView />} />
        <Route path="einstellungen/*" element={<ProjectSettingsPage />} />
        <Route path="mitglieder" element={<Navigate to={`${base}/einstellungen/personen`} replace />} />
        <Route path="audit" element={<Navigate to={`${base}/einstellungen/daten`} replace />} />
        <Route path="raid" element={<RaidView />} />
        <Route path="ki" element={<Navigate to={`${base}/einstellungen/ki-laeufe`} replace />} />
        <Route path="chat" element={<ProjectChatRedirect />} />
        <Route path="workflows" element={<Navigate to={`/workflows?projekt=${id}`} replace />} />
        <Route path="workflows/:runId" element={<RunRedirect />} />
        <Route path="*" element={<NotFoundPage project={{ id, name: p.name }} withTopBar={false} />} />
      </Routes>
      {taskId && <TaskDrawer taskId={taskId} onClose={() => openTask(null)} />}
      {!taskId && spId && <SubprojectDrawer subprojectId={spId} onClose={() => openSubproject(null)} />}
    </>
  );
}

/** Postfach gibt es nur global: alte Projektlinks (Liste, Mail, Entwürfe, neue Mail) öffnen es mit Projektfilter; /mail/ki direkt auf die KI-Läufe. */
function MailRedirect() {
  const { detail } = useProject();
  const loc = useLocation();
  const id = detail.project.id;
  const rest = loc.pathname.replace(/^\/projekte\/[^/]+\/mail\/?/, '');
  const q = new URLSearchParams(loc.search);
  if (!q.has('projekt')) q.set('projekt', id);
  const to = rest.startsWith('m/') ? `/postfach/${rest}` : rest === 'freigaben' ? '/postfach/freigaben' : rest === 'neu' ? '/postfach/neu' : rest === 'ki' ? `/projekte/${id}/einstellungen/ki-laeufe` : '/postfach';
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
  return <div className="content"><Loading>Öffne Chat …</Loading></div>;
}

function RunRedirect() {
  const { runId } = useParams<{ runId: string }>();
  return <Navigate to={`/workflows/laeufe/${runId}`} replace />;
}

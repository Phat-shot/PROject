import { createContext, useContext } from 'react';
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom';
import type { BoardColumn, Label, Membership, Project, Subproject, Task, User } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { BoardView } from './project/BoardView';
import { PlanView } from './project/PlanView';
import { MailView } from './project/MailView';
import { DocsView } from './project/DocsView';
import { MembersView } from './project/MembersView';
import { AuditView } from './project/AuditView';
import { OverviewView } from './project/OverviewView';
import { CalendarView } from './project/CalendarView';
import { TimeView } from './project/TimeView';
import { TaskDrawer } from './project/TaskDrawer';

export interface Milestone { id: string; projectId: string; subprojectId: string | null; name: string; date: string }
export interface MemberRow extends Membership { name: string; email: string }
export interface ProjectDetail {
  project: Project & { myMembership: Membership };
  members: MemberRow[];
  columns: BoardColumn[];
  subprojects: Subproject[];
  milestones: Milestone[];
  labels: Label[];
}

interface ProjectCtx {
  detail: ProjectDetail;
  tasks: Task[];
  users: User[];
  reload: () => Promise<void>;
  reloadTasks: () => Promise<void>;
  openTask: (id: string | null) => void;
}

const Ctx = createContext<ProjectCtx>(null as any);
export const useProject = () => useContext(Ctx);

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const detail = useData<ProjectDetail>(`/projects/${id}`);
  const tasks = useData<{ tasks: Task[] }>(`/projects/${id}/tasks`);
  const users = useData<{ users: User[] }>('/users');
  if (detail.error) return <div className="content"><div className="error">{detail.error}</div></div>;
  if (!detail.data || !tasks.data || !users.data) return <div className="content muted">Lade …</div>;
  const p = detail.data.project;
  const openTask = (tid: string | null) => {
    const next = new URLSearchParams(params);
    if (tid) next.set('task', tid); else next.delete('task');
    setParams(next, { replace: true });
  };
  const base = `/projekte/${id}`;
  const ctx: ProjectCtx = { detail: detail.data, tasks: tasks.data.tasks, users: users.data.users, reload: detail.reload, reloadTasks: tasks.reload, openTask };
  // Bereiche kommen aus der Seitenleiste; die Kopfzeile zeigt nur die Unterreiter des aktuellen Bereichs
  const sub = loc.pathname.slice(base.length).split('/')[1] ?? '';
  const isPl = p.myMembership.role === 'pl';
  const tabs = ['board', 'plan', 'kalender', 'zeiten'].includes(sub)
    ? [
        { to: `${base}/board`, label: 'Board' },
        { to: `${base}/plan`, label: 'Plan' },
        { to: `${base}/kalender`, label: 'Kalender' },
        ...(p.timeTrackingEnabled || isPl ? [{ to: `${base}/zeiten`, label: 'Zeiten' }] : [])
      ]
    : ['einstellungen', 'audit'].includes(sub)
      ? [{ to: `${base}/einstellungen`, label: 'Einstellungen', end: true }, { to: `${base}/audit`, label: 'Audit' }]
      : undefined;
  const area = sub === '' ? 'Übersicht' : ['board', 'plan', 'kalender', 'zeiten'].includes(sub) ? 'Aufgaben' : sub === 'mail' ? 'Postfach' : sub === 'doku' ? 'Doku' : 'Einstellungen';
  const taskId = params.get('task');
  return (
    <Ctx.Provider value={ctx}>
      <TopBar title={<><span className="badge" style={{ marginRight: 8 }}>{p.key}</span>{p.name}{p.status === 'archived' && <span className="badge" style={{ marginLeft: 8 }}>archiviert</span>}<span className="muted" style={{ fontWeight: 400, marginLeft: 10 }}>› {area}</span></>} tabs={tabs} />
      <Routes>
        <Route index element={<OverviewView />} />
        <Route path="board" element={<BoardView />} />
        <Route path="plan" element={<PlanView />} />
        <Route path="kalender" element={<CalendarView />} />
        <Route path="zeiten" element={<TimeView />} />
        <Route path="mail/*" element={<MailView />} />
        <Route path="doku/:pageId?" element={<DocsView />} />
        <Route path="einstellungen" element={<MembersView />} />
        <Route path="mitglieder" element={<Navigate to={`${base}/einstellungen`} replace />} />
        <Route path="audit" element={<AuditView />} />
        <Route path="*" element={<Navigate to={base} replace />} />
      </Routes>
      {taskId && <TaskDrawer taskId={taskId} onClose={() => openTask(null)} />}
    </Ctx.Provider>
  );
}

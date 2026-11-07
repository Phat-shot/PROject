import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { takeReturnUrl, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { DashboardPage } from './pages/DashboardPage';
import { UserSettingsPage } from './pages/UserSettingsPage';
import { InboxPage } from './pages/InboxPage';
import { CalendarPage } from './pages/CalendarPage';
import { ChatPage } from './pages/ChatPage';
import { HelpPage } from './pages/HelpPage';
import { WorkflowsPage, WorkflowRunPage } from './pages/WorkflowsPage';
import { ProjectPage } from './pages/ProjectPage';
import { AdminPage } from './pages/admin/AdminPage';
import { SharePage } from './pages/SharePage';
import { SetupPage } from './pages/SetupPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { Loading } from './components/ui';
import { TaskRefRedirect } from './components/MentionInput';

/** Weiterleitung mit Erhalt der Filter (?…), z. B. alte Links auf „Alle Arbeitspakete“. */
function KeepQuery({ to }: { to: string }) {
  const loc = useLocation();
  return <Navigate to={`${to}${loc.search}`} replace />;
}

export default function App() {
  const { user, loading } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  useEffect(() => {
    if (user) { setNeedsSetup(false); return; }
    api.get<{ needsSetup: boolean }>('/setup/status').then((r) => setNeedsSetup(r.needsSetup)).catch(() => setNeedsSetup(false));
  }, [user]);
  // Nach erneuter Anmeldung (Sitzung war abgelaufen) zurück dorthin, wo die Arbeit unterbrochen wurde
  useEffect(() => {
    if (!user) return;
    const back = takeReturnUrl();
    if (back && back !== `${loc.pathname}${loc.search}`) nav(back, { replace: true });
  }, [user?.id]);
  if (window.location.pathname.startsWith('/s/')) {
    return <Routes><Route path="/s/:token" element={<SharePage />} /></Routes>;
  }
  if (window.location.pathname.startsWith('/einladung/')) {
    return <AcceptInvitePage token={window.location.pathname.split('/')[2] ?? ''} />;
  }
  if (window.location.pathname.startsWith('/passwort/')) {
    return <ResetPasswordPage token={window.location.pathname.split('/')[2] ?? ''} />;
  }
  if (loading || (!user && needsSetup === null)) return <div className="content"><Loading /></div>;
  if (!user && needsSetup) return <SetupPage onDone={() => window.location.reload()} />;
  if (!user) return <LoginPage />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard/*" element={<DashboardPage />} />
        <Route path="/postfach/*" element={<InboxPage />} />
        <Route path="/kalender" element={<CalendarPage />} />
        <Route path="/portfolio" element={<Navigate to="/dashboard/projekte" replace />} />
        <Route path="/chat/:cid?" element={<ChatPage />} />
        <Route path="/k/:ref" element={<TaskRefRedirect />} />
        <Route path="/hilfe/:doc?" element={<HelpPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/laeufe/:rid" element={<WorkflowRunPage />} />
        <Route path="/einstellungen/benutzer" element={<Navigate to="/einstellungen/allgemein" replace />} />
        <Route path="/einstellungen/konfiguration" element={<Navigate to="/einstellungen/mail" replace />} />
        <Route path="/einstellungen/*" element={<UserSettingsPage />} />
        <Route path="/projekte" element={<ProjectsPage />} />
        <Route path="/projekte/aufgaben" element={<KeepQuery to="/dashboard/arbeitspakete" />} />
        <Route path="/projekte/postfach" element={<Navigate to="/postfach" replace />} />
        <Route path="/meine-aufgaben" element={<Navigate to="/dashboard" replace />} />
        <Route path="/einstellungen/mail-konten" element={<Navigate to="/einstellungen/mail" replace />} />
        <Route path="/mail-konten" element={<Navigate to="/einstellungen/mail" replace />} />
        <Route path="/verwaltung/*" element={<AdminPage />} />
        <Route path="/projekte/:id/*" element={<ProjectPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}

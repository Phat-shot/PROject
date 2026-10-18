import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { DashboardPage } from './pages/DashboardPage';
import { UserSettingsPage } from './pages/UserSettingsPage';
import { InboxPage } from './pages/InboxPage';
import { CalendarPage } from './pages/CalendarPage';
import { ChatPage } from './pages/ChatPage';
import { WorkflowsPage, WorkflowRunPage } from './pages/WorkflowsPage';
import { ProjectPage } from './pages/ProjectPage';
import { MailAccountsPage } from './pages/MailAccountsPage';
import { AdminPage } from './pages/AdminPage';
import { SharePage } from './pages/SharePage';
import { SetupPage } from './pages/SetupPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from './lib/api';

/** Weiterleitung mit Erhalt der Filter (?…), z. B. alte Links auf „Alle Arbeitspakete“. */
function KeepQuery({ to }: { to: string }) {
  const loc = useLocation();
  return <Navigate to={`${to}${loc.search}`} replace />;
}

export default function App() {
  const { user, loading } = useAuth();
  if (window.location.pathname.startsWith('/s/')) {
    return <Routes><Route path="/s/:token" element={<SharePage />} /></Routes>;
  }
  if (window.location.pathname.startsWith('/einladung/')) {
    return <AcceptInvitePage token={window.location.pathname.split('/')[2] ?? ''} />;
  }
  if (window.location.pathname.startsWith('/passwort/')) {
    return <ResetPasswordPage token={window.location.pathname.split('/')[2] ?? ''} />;
  }
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  useEffect(() => {
    if (user) { setNeedsSetup(false); return; }
    api.get<{ needsSetup: boolean }>('/setup/status').then((r) => setNeedsSetup(r.needsSetup)).catch(() => setNeedsSetup(false));
  }, [user]);
  if (loading || (!user && needsSetup === null)) return <div className="content muted">Lade …</div>;
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
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/laeufe/:rid" element={<WorkflowRunPage />} />
        <Route path="/einstellungen/benutzer" element={<UserSettingsPage />} />
        <Route path="/einstellungen/konfiguration" element={<MailAccountsPage />} />
        <Route path="/projekte" element={<ProjectsPage />} />
        <Route path="/projekte/aufgaben" element={<KeepQuery to="/dashboard/arbeitspakete" />} />
        <Route path="/projekte/postfach" element={<Navigate to="/postfach" replace />} />
        <Route path="/meine-aufgaben" element={<Navigate to="/dashboard" replace />} />
        <Route path="/einstellungen/mail-konten" element={<Navigate to="/einstellungen/konfiguration" replace />} />
        <Route path="/mail-konten" element={<Navigate to="/einstellungen/konfiguration" replace />} />
        <Route path="/verwaltung" element={<AdminPage />} />
        <Route path="/projekte/:id/*" element={<ProjectPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}

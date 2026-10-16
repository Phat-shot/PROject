import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { AllTasksPage } from './pages/AllTasksPage';
import { InboxPage } from './pages/InboxPage';
import { ProjectPage } from './pages/ProjectPage';
import { MailAccountsPage } from './pages/MailAccountsPage';
import { AdminPage } from './pages/AdminPage';
import { SharePage } from './pages/SharePage';
import { SetupPage } from './pages/SetupPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { useEffect, useState } from 'react';
import { api } from './lib/api';

export default function App() {
  const { user, loading } = useAuth();
  if (window.location.pathname.startsWith('/s/')) {
    return <Routes><Route path="/s/:token" element={<SharePage />} /></Routes>;
  }
  if (window.location.pathname.startsWith('/einladung/')) {
    return <AcceptInvitePage token={window.location.pathname.split('/')[2] ?? ''} />;
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
        <Route path="/" element={<Navigate to="/projekte" replace />} />
        <Route path="/projekte" element={<ProjectsPage />} />
        <Route path="/projekte/aufgaben" element={<AllTasksPage />} />
        <Route path="/projekte/postfach" element={<InboxPage />} />
        <Route path="/meine-aufgaben" element={<Navigate to="/projekte/aufgaben?scope=mine" replace />} />
        <Route path="/einstellungen/mail-konten" element={<MailAccountsPage />} />
        <Route path="/mail-konten" element={<Navigate to="/einstellungen/mail-konten" replace />} />
        <Route path="/verwaltung" element={<AdminPage />} />
        <Route path="/projekte/:id/*" element={<ProjectPage />} />
        <Route path="*" element={<Navigate to="/projekte" replace />} />
      </Routes>
    </Layout>
  );
}

import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { MyTasksPage } from './pages/MyTasksPage';
import { ProjectPage } from './pages/ProjectPage';
import { MailAccountsPage } from './pages/MailAccountsPage';
import { AdminPage } from './pages/AdminPage';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="content muted">Lade …</div>;
  if (!user) return <LoginPage />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/projekte" replace />} />
        <Route path="/projekte" element={<ProjectsPage />} />
        <Route path="/meine-aufgaben" element={<MyTasksPage />} />
        <Route path="/mail-konten" element={<MailAccountsPage />} />
        <Route path="/verwaltung" element={<AdminPage />} />
        <Route path="/projekte/:id/*" element={<ProjectPage />} />
        <Route path="*" element={<Navigate to="/projekte" replace />} />
      </Routes>
    </Layout>
  );
}

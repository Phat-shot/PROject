import { Link, useLocation } from 'react-router-dom';
import { TopBar } from '../components/Layout';

/**
 * 404 statt stillem Redirect: unbekannte Adresse (global) oder unbekannter Bereich im Projekt. Nennt den Pfad und
 * führt zum Dashboard bzw. zum Board.
 */
export function NotFoundPage({ project, withTopBar = true }: { project?: { id: string; name: string }; withTopBar?: boolean }) {
  const loc = useLocation();
  const body = (
    <div className="content">
      <div className="card">
        <h2>Seite nicht gefunden</h2>
        <p className="muted">Unter <code>{loc.pathname}</code> gibt es {project ? `im Projekt „${project.name}“` : ''} nichts. Vielleicht ist der Link veraltet oder du hast keinen Zugriff.</p>
        <div className="row">
          {project ? <Link className="btn primary" to={`/projekte/${project.id}/board`}>Zum Board</Link> : <Link className="btn primary" to="/dashboard">Zum Dashboard</Link>}
          <Link className="btn" to="/projekte">Projektübersicht</Link>
          <Link className="btn link" to="/hilfe">Hilfe</Link>
        </div>
      </div>
    </div>
  );
  if (!withTopBar) return body;
  return <><TopBar title="Nicht gefunden" />{body}</>;
}

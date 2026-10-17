import { Link } from 'react-router-dom';
import type { Task } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useAsync, useDialog } from '../../components/ui';
import { useProject } from '../ProjectPage';

interface TrashData { tasks: Task[]; pages: { id: string; title: string; status: string; deletedAt: string }[]; purgeAfterDays: number }

/** Papierkorb des Projekts: gelöschte Arbeitspakete und Seiten wiederherstellen oder endgültig löschen. */
export function TrashCard() {
  const { detail, reloadTasks } = useProject();
  const pid = detail.project.id;
  const isPl = detail.project.myMembership.role === 'pl';
  const d = useData<TrashData>(`/projects/${pid}/trash`);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  const refresh = async () => { await d.reload(); await reloadTasks(); };
  const total = (d.data?.tasks.length ?? 0) + (d.data?.pages.length ?? 0);
  return (
    <div>
      <p className="muted small">Gelöschtes bleibt {d.data?.purgeAfterDays ?? 30} Tage hier und wird dann endgültig entfernt. Wiederherstellen darf jedes Mitglied, endgültig löschen der PL.</p>
      {error && <div className="error mb">{error}</div>}
      {d.data && total === 0 && <div className="empty">Papierkorb ist leer.</div>}
      {d.data && d.data.tasks.length > 0 && (
        <table className="table"><thead><tr><th>Arbeitspaket</th><th>Gelöscht</th><th /></tr></thead><tbody>
          {d.data.tasks.map((t) => <tr key={t.id}>
            <td><span className="tkey">{detail.project.key}-{t.number}</span> {t.title}</td>
            <td className="small muted nowrap">{fmtDateTime(t.deletedAt)}</td>
            <td className="nowrap">
              <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/restore`); await refresh(); })}>Wiederherstellen</button>
              {isPl && <button className="btn sm link danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Endgültig löschen', text: `„${t.title}“ mit Tasks, Kommentaren, Zeiten und Anhängen unwiderruflich löschen?`, confirmLabel: 'Endgültig löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/tasks/${t.id}?permanent=1`); await refresh(); }); })}>Endgültig</button>}
            </td>
          </tr>)}
        </tbody></table>
      )}
      {d.data && d.data.pages.length > 0 && (
        <table className="table mt"><thead><tr><th>Seite</th><th>Gelöscht</th><th /></tr></thead><tbody>
          {d.data.pages.map((p) => <tr key={p.id}>
            <td><Link to={`/projekte/${pid}/doku/${p.id}`}>{p.title}</Link></td>
            <td className="small muted nowrap">{fmtDateTime(p.deletedAt)}</td>
            <td className="nowrap">
              <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.post(`/docs/pages/${p.id}/restore`); await d.reload(); })}>Wiederherstellen</button>
              {isPl && <button className="btn sm link danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Endgültig löschen', text: `„${p.title}“ mit allen Versionen unwiderruflich löschen?`, confirmLabel: 'Endgültig löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/docs/pages/${p.id}?permanent=1`); await d.reload(); }); })}>Endgültig</button>}
            </td>
          </tr>)}
        </tbody></table>
      )}
    </div>
  );
}

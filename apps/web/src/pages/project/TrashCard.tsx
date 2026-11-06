import { Link } from 'react-router-dom';
import type { Task } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Button, Loading, useAsync, useDialog, useToast } from '../../components/ui';
import { useProject } from '../ProjectPage';

interface TrashData { tasks: Task[]; pages: { id: string; title: string; status: string; deletedAt: string }[]; purgeAfterDays: number; /** Aufgaben, die zum Checklistenpunkt wurden: Ziel-Aufgabe */ demoted?: Record<string, { number: number | null; title: string | null }> }

/**
 * Papierkorb des Projekts: gelöschte Arbeitspakete und Seiten wiederherstellen oder endgültig löschen. Aufgaben, die zum
 * Checklistenpunkt wurden, tragen den Hinweis; Wiederherstellen entfernt den Punkt und holt Checkliste und Anhänge zurück.
 */
export function TrashCard() {
  const { detail, reloadTasks } = useProject();
  const pid = detail.project.id;
  const isPl = detail.project.myMembership.role === 'pl';
  const d = useData<TrashData>(`/projects/${pid}/trash`);
  const dialog = useDialog();
  const toast = useToast();
  const { busy, error, run } = useAsync({ toast: true });
  const refresh = async () => { await d.reload(); await reloadTasks(); };
  const total = (d.data?.tasks.length ?? 0) + (d.data?.pages.length ?? 0);
  return (
    <div>
      <p className="muted small">Gelöschtes bleibt {d.data?.purgeAfterDays ?? 30} Tage hier und wird dann endgültig entfernt. Wiederherstellen darf jedes Mitglied, endgültig löschen der PL.</p>
      {error && <div className="error mb" role="alert">{error}</div>}
      {!d.data && !d.error && <Loading />}
      {d.data && total === 0 && <div className="empty">Papierkorb ist leer.</div>}
      {d.data && d.data.tasks.length > 0 && (
        <table className="table"><thead><tr><th>Arbeitspaket</th><th>Gelöscht</th><th /></tr></thead><tbody>
          {d.data.tasks.map((t) => <tr key={t.id}>
            <td><span className="tkey">{detail.project.key}-{t.number}</span> {t.title}{d.data!.demoted?.[t.id] && <span className="badge ml-1" title="Wiederherstellen entfernt den Checklistenpunkt wieder">{d.data!.demoted[t.id].number != null ? `wurde Checklistenpunkt von ${detail.project.key}-${d.data!.demoted[t.id].number}` : 'wurde Checklistenpunkt'}</span>}</td>
            <td className="small muted nowrap">{fmtDateTime(t.deletedAt)}</td>
            <td className="nowrap">
              <Button size="sm" disabled={busy} onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/restore`); await refresh(); if (d.data?.demoted?.[t.id]) toast.ok(`„${t.title}“ ist wieder eine Aufgabe; der Checklistenpunkt wurde entfernt.`); })}>Wiederherstellen</Button>
              {isPl && <Button size="sm" variant="link" className="danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Endgültig löschen', text: `„${t.title}“ mit Aufgaben, Checklistenpunkten, Kommentaren, Zeiten und Anhängen unwiderruflich löschen?`, confirmLabel: 'Endgültig löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/tasks/${t.id}?permanent=1`); await refresh(); }); })}>Endgültig</Button>}
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
              <Button size="sm" disabled={busy} onClick={() => void run(async () => { await api.post(`/docs/pages/${p.id}/restore`); await d.reload(); })}>Wiederherstellen</Button>
              {isPl && <Button size="sm" variant="link" className="danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Endgültig löschen', text: `„${p.title}“ mit allen Versionen unwiderruflich löschen?`, confirmLabel: 'Endgültig löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/docs/pages/${p.id}?permanent=1`); await d.reload(); }); })}>Endgültig</Button>}
            </td>
          </tr>)}
        </tbody></table>
      )}
    </div>
  );
}

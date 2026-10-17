import { Link } from 'react-router-dom';
import { fmtDate, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useProject } from '../ProjectPage';

interface Overview {
  escalations: { taskId: string; title: string; level: number; targetLevel: number; overdueDays: number; staleDays: number; blocked: boolean; score: number; reason: string; chain: string[]; responsible: string | null }[];
  time: { enabled: boolean; loggedMinutes: number; estimateMinutes: number; budgetHours: number | null };
  counts: { open: number; done: number; overdue: number; due_week: number; no_due: number };
  perSubproject: { id: string; name: string; total: number; done: number; overdue: number }[];
  milestones: { id: string; name: string; date: string; subprojectId: string | null }[];
  pendingDrafts: number;
  pagesInReview: { id: string; title: string; updated_at: string }[];
  conflicts: { id: string; title: string; conflicts: string[] }[];
  overdue: { id: string; title: string; dueDate: string; responsible: string | null }[];
  workload: { userId: string; name: string; open: number; overdue: number }[];
  activity: { action: string; objectType: string; objectId: string | null; details: any; createdAt: string; userName: string | null }[];
}

const ACTION_LABEL: Record<string, string> = {
  'task.create': 'Arbeitspaket angelegt', 'task.update': 'Arbeitspaket geändert', 'task.move': 'Arbeitspaket verschoben', 'task.archive': 'Arbeitspaket archiviert', 'task.create_from_mail': 'Arbeitspaket aus Mail',
  'mail.send': 'Mail gesendet', 'mail.draft_submitted': 'Entwurf eingereicht', 'page.create': 'Seite angelegt', 'page.update': 'Seite geändert', 'page.final': 'Seite final', 'page.review': 'Seite in Prüfung',
  'page.share': 'Seite freigegeben', 'page.external_edit': 'Extern bearbeitet', 'plan.shift': 'Nachfolger verschoben', 'member.set': 'Mitglied gesetzt', 'task.recurrence_created': 'Wiederholung angelegt'
};

/** Leeres Projekt: die nächsten Schritte, solange sie offen sind und das Projekt noch klein ist. Nur für die Projektleitung. */
function SetupChecklist({ taskCount }: { taskCount: number }) {
  const { detail } = useProject();
  const p = detail.project;
  const base = `/projekte/${p.id}`;
  if (p.myMembership.role !== 'pl' || taskCount >= 10) return null;
  const items: { done: boolean; label: string; to: string }[] = [
    { done: detail.members.length > 1, label: 'Mitglieder hinzufügen oder einladen', to: `${base}/einstellungen#mitglieder` },
    { done: detail.subprojects.length > 0, label: 'Teilprojekte anlegen', to: `${base}/einstellungen#planung` },
    { done: detail.milestones.length > 0, label: 'Meilensteine setzen', to: `${base}/einstellungen#planung` },
    { done: taskCount > 0, label: 'Erste Arbeitspakete aufs Board', to: `${base}/board` },
    { done: Boolean(p.mailAddress), label: 'Projektkonto anbinden (Mail, Nachfragen, PDF-Versand)', to: `${base}/einstellungen#mail` },
    { done: Boolean(p.escalation?.enabled && (p.escalation.contactUserId || p.escalation.contactEmail)), label: 'Eskalationskontakt festlegen', to: `${base}/einstellungen#eskalation` }
  ];
  const open = items.filter((i) => !i.done);
  if (open.length === 0) return null;
  return (
    <div className="card mb setup">
      <h2>Projekt einrichten <span className="muted small" style={{ fontWeight: 400 }}>{items.length - open.length} von {items.length} erledigt</span></h2>
      <ul className="setup-list">{items.map((i) => <li key={i.label} className={i.done ? 'done' : ''}>{i.done ? '✓' : '○'} {i.done ? <span>{i.label}</span> : <Link to={i.to}>{i.label}</Link>}</li>)}</ul>
    </div>
  );
}

export function OverviewView() {
  const { detail, openTask, tasks } = useProject();
  const { data: o, error } = useData<Overview>(`/projects/${detail.project.id}/overview`);
  const base = `/projekte/${detail.project.id}`;
  if (error) return <div className="content"><div className="error">{error}</div></div>;
  if (!o) return <div className="content muted">Lade …</div>;
  const total = o.counts.open + o.counts.done;
  const pct = total ? Math.round((o.counts.done / total) * 100) : 0;
  return (
    <div className="content">
      {detail.project.description && <p className="muted mb">{detail.project.description}</p>}
      <SetupChecklist taskCount={tasks.length} />
      <div className="kpis mb">
        <div className="kpi"><div className="v">{o.counts.open}</div><div className="l">offen</div></div>
        <div className={`kpi ${o.counts.overdue ? 'bad' : 'ok'}`}><div className="v">{o.counts.overdue}</div><div className="l">überfällig</div></div>
        <div className={`kpi ${o.counts.due_week ? 'warn' : ''}`}><div className="v">{o.counts.due_week}</div><div className="l">fällig in 7 Tagen</div></div>
        <div className={`kpi ${o.conflicts.length ? 'warn' : ''}`}><div className="v">{o.conflicts.length}</div><div className="l">Terminkonflikte</div></div>
        <div className={`kpi ${o.pendingDrafts ? 'warn' : ''}`}><div className="v">{o.pendingDrafts}</div><div className="l">Freigaben offen</div></div>
        <div className={`kpi ${o.escalations.some((e) => e.level >= 2 || e.blocked) ? 'bad' : o.escalations.length ? 'warn' : 'ok'}`}><div className="v">{o.escalations.length}</div><div className="l">Warnungen / eskaliert</div></div>
        <div className="kpi ok"><div className="v">{pct}%</div><div className="l">erledigt ({o.counts.done}/{total})</div></div>
        {o.time.enabled && <div className={`kpi ${o.time.budgetHours && o.time.loggedMinutes > o.time.budgetHours * 60 ? 'bad' : ''}`}><div className="v">{Math.round(o.time.loggedMinutes / 60)} h</div><div className="l">gebucht{o.time.budgetHours ? ` von ${o.time.budgetHours} h Budget` : ''}</div></div>}
      </div>
      {o.escalations.length > 0 && (
        <div className="card mb warn">
          <h2>Warnungen und Eskalationen <span className="muted small" style={{ fontWeight: 400 }}>Regelwerk: Verzug, Stillstand, Blockaden entlang der Kette Zuständig → Teilprojekt → PL → Eskalationskontakt</span></h2>
          <table className="table"><thead><tr><th>Arbeitspaket</th><th>Grund</th><th>Stufe</th><th>Kette</th></tr></thead><tbody>
            {o.escalations.map((e) => (
              <tr key={e.taskId} className="clickable" onClick={() => openTask(e.taskId)}>
                <td>{e.title}<div className="muted small">{e.responsible}</div></td>
                <td className="small">{e.reason}</td>
                <td className="nowrap">{e.blocked && <span className="badge blocked">Blockiert</span>} {e.level > 0 ? <span className={`badge esc${e.level}`}>Stufe {e.level}</span> : <span className="badge warn">Warnung</span>}{e.targetLevel > e.level && <span className="muted small"> → {e.targetLevel} beim nächsten Lauf</span>}</td>
                <td><div className="chain">{e.chain.map((c, i) => <span key={i} style={{ display: 'contents' }}>{i > 0 && <span className="arrow">→</span>}<span className={`step ${i <= e.level && i > 0 ? 'on' : ''}`}>{c}</span></span>)}</div></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      <div className="grid cols-2">
        <div className="stack">
          <div className="card">
            <h2>Fortschritt je Teilprojekt</h2>
            {o.perSubproject.map((s) => (
              <div key={s.id} className="mb">
                <div className="row between small"><span>{s.name}</span><span className="muted">{s.done}/{s.total}{s.overdue ? <span style={{ color: 'var(--danger)' }}> · {s.overdue} überfällig</span> : ''}</span></div>
                <div className="bar"><div className="done" style={{ width: `${s.total ? (s.done / s.total) * 100 : 0}%` }} /><div className="over" style={{ width: `${s.total ? (s.overdue / s.total) * 100 : 0}%` }} /></div>
              </div>
            ))}
            {o.counts.no_due > 0 && <p className="muted small">{o.counts.no_due} offene Arbeitspakete ohne Deadline.</p>}
          </div>
          <div className="card">
            <h2>Überfällig</h2>
            {o.overdue.length === 0 ? <p className="muted small">Nichts überfällig.</p> : (
              <table className="table"><tbody>{o.overdue.map((t) => <tr key={t.id} className="clickable" onClick={() => openTask(t.id)}><td>{t.title}</td><td className="nowrap" style={{ color: 'var(--danger)' }}>{fmtDate(t.dueDate)}</td><td className="muted small">{t.responsible}</td></tr>)}</tbody></table>
            )}
          </div>
          <div className="card">
            <h2>Terminkonflikte</h2>
            {o.conflicts.length === 0 ? <p className="muted small">Keine Konflikte.</p> : o.conflicts.map((c) => <div key={c.id} className="small mb"><a href="#" onClick={(e) => { e.preventDefault(); openTask(c.id); }}>{c.title}</a><div className="muted">{c.conflicts.join(' · ')}</div></div>)}
            <Link to={`${base}/plan`} className="small">Zum Plan</Link>
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <h2>Nächste Meilensteine</h2>
            {o.milestones.length === 0 ? <p className="muted small">Keine anstehenden Meilensteine.</p> : <ul>{o.milestones.map((m) => <li key={m.id}><strong>{fmtDate(m.date)}</strong> {m.name} <span className="muted small">{detail.subprojects.find((s) => s.id === m.subprojectId)?.name}</span></li>)}</ul>}
          </div>
          <div className="card">
            <h2>Auslastung (offene Arbeitspakete je Person)</h2>
            <table className="table"><tbody>{o.workload.map((w) => <tr key={w.userId}><td>{w.name}</td><td className="nowrap">{w.open} offen{w.overdue ? <span style={{ color: 'var(--danger)' }}> · {w.overdue} überfällig</span> : ''}</td></tr>)}</tbody></table>
          </div>
          <div className="card">
            <h2>Wartet auf dich</h2>
            <ul className="small">
              {o.pendingDrafts > 0 && <li><Link to={`${base}/mail/freigaben`}>{o.pendingDrafts} Mail-Entwürfe zur Freigabe</Link></li>}
              {o.pagesInReview.map((p) => <li key={p.id}><Link to={`${base}/doku/${p.id}`}>Seite „{p.title}“ in Prüfung</Link> <span className="muted">{fmtDateTime(p.updated_at)}</span></li>)}
              {o.pendingDrafts === 0 && o.pagesInReview.length === 0 && <li className="muted">Nichts offen.</li>}
            </ul>
          </div>
          <div className="card">
            <h2>Letzte Aktivität</h2>
            <table className="table"><tbody>{o.activity.map((a, i) => <tr key={i}><td className="small nowrap muted">{fmtDateTime(a.createdAt)}</td><td className="small">{a.userName ?? 'Worker'}</td><td className="small">{ACTION_LABEL[a.action] ?? a.action}{a.details?.title ? `: ${a.details.title}` : a.details?.subject ? `: ${a.details.subject}` : ''}</td></tr>)}</tbody></table>
            <Link to={`${base}/audit`} className="small">Audit-Log</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

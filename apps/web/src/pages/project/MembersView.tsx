import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../../lib/api';
import { Modal, roleLabel, useAsync } from '../../components/ui';
import { useProject, type MemberRow } from '../ProjectPage';
import { useData } from '../../lib/useData';
import type { DocPage, DocTemplate, ReportingPolicy } from '@projekttool/shared';

export function MembersView() {
  const { detail, users, reload, tasks, reloadTasks } = useProject();
  const me = detail.project.myMembership;
  const [edit, setEdit] = useState<MemberRow | null>(null);
  const [invite, setInvite] = useState(false);
  const [columns, setColumns] = useState(false);
  const { error, run } = useAsync();
  const nav = useNavigate();
  const isPl = me.role === 'pl';
  return (
    <div className="content">
      <div className="card mb">
        <h2>Allgemein</h2>
        <GeneralForm />
      </div>
      <div className="grid cols-2">
        <div className="card">
          <div className="row between mb"><h2 style={{ margin: 0 }}>Mitglieder</h2>{isPl && <button className="btn primary sm" onClick={() => setInvite(true)}>Einladen</button>}</div>
          {error && <div className="error mb">{error}</div>}
          <table className="table"><thead><tr><th>Name</th><th>Projektrolle</th><th>Einzelrechte</th><th /></tr></thead><tbody>
            {detail.members.map((m) => (
              <tr key={m.userId}>
                <td>{m.name}<div className="muted small">{m.email}</div></td>
                <td><span className={`badge ${m.role}`}>{roleLabel[m.role]}{m.role === 'pl' && (m.isDeputy ? ' (Stellvertretung)' : ' (verantwortlich)')}</span></td>
                <td className="small muted">{m.role === 'pl' ? 'alle' : [m.canEditPlan && 'Projektplan ändern', m.canApprove && 'KI-Vorschläge freigeben', m.canFinalize && 'Final setzen / Versand', m.canUseAi && 'KI nutzen'].filter(Boolean).join(', ') || '–'}</td>
                <td className="nowrap">{isPl && <><button className="btn sm link" onClick={() => setEdit(m)}>Rolle</button>{!(m.role === 'pl' && !m.isDeputy) && <button className="btn sm link" onClick={() => { if (confirm(`${m.name} entfernen? Zugriff endet sofort, Historie bleibt.`)) void run(async () => { await api.del(`/projects/${detail.project.id}/members/${m.userId}`); await reload(); }); }}>Entfernen</button>}</>}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <div className="stack">
          <div className="card">
            <h2>Projekt</h2>
            <dl className="kv">
              <dt>Kürzel</dt><dd>{detail.project.key}</dd>
              <dt>Projekt-Mailadresse</dt><dd>{detail.project.mailAddress ?? <span className="muted">kein Projektkonto angebunden{isPl && <> · <Link to="/einstellungen/mail-konten">Meine Mail-Konten</Link></>}</span>}{detail.project.mailAddress && <span className="muted small"> (aus dem Projektkonto)</span>}</dd>
              <dt>Status</dt><dd>{detail.project.status === 'active' ? 'aktiv' : 'archiviert'}</dd>
              <dt>Externe Kontakte</dt><dd><Contacts /></dd>
              <dt>Zeiterfassung</dt><dd>{isPl ? <label className="check"><input type="checkbox" checked={detail.project.timeTrackingEnabled} onChange={(e) => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { timeTrackingEnabled: e.target.checked }); await reload(); })} /> aktiv (optionales Modul)</label> : detail.project.timeTrackingEnabled ? 'aktiv' : 'aus'}</dd>
              {(detail.project.timeTrackingEnabled || detail.project.budgetHours) && <><dt>Budget (Stunden)</dt><dd>{isPl ? <BudgetInput /> : detail.project.budgetHours ?? '–'}</dd></>}
            </dl>
            {isPl && <div className="row mt">
              <button className="btn sm" onClick={() => setColumns(true)}>Board-Spalten</button>
              {detail.project.status === 'active' && <button className="btn sm danger" onClick={() => { if (confirm('Projekt archivieren? Nur lesend, Mail-Ansichten werden getrennt, Automatik stoppt.')) void run(async () => { await api.post(`/projects/${detail.project.id}/archive`); await reload(); nav('/projekte'); }); }}>Archivieren</button>}
            </div>}
          </div>
          <div className="card">
            <h2>Eskalationsregeln</h2>
            <EscalationForm />
          </div>
          <div className="card">
            <h2>Reporting</h2>
            <ReportingForm />
          </div>
          <div className="card">
            <h2>Meilensteine</h2>
            <ul>{detail.milestones.map((m) => <li key={m.id}>{fmtDate(m.date)} – {m.name}</li>)}</ul>
          </div>
        </div>
      </div>
      {edit && <RoleForm member={edit} onClose={() => setEdit(null)} />}
      {invite && <RoleForm onClose={() => setInvite(false)} />}
      {columns && <ColumnsForm onClose={() => setColumns(false)} />}
    </div>
  );

  function RoleForm({ member, onClose }: { member?: MemberRow; onClose: () => void }) {
    const candidates = users.filter((u) => !detail.members.some((m) => m.userId === u.id));
    const [f, setF] = useState({ userId: member?.userId ?? candidates[0]?.id ?? '', role: member?.role ?? 'member', isDeputy: member?.isDeputy ?? true, canEditPlan: member?.canEditPlan ?? false, canApprove: member?.canApprove ?? false, canFinalize: member?.canFinalize ?? false, canUseAi: member?.canUseAi ?? true });
    const { busy, error, run } = useAsync();
    return (
      <Modal title={member ? `Rolle: ${member.name}` : 'Mitglied hinzufügen'} onClose={onClose}>
        <div className="form">
          {!member && <label className="field"><span>Benutzer des Mandanten</span><select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{candidates.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</select></label>}
          <label className="field"><span>Projektrolle</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as any })}><option value="pl">PL</option><option value="member">Mitglied</option><option value="reader">Leser</option></select></label>
          {f.role === 'pl' && <label className="check"><input type="checkbox" checked={f.isDeputy} onChange={(e) => setF({ ...f, isDeputy: e.target.checked })} /> Stellvertretung (zweiter PL). Ohne Haken wird diese Person verantwortlicher PL, der bisherige wird Stellvertretung.</label>}
          {f.role === 'member' && <>
            <strong className="small">Zusätzliche Rechte</strong>
            <label className="check"><input type="checkbox" checked={f.canEditPlan} onChange={(e) => setF({ ...f, canEditPlan: e.target.checked })} /> Projektplan, Meilensteine ändern</label>
            <label className="check"><input type="checkbox" checked={f.canApprove} onChange={(e) => setF({ ...f, canApprove: e.target.checked })} /> KI-Vorschläge freigeben</label>
            <label className="check"><input type="checkbox" checked={f.canFinalize} onChange={(e) => setF({ ...f, canFinalize: e.target.checked })} /> Dokument final setzen, Versand auslösen</label>
            <label className="check"><input type="checkbox" checked={f.canUseAi} onChange={(e) => setF({ ...f, canUseAi: e.target.checked })} /> KI nutzen</label>
          </>}
          {f.role === 'reader' && <label className="check"><input type="checkbox" checked={f.canUseAi} onChange={(e) => setF({ ...f, canUseAi: e.target.checked })} /> KI nutzen (nur Fragen)</label>}
          {error && <div className="error">{error}</div>}
          <div><button className="btn primary" disabled={busy || !f.userId} onClick={() => void run(async () => {
            const body: Record<string, unknown> = { ...f };
            const primary = detail.members.find((m) => m.role === 'pl' && !m.isDeputy);
            if (f.role === 'pl' && !f.isDeputy && primary && primary.userId !== f.userId) {
              const direct = tasks.filter((x) => !x.done && x.responsibleUserId === primary.userId).length + detail.subprojects.filter((s) => s.responsibleUserId === primary.userId).length;
              if (direct > 0) body.transferTasks = confirm(`${direct} Aufgabe(n)/Teilprojekt(e) sind ${primary.name} direkt zugewiesen. Auch an die neue Projektleitung übertragen?\n\nOK = übertragen, Abbrechen = nur die geerbten Zuständigkeiten wechseln.`);
            }
            await api.put(`/projects/${detail.project.id}/members/${f.userId}`, body); await reload(); await reloadTasks(); onClose(); })}>Speichern</button></div>
        </div>
      </Modal>
    );
  }

  function ColumnsForm({ onClose }: { onClose: () => void }) {
    const { reloadTasks } = useProject();
    const [cols, setCols] = useState(detail.columns.map((c) => ({ id: c.id as string | undefined, name: c.name, isDone: c.isDone, wipLimit: c.wipLimit })));
    const { busy, error, run } = useAsync();
    return (
      <Modal title="Board-Spalten" onClose={onClose}>
        <div className="stack">
          {cols.map((c, i) => <div key={i} className="row"><input type="text" value={c.name} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} style={{ flex: 1 }} /><label className="check small"><input type="checkbox" checked={c.isDone} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, isDone: e.target.checked } : x)))} /> erledigt</label><label className="small nowrap">WIP <input type="number" min={0} value={c.wipLimit ?? ''} placeholder="–" onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, wipLimit: e.target.value ? Number(e.target.value) : null } : x)))} style={{ width: 56 }} /></label><button className="btn sm link" onClick={() => setCols(cols.filter((_, j) => j !== i))}>✕</button></div>)}
          <button className="btn sm" onClick={() => setCols([...cols, { id: undefined, name: 'Neue Spalte', isDone: false, wipLimit: null }])}>+ Spalte</button>
          <p className="muted small">WIP-Limit: Spalte färbt sich rot, wenn mehr Aufgaben darin liegen (Kanban-Prinzip: erst fertig machen, dann neu anfangen).</p>
          {error && <div className="error">{error}</div>}
          <div><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.put(`/projects/${detail.project.id}/columns`, { columns: cols }); await reload(); await reloadTasks(); onClose(); })}>Speichern</button></div>
        </div>
      </Modal>
    );
  }
}

function GeneralForm() {
  const { detail, reload } = useProject();
  const p = detail.project;
  const isPl = p.myMembership.role === 'pl';
  const [f, setF] = useState({ name: p.name, description: p.description ?? '', visibility: p.visibility });
  const { busy, error, run } = useAsync();
  const dirty = f.name !== p.name || f.description !== (p.description ?? '') || f.visibility !== p.visibility;
  if (!isPl) {
    return <dl className="kv"><dt>Name</dt><dd>{p.name}</dd><dt>Beschreibung</dt><dd>{p.description || '–'}</dd><dt>Sichtbarkeit</dt><dd>{p.visibility === 'org' ? 'alle Benutzer des Mandanten (lesend)' : 'nur Mitglieder'}</dd></dl>;
  }
  return (
    <div className="form">
      <div className="grid cols-2">
        <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>Sichtbarkeit</span>
          <select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value as 'members' | 'org' })}>
            <option value="members">nur Mitglieder</option>
            <option value="org">alle Benutzer des Mandanten (lesend)</option>
          </select>
        </label>
      </div>
      <label className="field"><span>Beschreibung</span><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <p className="muted small">Sichtbarkeit „alle Benutzer“: Nicht-Mitglieder sehen Übersicht, Board, Plan und Doku lesend. Mail-Ansichten bleiben rechtegebunden, schreiben darf weiterhin nur, wer Mitglied ist.</p>
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary sm" disabled={busy || !dirty || !f.name.trim()} onClick={() => void run(async () => { await api.patch(`/projects/${p.id}`, { name: f.name, description: f.description, visibility: f.visibility }); await reload(); })}>Speichern</button></div>
    </div>
  );
}

function EscalationForm() {
  const { detail, users, reload } = useProject();
  const me = detail.project.myMembership;
  const p = detail.project.escalation!;
  const [f, setF] = useState({ enabled: p.enabled, d1: p.stageDays[0], d2: p.stageDays[1], d3: p.stageDays[2], staleDays: p.staleDays, contactUserId: p.contactUserId ?? '', contactEmail: p.contactEmail ?? '', externalMode: p.externalMode });
  const { busy, error, run } = useAsync();
  const members = users.filter((u) => u.active);
  if (me.role !== 'pl') {
    return <p className="small muted">Stufe 1 nach {p.stageDays[0]} Tagen Verzug oder {p.staleDays} Tagen Stillstand (Teilprojekt-Verantwortung), Stufe 2 nach {p.stageDays[1]} Tagen (PL), Stufe 3 nach {p.stageDays[2]} Tagen ({members.find((u) => u.id === p.contactUserId)?.name ?? p.contactEmail ?? 'kein Kontakt'}). Hohe Kritikalität halbiert die Fristen.</p>;
  }
  return (
    <div className="form">
      <p className="muted small">Verzug, Stillstand und Blockaden eskalieren entlang Zuständig → Teilprojekt-Verantwortung → PL → Eskalationskontakt. Hohe Kritikalität halbiert die Fristen.</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Eskalation aktiv</label>
      <div className="row small">
        <span>Stufe 1 nach</span><input type="number" min={0} value={f.d1} onChange={(e) => setF({ ...f, d1: Number(e.target.value) })} style={{ width: 60 }} />
        <span>Stufe 2 nach</span><input type="number" min={0} value={f.d2} onChange={(e) => setF({ ...f, d2: Number(e.target.value) })} style={{ width: 60 }} />
        <span>Stufe 3 nach</span><input type="number" min={0} value={f.d3} onChange={(e) => setF({ ...f, d3: Number(e.target.value) })} style={{ width: 60 }} /><span>Tagen Verzug</span>
      </div>
      <div className="row small"><span>„Hängt“ ab</span><input type="number" min={1} value={f.staleDays} onChange={(e) => setF({ ...f, staleDays: Number(e.target.value) })} style={{ width: 60 }} /><span>Tagen ohne Aktivität in einer aktiven Spalte</span></div>
      <label className="field"><span>Eskalationskontakt intern (z. B. Vorgesetzte/r, Auftraggeber im Haus)</span><select value={f.contactUserId} onChange={(e) => setF({ ...f, contactUserId: e.target.value })}><option value="">– keiner –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label className="field"><span>Eskalationskontakt extern (Mail über Projektkonto)</span><input type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} placeholder="gf@kunde.de" /></label>
      {f.contactEmail && <label className="field"><span>Externe Eskalationsmail</span><select value={f.externalMode} onChange={(e) => setF({ ...f, externalMode: e.target.value as any })}><option value="proposal">als Entwurf zur Freigabe durch PL</option><option value="direct">direkt senden</option></select></label>}
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { escalation: { enabled: f.enabled, stageDays: [f.d1, f.d2, f.d3], staleDays: f.staleDays, contactUserId: f.contactUserId || null, contactEmail: f.contactEmail || null, externalMode: f.externalMode } }); await reload(); })}>Speichern</button></div>
    </div>
  );
}

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

function ReportingForm() {
  const { detail, reload } = useProject();
  const me = detail.project.myMembership;
  const p = detail.project.reporting!;
  const [f, setF] = useState({ ...p, recipientsText: p.recipients.join(', ') });
  const templates = useData<{ templates: DocTemplate[] }>('/docs/templates');
  const docs = useData<{ pages: DocPage[] }>(`/projects/${detail.project.id}/docs`);
  const { busy, error, run } = useAsync();
  const [last, setLast] = useState<string | null>(null);
  const tops = (docs.data?.pages ?? []).filter((x) => !x.parentPageId).sort((a, b) => a.title.localeCompare(b.title));
  const rhythm = p.interval === 'monthly' ? `monatlich am ${p.dayOfMonth}.` : `${p.interval === 'weekly' ? 'wöchentlich' : 'alle zwei Wochen'} am ${WEEKDAYS[p.weekday - 1]}`;
  const tplName = templates.data?.templates.find((t) => t.key === p.templateKey)?.name ?? p.templateKey;
  if (me.role !== 'pl') {
    return <p className="small muted">{p.enabled ? `„${tplName}“ ${rhythm} an ${p.recipients.join(', ') || 'niemanden'} (${p.mode === 'direct' ? 'direkt als PDF' : 'nach Prüfung durch PL'}).` : 'Kein automatisches Reporting.'}{p.lastRunOn && <> Zuletzt: {fmtDate(p.lastRunOn)}{p.lastPageId && <> · <Link to={`/projekte/${detail.project.id}/doku/${p.lastPageId}`}>Bericht</Link></>}.</>}</p>;
  }
  const save = (): Partial<ReportingPolicy> => ({ enabled: f.enabled, templateKey: f.templateKey, interval: f.interval, weekday: Number(f.weekday), dayOfMonth: Number(f.dayOfMonth), recipients: f.recipientsText.split(/[,;\s]+/).filter(Boolean), mode: f.mode, parentPageId: f.parentPageId || null });
  return (
    <div className="form">
      <p className="muted small">Im Rhythmus entsteht eine Seite aus der Vorlage mit Kennzahlen (Fortschritt, Verzug, Blockaden, Eskalationen, Meilensteine) und geht als PDF über das Projektkonto an den Empfängerkreis.</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Reporting aktiv</label>
      <div className="grid cols-2">
        <label className="field"><span>Vorlage</span><select value={f.templateKey} onChange={(e) => setF({ ...f, templateKey: e.target.value })}>{(templates.data?.templates ?? []).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
        <label className="field"><span>Ablage unter Oberseite</span><select value={f.parentPageId ?? ''} onChange={(e) => setF({ ...f, parentPageId: e.target.value })}><option value="">– Ordner „Berichte“ –</option>{tops.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
        <label className="field"><span>Rhythmus</span><select value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value as ReportingPolicy['interval'] })}><option value="weekly">wöchentlich</option><option value="biweekly">alle zwei Wochen</option><option value="monthly">monatlich</option></select></label>
        {f.interval === 'monthly'
          ? <label className="field"><span>Tag im Monat</span><input type="number" min={1} max={28} value={f.dayOfMonth} onChange={(e) => setF({ ...f, dayOfMonth: Number(e.target.value) })} /></label>
          : <label className="field"><span>Wochentag</span><select value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>{WEEKDAYS.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}</select></label>}
      </div>
      <label className="field"><span>Empfängerkreis (Mail-Adressen, durch Komma getrennt)</span><input type="text" value={f.recipientsText} onChange={(e) => setF({ ...f, recipientsText: e.target.value })} placeholder="gf@kunde.de, lenkungskreis@firma.de" /></label>
      <label className="field"><span>Versand</span><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as ReportingPolicy['mode'] })}><option value="proposal">als Entwurf, PL prüft und versendet</option><option value="direct">direkt final setzen und als PDF senden</option></select></label>
      {!detail.project.mailAddress && <p className="small" style={{ color: 'var(--warn)' }}>Kein Projektkonto angebunden, Versand ist erst danach möglich.</p>}
      {error && <div className="error">{error}</div>}
      {last && <div className="muted small">{last}</div>}
      <div className="row">
        <button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { reporting: save() }); await reload(); setLast('Gespeichert.'); })}>Speichern</button>
        <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { reporting: save() }); const r = await api.post<{ result: { pageId: string; title: string; sent: boolean; to: string[]; error?: string } }>(`/projects/${detail.project.id}/reporting/run`); await reload(); setLast(r.result.sent ? `„${r.result.title}“ versendet an ${r.result.to.join(', ')}.` : `„${r.result.title}“ angelegt${r.result.error ? `, nicht versendet: ${r.result.error}` : ' (Entwurf zur Prüfung)'}.`); })}>Jetzt erzeugen</button>
        {p.lastRunOn && <span className="muted small">Zuletzt {fmtDate(p.lastRunOn)}{p.lastPageId && <> · <Link to={`/projekte/${detail.project.id}/doku/${p.lastPageId}`}>Bericht öffnen</Link></>}</span>}
      </div>
    </div>
  );
}

function BudgetInput() {
  const { detail, reload } = useProject();
  const [v, setV] = useState(detail.project.budgetHours?.toString() ?? '');
  return <span className="row"><input type="number" min={0} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 100 }} /><button className="btn sm" onClick={() => void api.patch(`/projects/${detail.project.id}`, { budgetHours: v ? Number(v) : null }).then(reload)}>Speichern</button></span>;
}

function Contacts() {
  const { detail } = useProject();
  const [list, setList] = useState<{ email: string; name: string | null }[] | null>(null);
  if (!list) { void api.get<{ contacts: any[] }>(`/projects/${detail.project.id}/contacts`).then((r) => setList(r.contacts)); return <span className="muted">…</span>; }
  return <span className="small">{list.length ? list.map((c) => c.name ? `${c.name} <${c.email}>` : c.email).join(', ') : '–'}</span>;
}

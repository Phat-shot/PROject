import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentUser, AiProfile } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync, useDialog } from '../../components/ui';
import { SettingsCard } from '../../components/settings/Settings';

interface Line { id: string; number: string; label: string; projectId: string | null; agentUserId: string | null; aiProfileId: string | null; greeting: string | null; active: boolean }
interface Config { enabled: boolean; hasSecret: boolean; flowUrl: string; ioUrl: string | null; lines: Line[] }
interface Call { id: string; provider: 'flow' | 'sipgate_io'; direction: 'in' | 'out'; from: string | null; to: string | null; lineLabel: string | null; callerName: string | null; agentName: string | null; projectId: string | null; projectKey: string | null; taskId: string | null; taskNumber: number | null; status: string; summary: string | null; error: string | null; startedAt: string; endedAt: string | null; transcript: { role: 'caller' | 'agent'; text: string }[] }

const fmtNumber = (n: string | null) => (n ? `+${n}` : 'unterdrückt');

/** Verwaltung › Telefonie: sipgate Flow (KI am Telefon) und sipgate.io (Anruf-Log), Rufnummern mit Projekt, Agent und schnellem KI-Profil, Anrufe. */
export function TelephonySection() {
  const cfg = useData<Config>('/telephony');
  const agents = useData<{ agents: AgentUser[] }>('/agents');
  const profiles = useData<{ profiles: AiProfile[] }>('/ai/profiles');
  const calls = useData<{ calls: Call[] }>('/telephony/calls');
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const [fresh, setFresh] = useState<{ secret: string; ioUrl: string } | null>(null);
  const [edit, setEdit] = useState<Partial<Line> | null>(null);
  const [open, setOpen] = useState<Call | null>(null);
  const c = cfg.data;
  const agentList = (agents.data?.agents ?? []).filter((a) => a.active);
  const profileList = (profiles.data?.profiles ?? []).filter((p) => p.active);
  return <>
    <SettingsCard title="Telefonie (sipgate)" hint={<>Ein KI-Agent nimmt Anrufe an: Er nimmt Anliegen auf (Arbeitspaket im Projekt der Rufnummer, Meldung an die PL), gibt internen Anrufern den Stand und schlägt Termine vor (vorläufig, eine Person bestätigt). Interne Anrufer erkennt er an der Telefonnummer unter Meine Einstellungen.</>}>
      {error && <div className="error mb">{error}</div>}
      {!c ? <p className="muted small">Lade …</p> : <>
        <label className="check"><input type="checkbox" checked={c.enabled} disabled={busy} onChange={(e) => void run(async () => { await api.put('/telephony', { enabled: e.target.checked }); await cfg.reload(); })} /> Telefonie aktiv</label>
        <dl className="kv mt">
          <dt>sipgate Flow</dt><dd><div className="small">Webhook-URL: <code>{c.flowUrl}</code></div><div className="muted small">In sipgate Flow als Webhook eintragen, mit dem Schlüssel als Header <code>x-api-token</code> (oder als HMAC-Schlüssel für <code>x-sipgate-signature</code>).</div></dd>
          <dt>sipgate.io</dt><dd>{c.ioUrl ? <div className="small">Push-URL für ein- und ausgehende Anrufe: <code>{c.ioUrl}</code></div> : <span className="muted small">noch kein Schlüssel</span>}<div className="muted small">Optional: Anruf-Log auch ohne KI (sipgate-Konsole › Webhooks › URLs).</div></dd>
          <dt>Schlüssel</dt><dd>{c.hasSecret ? <span className="badge ok">vorhanden</span> : <span className="badge warn">fehlt</span>} <button className="btn sm" disabled={busy} onClick={() => void dialog.confirm({ title: c.hasSecret ? 'Neuen Schlüssel erzeugen' : 'Schlüssel erzeugen', text: c.hasSecret ? 'Der alte Schlüssel und die alte sipgate.io-URL gelten danach nicht mehr; beides in sipgate neu eintragen.' : 'Der Schlüssel wird nur jetzt angezeigt.', confirmLabel: 'Erzeugen' }).then((ok) => { if (ok) void run(async () => { const r = await api.post<{ secret: string; ioUrl: string }>('/telephony/secret'); setFresh(r); await cfg.reload(); }); })}>{c.hasSecret ? 'Neu erzeugen' : 'Erzeugen'}</button></dd>
        </dl>
        {fresh && <div className="notice mt small">Schlüssel (nur jetzt sichtbar): <code>{fresh.secret}</code><br />sipgate.io-URL: <code>{fresh.ioUrl}</code></div>}
      </>}
    </SettingsCard>

    <SettingsCard title="Rufnummern" action={<button className="btn sm primary" onClick={() => setEdit({ active: true })}>+ Rufnummer</button>} hint="Je Rufnummer ein Projekt (Anliegen landen dort) oder keins (Meldung an die Org-Admins), ein Agent und ein schnelles KI-Profil: am Telefon braucht die Antwort 1–3 Sekunden, lokale Modelle mit Denkmodus sind dafür meist zu langsam.">
      {c && c.lines.length === 0 && <div className="empty">Noch keine Rufnummer.</div>}
      {c && c.lines.length > 0 && <table className="table"><thead><tr><th>Nummer</th><th>Bezeichnung</th><th>Agent</th><th>Projekt</th><th>KI-Profil</th><th /></tr></thead><tbody>
        {c.lines.map((l) => { const a = agentList.find((x) => x.id === l.agentUserId); return <tr key={l.id} className={l.active ? '' : 'muted'}>
          <td className="nowrap">{fmtNumber(l.number)}</td><td>{l.label || '–'}</td><td>{a?.name ?? <span className="badge warn">kein Agent</span>}</td>
          <td>{l.projectId ? a?.projects.find((p) => p.id === l.projectId)?.key ?? 'Projekt' : <span className="muted">ohne</span>}</td>
          <td>{profileList.find((p) => p.id === l.aiProfileId)?.name ?? <span className="muted">wie Agent</span>}</td>
          <td className="nowrap"><button className="btn sm link" onClick={() => setEdit(l)}>Bearbeiten</button><button className="btn sm link" onClick={() => void dialog.confirm({ title: 'Rufnummer entfernen', text: `${fmtNumber(l.number)} entfernen? Bisherige Anrufe bleiben im Log.`, confirmLabel: 'Entfernen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/telephony/lines/${l.id}`); await cfg.reload(); }); })}>✕</button></td>
        </tr>; })}
      </tbody></table>}
    </SettingsCard>

    <SettingsCard title="Anrufe" action={<button className="btn sm" onClick={() => void calls.reload()}>Aktualisieren</button>}>
      {(calls.data?.calls.length ?? 0) === 0 ? <div className="empty">Noch keine Anrufe.</div> : <table className="table"><thead><tr><th>Zeit</th><th>Von</th><th>An</th><th>Ergebnis</th><th /></tr></thead><tbody>
        {calls.data!.calls.map((x) => <tr key={x.id}>
          <td className="nowrap small">{fmtDateTime(x.startedAt)}{x.status === 'active' && <span className="badge ok" style={{ marginLeft: 4 }}>läuft</span>}</td>
          <td className="small">{x.callerName ?? fmtNumber(x.from)}{x.direction === 'out' && <span className="muted"> (ausgehend)</span>}</td>
          <td className="small">{x.lineLabel ?? fmtNumber(x.to)}{x.agentName && <div className="muted">KI: {x.agentName}</div>}</td>
          <td className="small">{x.taskNumber && x.projectId ? <Link to={`/projekte/${x.projectId}/board?task=${x.taskId}`}>{x.projectKey}-{x.taskNumber}</Link> : null} {x.summary ?? (x.provider === 'sipgate_io' ? 'ohne KI' : '')}{x.error && <div className="error small">{x.error}</div>}</td>
          <td>{x.transcript.length > 0 && <button className="btn sm link" onClick={() => setOpen(x)}>Verlauf</button>}</td>
        </tr>)}
      </tbody></table>}
    </SettingsCard>

    {edit && <LineForm line={edit} agents={agentList} profiles={profileList} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await cfg.reload(); }} />}
    {open && <Modal title={`Anruf ${open.callerName ?? fmtNumber(open.from)} · ${fmtDateTime(open.startedAt)}`} onClose={() => setOpen(null)}>
      <div className="stack small">{open.transcript.map((t, i) => <div key={i}><strong>{t.role === 'caller' ? 'Anrufer' : open.agentName ?? 'KI'}:</strong> {t.text}</div>)}</div>
    </Modal>}
  </>;
}

function LineForm({ line, agents, profiles, onClose, onSaved }: { line: Partial<Line>; agents: AgentUser[]; profiles: AiProfile[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ number: line.number ? `+${line.number}` : '', label: line.label ?? '', agentUserId: line.agentUserId ?? '', projectId: line.projectId ?? '', aiProfileId: line.aiProfileId ?? '', greeting: line.greeting ?? '', active: line.active !== false });
  const { busy, error, run } = useAsync();
  const agent = agents.find((a) => a.id === f.agentUserId);
  const save = () => run(async () => { const body = { ...f, projectId: f.projectId || null, agentUserId: f.agentUserId || null, aiProfileId: f.aiProfileId || null }; if (line.id) await api.put(`/telephony/lines/${line.id}`, body); else await api.post('/telephony/lines', body); await onSaved(); });
  return (
    <Modal title={line.id ? 'Rufnummer bearbeiten' : 'Rufnummer einrichten'} onClose={onClose}>
      {error && <div className="error mb">{error}</div>}
      <div className="form">
        <label className="field"><span>Rufnummer (wie bei sipgate)</span><input type="tel" value={f.number} placeholder="+49 211 1234567" onChange={(e) => setF({ ...f, number: e.target.value })} /></label>
        <label className="field"><span>Bezeichnung</span><input type="text" value={f.label} placeholder="z. B. Hotline Website" onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
        <label className="field"><span>KI-Agent</span><select value={f.agentUserId} onChange={(e) => setF({ ...f, agentUserId: e.target.value, projectId: '' })}><option value="">– wählen –</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="field"><span>Projekt (Anliegen landen dort als Arbeitspaket)</span><select value={f.projectId} disabled={!agent} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">– ohne festes Projekt –</option>{agent?.projects.map((p) => <option key={p.id} value={p.id}>{p.key} {p.name}</option>)}</select>{agent && agent.projects.length === 0 && <span className="muted small">{agent.name} ist noch in keinem Projekt Mitglied.</span>}</label>
        <label className="field"><span>KI-Profil am Telefon (schnelles Modell)</span><select value={f.aiProfileId} onChange={(e) => setF({ ...f, aiProfileId: e.target.value })}><option value="">wie der Agent</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.model})</option>)}</select></label>
        <label className="field"><span>Begrüßung (leer = Standard mit Hinweis auf KI)</span><textarea rows={2} value={f.greeting} onChange={(e) => setF({ ...f, greeting: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>
      </div>
      <div className="row mt"><button className="btn primary" disabled={busy || !f.number.trim() || !f.agentUserId} onClick={() => void save()}>Speichern</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
    </Modal>
  );
}

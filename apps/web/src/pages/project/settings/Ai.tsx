import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../../../lib/api';
import { Modal, roleLabel, useAsync } from '../../../components/ui';
import { AgentPolicyEditor, EffectivePolicyText, modeLabel } from '../../../components/AgentPolicy';
import { AGENT_MODES, AI_FEATURES, type AgentPolicy, type EffectiveAgentPolicy, type AgentUser, type AiFeatureDef } from '@projekttool/shared';
import { useProject } from '../../ProjectPage';
import { useData } from '../../../lib/useData';
import { InheritSelect, ReadOnlyNote, SettingsCard } from '../../../components/settings/Settings';
import { rightsText } from './People';

type ProjectLlms = { available: { id: string; name: string; provider: string; model: string; own: boolean }[]; own: { id: string; name: string; provider: 'local' | 'anthropic'; model: string; baseUrl: string | null; hasKey: boolean; active: boolean; adminBlocked: boolean; thinkingOff: boolean; webSearch?: boolean; tokensIn: number; tokensOut: number; lastUsedAt: string | null }[]; canAddOwn: boolean; addOwnReason?: string | null; ownLlmAllowed?: boolean };

/** Projekt-KI: eines der im Projekt verfügbaren LLMs (vom Org-Admin freigegeben oder eigenes); ohne Auswahl sind die KI-Funktionen aus. */
/**
 * Projektagent (#52): ein KI-Agent als dritte PL-Rolle (stellvertretende Projektleitung). Mit Mail-Modus bearbeitet er neue Mails der
 * Projektkonten selbst oder schlägt vor; der Ordner „KI Bearbeiten“ bleibt für Konten ohne Projektagent und für Agenten mit kleinerer Rolle.
 */
function ProjectAgentSelect({ readOnly = false }: { readOnly?: boolean }) {
  const { detail, reload } = useProject();
  const { busy, error, run } = useAsync();
  const agents = detail.members.filter((m) => m.kind === 'agent');
  const cur = agents.find((a) => a.userId === detail.project.agentUserId);
  const mode = detail.project.agentMail ?? 'off';
  const MODE: Record<string, string> = { off: 'nur Rolle (Mails nur über Ordner „KI Bearbeiten“ oder Agent je Ansicht)', triage: 'schlägt zu neuen Mails der Projektkonten nur vor', process: 'bearbeitet neue Mails der Projektkonten direkt (als stellvertretende PL)' };
  if (readOnly) return <>{cur ? `${cur.name} · ${MODE[mode]}` : <span className="muted">keiner</span>}</>;
  const set = (agentUserId: string | null, agentMail: string) => void run(async () => { await api.put(`/projects/${detail.project.id}/agent`, { agentUserId, agentMail }); await reload(); });
  return <span className="stack" style={{ gap: 4 }}>
    <span className="row">
      <select value={cur?.userId ?? ''} disabled={busy} style={{ width: 'auto' }} onChange={(e) => set(e.target.value || null, mode)}><option value="">keiner</option>{agents.map((a) => <option key={a.userId} value={a.userId}>{a.name}</option>)}</select>
      {cur && <select value={mode} disabled={busy} style={{ width: 'auto' }} title="Mails der Projektkonten" onChange={(e) => set(cur.userId, e.target.value)}>{Object.entries(MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
    </span>
    <span className="muted small">{agents.length === 0 ? 'Zuerst einen KI-Agenten unter Personen › Mitglieder aufnehmen.' : 'Der Projektagent ist stellvertretende Projektleitung; die KI-Freigabe „Projektagent bearbeitet Mails der Projektkonten“ muss es erlauben. Was ihm unklar ist, fragt er nach (Mail-Rückfrage unter Mail).'}</span>
    {error && <span className="error small">{error}</span>}</span>;
}

/**
 * Agenten-Policy des Projekts (Konzept 6): Selbstständigkeit und zu bestätigende Schritte für alle Agenten im Projekt, Grenzen für
 * Agenten und Arbeitspakete, Workflow-Schritte. Vorgabe und Grenzen des Mandanten gelten darüber.
 */
function ProjectAgentPolicy({ readOnly = false }: { readOnly?: boolean }) {
  const { detail, reload } = useProject();
  const d = useData<{ effective: EffectiveAgentPolicy; project: AgentPolicy; org: AgentPolicy; agents: { userId: string; name: string; policy: AgentPolicy | null; effective: EffectiveAgentPolicy }[]; canEdit: boolean }>(`/projects/${detail.project.id}/agent-policy`);
  const [open, setOpen] = useState(false);
  const { error, run } = useAsync();
  if (!d.data) return null;
  const agents = d.data.agents;
  const setAgent = (a: { userId: string }, next: AgentPolicy) => run(async () => { const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)); await api.put(`/projects/${detail.project.id}/members/${a.userId}/agent-policy`, Object.keys(clean).length ? clean : null); await d.reload(); });
  return <span className="stack" style={{ gap: 4 }}>
    <span className="row"><EffectivePolicyText e={d.data.effective} />{!readOnly && <button className="btn sm link" onClick={() => setOpen((o) => !o)}>{open ? 'schließen' : 'ändern'}</button>}</span>
    {open && <AgentPolicyEditor value={d.data.project} limits workflows inheritFrom="Mandant" effective={d.data.effective} onSave={async (v) => { await api.put(`/projects/${detail.project.id}/agent-policy`, v); setOpen(false); await d.reload(); await reload(); }} />}
    {agents.length > 0 && <span className="small stack" style={{ gap: 4 }}>{agents.map((a) => <span key={a.userId} className="row" style={{ gap: 6, flexWrap: 'wrap' }}><span className="muted">{a.name}:</span>
      <InheritSelect ariaLabel={`${a.name} Selbstständigkeit`} value={a.policy?.mode ?? undefined} effective={{ value: a.effective.mode, origin: a.effective.origin.mode }} options={AGENT_MODES} disabled={readOnly} text={(v) => modeLabel(v)} onChange={(mode) => void setAgent(a, { ...(a.policy ?? {}), mode })} />
      <span className="muted">Workflow-Schritte:</span>
      <InheritSelect ariaLabel={`${a.name} Workflow-Schritte`} value={a.policy?.workflows === undefined ? undefined : a.policy.workflows ? 'yes' : 'no'} effective={{ value: a.effective.workflows ? 'yes' : 'no', origin: a.effective.origin.workflows }} options={[{ key: 'yes', label: 'erlaubt' }, { key: 'no', label: 'aus' }] as const} disabled={readOnly} onChange={(w) => void setAgent(a, { ...(a.policy ?? {}), workflows: w === undefined ? undefined : w === 'yes' })} />
    </span>)}</span>}
    <span className="muted small">Grundmenge (Log, Tasks, Doku-Entwürfe, interner Chat, Fragen) ist immer frei; Angehaltenes legt der Agent der PL als Karte vor. Je Arbeitspaket lässt sich die Selbstständigkeit im Arbeitspaket setzen, der Zugriff auf Doku-Ordner am Ordner.</span>
    {detail.project.agentUserId && <ProjectReview readOnly={readOnly} scope={d.data.effective.scope} />}
    {error && <span className="error small">{error}</span>}</span>;
}

/** Projektdurchlauf (Konzept 6.6): Stand des Überblicks, Steckbrief des Projektagenten und der Knopf „Projektdurchlauf jetzt“ (nur mit Reichweite „ganzes Projekt“). */
function ProjectReview({ readOnly, scope }: { readOnly: boolean; scope: 'task' | 'project' }) {
  const { detail } = useProject();
  const d = useData<{ digest: { structure: string; brief: string | null; builtAt: string | null; lastReview: { at: string; status: string; error: string | null } | null; reviewAt: string } | null }>(`/projects/${detail.project.id}/digest`);
  const [msg, setMsg] = useState('');
  const { busy, error, run } = useAsync();
  const dg = d.data?.digest;
  if (!dg) return null;
  return <span className="stack small" style={{ gap: 2 }}>
    <span className="row" style={{ gap: 6 }}><span className="muted">Projektdurchlauf:</span>
      {scope === 'project' ? <>werktags {dg.reviewAt}{dg.lastReview && <span className="muted">· zuletzt {fmtDate(dg.lastReview.at)}{dg.lastReview.status === 'skipped' ? ' (unverändert, kein LLM-Aufruf)' : dg.lastReview.status === 'error' ? ` (Fehler: ${dg.lastReview.error ?? ''})` : ''}</span>}
        {!readOnly && <button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ run: { status: string; error?: string; actions: { type: string }[] } }>(`/projects/${detail.project.id}/agent-review`); setMsg(`${r.run.status === 'skipped' ? 'übersprungen' : `${r.run.actions.length} Aktion${r.run.actions.length === 1 ? '' : 'en'}`}${r.run.error ? ` · ${r.run.error}` : ''}`); await d.reload(); })}>Projektdurchlauf jetzt</button>}</> : <span className="muted">aus (Reichweite „zugewiesene Arbeitspakete“)</span>}
    </span>
    {msg && <span>{msg}</span>}
    {dg.brief && <details><summary className="muted">Steckbrief des Projektagenten</summary><div style={{ whiteSpace: 'pre-wrap' }}>{dg.brief}</div></details>}
    {error && <span className="error">{error}</span>}
  </span>;
}

/**
 * Eigene Rechte im Projekt: Rolle, Einzelrechte und je KI-Funktion erlaubt oder die Begründung (KI-Freigaben, aus
 * /projects/:id/ai/capabilities). Leser sehen nur die Auskunftsfunktionen, Funktionen der PL nur die PL.
 */
export function MyRights() {
  const { detail, ai } = useProject();
  const me = detail.project.myMembership;
  const features = (AI_FEATURES as readonly AiFeatureDef[]).filter((f) => f.who !== 'agent' && !f.later
    && (me.role === 'pl' || (!f.key.startsWith('pl.') && (me.role !== 'reader' || f.key === 'assist.ask' || f.key === 'agent.chat'))));
  return (
    <>
      <p className="small">{roleLabel[me.role]}{me.role === 'pl' && (me.isDeputy ? ' (Stellvertretung)' : ' (verantwortlich)')} · Einzelrechte: {me.role === 'pl' ? 'alle' : rightsText(me)}</p>
      {!ai ? <p className="muted small">KI-Freigaben werden geladen …</p>
        : <table className="table"><thead><tr><th>KI-Funktion</th><th>Für dich</th></tr></thead><tbody>
          {features.map((f) => {
            const c = ai.features[f.key as keyof typeof ai.features];
            return <tr key={f.key}><td>{f.label}</td><td className="small">{!c ? <span className="muted">–</span> : c.allowed ? <span className="badge ok">erlaubt</span> : <span className="muted">gesperrt: {c.reason}</span>}</td></tr>;
          })}
        </tbody></table>}
    </>
  );
}

/** Agenten, die Mitglied sind: Rolle, LLM, läuft hier oder Grund. Aufnehmen und Rolle ändern unter Personen › Mitglieder. */
function ProjectAgentsInProject() {
  const { detail } = useProject();
  const d = useData<{ inProject: { id: string; name: string; role: string; profileName: string | null; own: boolean; usable: boolean; reason: string | null }[]; orgAgents: { id: string; name: string; member: boolean; usable: boolean; reason: string | null }[] }>(`/projects/${detail.project.id}/agents`);
  if (!d.data) return null;
  const free = d.data.orgAgents.filter((a) => !a.member);
  return (
    <div className="mt">
      <h3>Agenten im Projekt</h3>
      {d.data.inProject.length === 0 ? <div className="empty">Noch kein Agent im Projekt.</div> : <table className="table"><thead><tr><th>Agent</th><th>Rolle</th><th>LLM</th><th>Status</th></tr></thead><tbody>
        {d.data.inProject.map((a) => <tr key={a.id}><td>{a.name}{a.own && <span className="muted small"> · eigener Agent</span>}{detail.project.agentUserId === a.id && <span className="badge" style={{ marginLeft: 6 }}>Projektagent</span>}</td><td className="small">{a.role === 'pl' ? 'stellv. PL' : 'Mitglied'}</td><td className="small">{a.profileName ?? <span className="muted">kein LLM</span>}</td><td className="small">{a.usable ? <span className="badge ok">läuft</span> : <span className="badge warn" title={a.reason ?? ''}>läuft nicht</span>}{!a.usable && <div className="muted">{a.reason}</div>}</td></tr>)}
      </tbody></table>}
      <p className="muted small mt">Agenten der Organisation nimmst du unter <Link to={`/projekte/${detail.project.id}/einstellungen/personen`}>Personen › Mitglieder</Link> auf (Rolle, Mailrecht).{free.length > 0 && <> Verfügbar: {free.map((a) => `${a.name}${a.usable ? '' : ` (${a.reason})`}`).join('; ')}.</>}</p>
    </div>
  );
}

function ProjectAiSelect({ readOnly = false }: { readOnly?: boolean }) {
  const { detail, reload } = useProject();
  const d = useData<ProjectLlms>(`/projects/${detail.project.id}/llms`);
  const { busy, error, run } = useAsync();
  if (!d.data) return null;
  const avail = d.data.available;
  const cur = avail.find((p) => p.id === detail.project.aiProfileId);
  if (readOnly) return <>{cur?.name ?? <span className="muted">{detail.project.aiProfileId ? 'nicht mehr verfügbar' : 'aus'}</span>}</>;
  return <span className="row"><select value={cur ? cur.id : ''} disabled={busy} style={{ width: 'auto' }} onChange={(e) => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { aiProfileId: e.target.value || null }); await reload(); })}><option value="">aus</option>{avail.map((p) => <option key={p.id} value={p.id}>{p.name}{p.own ? ' (eigenes LLM)' : ''}</option>)}</select>
    {detail.project.aiProfileId && !cur && <span className="muted small">bisheriges LLM nicht mehr verfügbar</span>}
    {avail.length === 0 && <span className="muted small">Kein LLM für dieses Projekt freigegeben{d.data.canAddOwn ? '; unten ein eigenes einbinden' : ' (Org-Admin)'}.</span>}
    {error && <span className="error small">{error}</span>}</span>;
}

/** Eigene LLMs des Projekts (PL): nur hier nutzbar, Schlüssel verschlüsselt; der Org-Admin sieht Name, Anbieter, Adresse und Verbrauch und kann sperren. */
function OwnLlmCard({ embedded = false }: { embedded?: boolean }) {
  const { detail, reload } = useProject();
  const d = useData<ProjectLlms>(`/projects/${detail.project.id}/llms`);
  const [edit, setEdit] = useState<ProjectLlms['own'][number] | 'new' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useAsync();
  // Sichtbar, wenn der Mandant eigene LLMs für diese Projektart erlaubt; sperren die KI-Freigaben, nennt der Knopf den Grund
  if (!d.data || (!d.data.canAddOwn && !d.data.ownLlmAllowed && d.data.own.length === 0)) return null;
  const base = `/projects/${detail.project.id}/llms`;
  return (
    <div className={embedded ? 'mt' : 'card'} id="llm">
      <div className="row between mb">{embedded ? <h3 style={{ margin: 0 }}>Eigenes LLM</h3> : <h2 style={{ margin: 0 }}>Eigenes LLM</h2>}{(d.data.canAddOwn || d.data.ownLlmAllowed) && <button className="btn primary sm" disabled={!d.data.canAddOwn} title={d.data.addOwnReason ?? undefined} onClick={() => setEdit('new')}>Einbinden</button>}</div>
      {!d.data.canAddOwn && d.data.ownLlmAllowed && d.data.addOwnReason && <div className="notice small mb">{d.data.addOwnReason}</div>}
      <p className="muted small">Ein eigenes LLM (lokal, OpenAI-kompatibel, oder Anthropic) nur für dieses Projekt: für die Projekt-KI und eigene Agenten. Der Schlüssel liegt verschlüsselt; der Org-Admin sieht Name, Anbieter, Adresse und Verbrauch und kann es sperren.</p>
      {error && <div className="error small">{error}</div>}
      {msg && <div className="success small">{msg}</div>}
      {d.data.own.length > 0 && <table className="table"><tbody>{d.data.own.map((l) => <tr key={l.id} style={l.active && !l.adminBlocked ? undefined : { opacity: 0.6 }}>
        <td>{l.name}<div className="muted small">{l.provider === 'local' ? l.baseUrl : 'Anthropic'} · {l.model}</div></td>
        <td className="small">{l.adminBlocked ? <span className="badge danger">vom Org-Admin gesperrt</span> : l.active ? <span className="badge ok">aktiv</span> : <span className="badge">inaktiv</span>}<div className="muted">{(l.tokensIn + l.tokensOut).toLocaleString('de-DE')} Token</div></td>
        <td className="nowrap"><button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ model: string; reply: string }>(`${base}/${l.id}/test`); setMsg(`${l.name}: ${r.model} antwortet „${r.reply}“.`); })}>Testen</button> <button className="btn sm link" onClick={() => setEdit(l)}>Bearbeiten</button> <button className="btn sm link" disabled={busy} onClick={() => void run(async () => { await api.del(`${base}/${l.id}`); await d.reload(); await reload(); })}>Entfernen</button></td></tr>)}</tbody></table>}
      {edit && <OwnLlmForm llm={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await d.reload(); await reload(); }} />}
    </div>
  );

  function OwnLlmForm({ llm, onClose, onSaved }: { llm: ProjectLlms['own'][number] | null; onClose: () => void; onSaved: () => Promise<void> }) {
    const [f, setF] = useState({ name: llm?.name ?? '', provider: llm?.provider ?? 'local' as 'local' | 'anthropic', baseUrl: llm?.baseUrl ?? '', model: llm?.model ?? '', apiKey: '', thinkingOff: llm?.thinkingOff ?? false, webSearch: llm?.webSearch ?? false, active: llm?.active ?? true });
    const f2 = useAsync();
    return (
      <Modal title={llm ? `LLM: ${llm.name}` : 'Eigenes LLM einbinden'} onClose={onClose}>
        <div className="form">
          <label className="field"><span>Name</span><input type="text" value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Qwen auf meiner 3090" /></label>
          <label className="field"><span>Anbieter</span><select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as any })}><option value="local">Lokales LLM (OpenAI-kompatibel: vLLM, Ollama, LM Studio)</option><option value="anthropic">Anthropic</option></select></label>
          {f.provider === 'local' && <label className="field"><span>Adresse der API</span><input type="url" value={f.baseUrl} placeholder="http://llm.intern:8000/v1" onChange={(e) => setF({ ...f, baseUrl: e.target.value })} /></label>}
          <label className="field"><span>Modell</span><input type="text" value={f.model} placeholder={f.provider === 'local' ? 'z. B. Qwen/Qwen3-32B' : 'claude-sonnet-5-5'} onChange={(e) => setF({ ...f, model: e.target.value })} /></label>
          <label className="field"><span>Schlüssel{llm?.hasKey ? ' · gesetzt, leer = unverändert' : f.provider === 'local' ? ' (optional)' : ''}</span><input type="password" autoComplete="new-password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>
          {f.provider === 'local' && <label className="check"><input type="checkbox" checked={f.thinkingOff} onChange={(e) => setF({ ...f, thinkingOff: e.target.checked })} /> Denkmodus aus</label>}
          <label className="check" title="Dazu muss die KI-Freigabe „Online-Recherche“ erlauben; lokale LLMs brauchen den Suchdienst des Mandanten"><input type="checkbox" checked={f.webSearch} onChange={(e) => setF({ ...f, webSearch: e.target.checked })} /> Online-Recherche mit diesem LLM erlaubt</label>
          {llm && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>}
          {f2.error && <div className="error">{f2.error}</div>}
          <div className="row"><button className="btn primary" disabled={f2.busy || !f.name.trim() || !f.model.trim() || (f.provider === 'local' && !f.baseUrl)} onClick={() => void f2.run(async () => { const body = { name: f.name, provider: f.provider, baseUrl: f.provider === 'local' ? f.baseUrl : null, model: f.model, apiKey: f.apiKey || undefined, thinkingOff: f.provider === 'local' && f.thinkingOff, webSearch: f.webSearch, ...(llm ? { active: f.active } : {}) }; if (llm) await api.patch(`${base}/${llm.id}`, body); else await api.post(base, body); await onSaved(); })}>{llm ? 'Speichern' : 'Einbinden'}</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
        </div>
      </Modal>
    );
  }
}

/** Eigene KI-Agenten des Projekts: legt die PL an (wenn der Mandant es erlaubt), nur hier einsetzbar, nur freigegebene KI-Profile. */
function ProjectAgentsCard({ embedded = false }: { embedded?: boolean }) {
  const { detail, reload } = useProject();
  const d = useData<{ agents: AgentUser[]; policy: { enabled: boolean; maxBudget: number; profiles: { id: string; name: string }[] }; canManage: boolean; manageReason?: string | null }>(`/projects/${detail.project.id}/agents`);
  const [edit, setEdit] = useState<AgentUser | 'new' | null>(null);
  const isPl = detail.project.myMembership.role === 'pl';
  // Für die PL immer sichtbar: ohne Freigabe (KI-Freigaben, Regel „Eigene Agenten der PL“) mit Begründung statt ohne Knopf
  if (!d.data || (!isPl && d.data.agents.length === 0)) return null;
  const { agents, policy, canManage } = d.data;
  return (
    <div className={embedded ? 'mt' : 'card'} id="agenten">
      <div className="row between mb">{embedded ? <h3 style={{ margin: 0 }}>Eigene KI-Agenten</h3> : <h2 style={{ margin: 0 }}>Eigene KI-Agenten</h2>}{isPl && <button className="btn primary sm" disabled={!canManage} title={d.data.manageReason ?? undefined} onClick={() => setEdit('new')}>Agent anlegen</button>}</div>
      {isPl && !canManage && d.data.manageReason && <div className="notice small mb">{d.data.manageReason}</div>}
      <p className="muted small">Agenten nur für dieses Projekt. Sie arbeiten wie andere Agenten (Zuständigkeit, Planung, Mail-Vorschläge), auf einem im Projekt verfügbaren LLM und mit höchstens {policy.maxBudget} Läufen am Tag. Der Org-Admin sieht sie und kann sie deaktivieren, aber keine Inhalte.</p>
      {agents.length === 0 ? <div className="empty">Noch keiner.</div> : <table className="table"><tbody>
        {agents.map((a) => <tr key={a.id} style={a.active ? undefined : { opacity: 0.6 }}><td>{a.name}{!a.active && <span className="badge" style={{ marginLeft: 6 }}>deaktiviert</span>}<div className="muted small">{a.persona ?? 'Standardstil'}</div></td><td className="small">{policy.profiles.find((p) => p.id === a.aiProfileId)?.name ?? '–'} · {a.dailyBudget ?? policy.maxBudget}/Tag</td><td className="small">{a.runs} Läufe</td><td>{canManage && <button className="btn sm link" onClick={() => setEdit(a)}>Bearbeiten</button>}</td></tr>)}
      </tbody></table>}
      {edit && <AgentForm agent={edit === 'new' ? null : edit} policy={policy} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await d.reload(); await reload(); }} />}
    </div>
  );

  function AgentForm({ agent, policy, onClose, onSaved }: { agent: AgentUser | null; policy: { maxBudget: number; profiles: { id: string; name: string }[] }; onClose: () => void; onSaved: () => Promise<void> }) {
    const [f, setF] = useState({ name: agent?.name ?? '', persona: agent?.persona ?? '', signature: agent?.signature ?? '', aiProfileId: agent?.aiProfileId ?? policy.profiles[0]?.id ?? '', dailyBudget: agent?.dailyBudget ?? policy.maxBudget, role: 'member' as 'member' | 'pl', thinkingMode: agent?.thinkingMode ?? null, agentCanMail: false });
    const { busy, error, run } = useAsync();
    const body = { name: f.name, persona: f.persona || null, signature: f.signature || null, aiProfileId: f.aiProfileId || null, dailyBudget: f.dailyBudget, thinkingMode: f.thinkingMode };
    return (
      <Modal title={agent ? `Agent: ${agent.name}` : 'Agent anlegen'} onClose={onClose}>
        <div className="form">
          <label className="field"><span>Name</span><input type="text" value={f.name} maxLength={80} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Morton" /></label>
          <label className="field"><span>Persona (Schreibstil, eine Zeile)</span><input type="text" value={f.persona} maxLength={300} onChange={(e) => setF({ ...f, persona: e.target.value })} placeholder="z. B. freundlich, knapp, duzt" /></label>
          <label className="field"><span>Unterschrift für Mails (frei; leer = „Name (KI-Agent, Projekt KEY)“)</span><textarea rows={3} maxLength={500} value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} /></label>
          <div className="grid cols-2">
            <label className="field"><span>LLM (im Projekt verfügbar)</span><select value={f.aiProfileId} onChange={(e) => setF({ ...f, aiProfileId: e.target.value })}>{policy.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field"><span>Tagesbudget (höchstens {policy.maxBudget})</span><input type="number" min={0} max={policy.maxBudget} value={f.dailyBudget} onChange={(e) => setF({ ...f, dailyBudget: Number(e.target.value) })} /></label>
          </div>
          <label className="field"><span>Denkmodus</span><select value={f.thinkingMode ?? ''} onChange={(e) => setF({ ...f, thinkingMode: (e.target.value || null) as any })}><option value="">wie Profil</option><option value="off">aus</option><option value="on">an</option></select></label>
          {!agent && <>
            <label className="field"><span>Rolle im Projekt</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as any })}><option value="member">Mitglied</option><option value="pl">Stellvertretende PL (plant im ganzen Projekt)</option></select></label>
            <label className="check"><input type="checkbox" checked={f.agentCanMail} onChange={(e) => setF({ ...f, agentCanMail: e.target.checked })} /> darf Mails über das Projektkonto senden (sonst Entwürfe zur Freigabe)</label>
          </>}
          {policy.profiles.length === 0 && <div className="notice small">Im Projekt ist kein LLM verfügbar: Freigabe durch den Org-Admin oder eigenes LLM einbinden.</div>}
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy || !f.name.trim() || !f.aiProfileId} onClick={() => void run(async () => { if (agent) await api.patch(`/projects/${detail.project.id}/agents/${agent.id}`, body); else await api.post(`/projects/${detail.project.id}/agents`, { ...body, role: f.role, agentCanMail: f.agentCanMail }); await onSaved(); })}>{agent ? 'Speichern' : 'Anlegen'}</button>
            {agent && <button className="btn" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}/agents/${agent.id}`, { active: !agent.active }); await onSaved(); })}>{agent.active ? 'Deaktivieren' : 'Aktivieren'}</button>}
            <button className="btn" onClick={onClose}>Abbrechen</button>
          </div>
        </div>
      </Modal>
    );
  }
}

/**
 * Projekt › Einstellungen › KI (Konzept LLM/Agenten 3.2): LLM der Assistenz, Projektagent mit Mail-Modus, Agenten im Projekt,
 * Agenten-Policy mit Herkunft, eigenes LLM, eigene Agenten, eigene Rechte.
 */
export function AiTab() {
  const { detail } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  const llms = useData<ProjectLlms>(`/projects/${detail.project.id}/llms`);
  return (
    <>
      <SettingsCard title="KI" action={<Link className="btn sm link" to="/hilfe/ki-agenten" title="KI-Handbuch">Hilfe</Link>} hint="LLMs und Agenten stellt die Organisation bereit (Einsatz je LLM und Agent); die PL wählt und nimmt auf. Ein Agent läuft hier nur, wenn sein LLM für dieses Projekt freigegeben ist.">
        {!isPl && <ReadOnlyNote who="PL" />}
        <dl className="kv">
          <dt title="Für Zusammenfassen, Essenz, Frage ans Projekt, Statusbericht">LLM der Assistenz</dt><dd><ProjectAiSelect readOnly={!isPl} /></dd>
          <dt>Verfügbare LLMs</dt><dd className="small">{!llms.data ? '…' : llms.data.available.length === 0 ? <span className="muted">keins für dieses Projekt freigegeben{llms.data.canAddOwn ? ' – unten ein eigenes einbinden' : <> (Org-Admin: <Link to="/verwaltung/ki">Verwaltung › KI</Link>, Einsatz des LLM)</>}</span> : llms.data.available.map((l) => <span key={l.id} className="badge" style={{ marginRight: 4 }} title={`${l.provider === 'local' ? 'Lokal' : 'Anthropic'} · ${l.model}`}>{l.name} · {l.own ? 'eigenes LLM' : 'Organisation'}</span>)}</dd>
          <dt>Projektagent</dt><dd><ProjectAgentSelect readOnly={!isPl} /></dd>
          <dt>Agenten-Policy</dt><dd><ProjectAgentPolicy readOnly={!isPl} /></dd>
        </dl>
        <ProjectAgentsInProject />
        <OwnLlmCard embedded />
        <ProjectAgentsCard embedded />
      </SettingsCard>
      <SettingsCard title="Deine Rechte" hint="Rolle, Einzelrechte und je KI-Funktion erlaubt oder die Begründung aus den KI-Freigaben des Mandanten und den Rechten im Projekt."><MyRights /></SettingsCard>
    </>
  );
}

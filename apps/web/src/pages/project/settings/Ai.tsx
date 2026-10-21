import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../../../lib/api';
import { Modal, roleLabel, useAsync, useDialog } from '../../../components/ui';
import { AgentPolicyEditor, EffectivePolicyText } from '../../../components/AgentPolicy';
import { AgentEditorModal, RightsEditor, rightsSummary } from '../../../components/AgentEditor';
import { AGENT_MODES, AI_FEATURES, type AgentMode, type AgentPolicy, type AgentUser, type AiFeature, type EffectiveAgentPolicy } from '@projekttool/shared';
import { useProject } from '../../ProjectPage';
import { useData } from '../../../lib/useData';
import { ReadOnlyNote, SettingsCard } from '../../../components/settings/Settings';
import { rightsText } from './People';

type OwnLlm = { id: string; name: string; provider: 'local' | 'anthropic'; model: string; baseUrl: string | null; hasKey: boolean; active: boolean; adminBlocked: boolean; thinkingOff: boolean; webSearch?: boolean; tokensIn: number; tokensOut: number; lastUsedAt: string | null };
type ProjectLlms = { available: { id: string; name: string; provider: string; model: string; own: boolean }[]; own: OwnLlm[]; canAddOwn: boolean; addOwnReason?: string | null; ownLlmAllowed?: boolean };
type ProjectAgent = AgentUser & { rights: AiFeature[]; usable: boolean; reason: string | null };
type ProjectAgents = { inProject: (ProjectAgent & { role: 'pl' | 'member'; deny: AiFeature[] })[]; candidates: ProjectAgent[]; budget: number };
type AgentPolicies = { effective: EffectiveAgentPolicy; project: AgentPolicy; agents: { userId: string; name: string; policy: AgentPolicy | null; effective: EffectiveAgentPolicy }[]; canEdit: boolean };

const MODE_ORDER: AgentMode[] = AGENT_MODES.map((m) => m.key);
const labelOf = (k: AiFeature) => AI_FEATURES.find((f) => f.key === k)?.label ?? k;

/**
 * Projektagent (#52): ein eingeladener Agent als stellvertretende Projektleitung. Mit Mail-Modus bearbeitet er neue Mails der
 * Projektkonten selbst oder schlägt vor; der Ordner „KI Bearbeiten“ bleibt für Konten ohne Projektagent.
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
      <select value={cur?.userId ?? ''} disabled={busy || agents.length === 0} style={{ width: 'auto' }} onChange={(e) => set(e.target.value || null, mode)}><option value="">keiner</option>{agents.map((a) => <option key={a.userId} value={a.userId}>{a.name}</option>)}</select>
      {cur && <select value={mode} disabled={busy} style={{ width: 'auto' }} title="Mails der Projektkonten" onChange={(e) => set(cur.userId, e.target.value)}>{Object.entries(MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
    </span>
    <span className="muted small">{agents.length === 0 ? 'Zuerst oben einen Agenten einladen.' : 'Stellvertretende PL; führt auch die Assistenz aus (Zusammenfassen, Frage ans Projekt …). Mail-Modus braucht sein Recht „Mails direkt bearbeiten“.'}</span>
    {error && <span className="error small">{error}</span>}</span>;
}

/**
 * Agenten im Projekt: Im Projekt gibt es nur Agenten (kein „Projekt-LLM“). Die PL lädt Agenten ein, deren LLM hier eingesetzt
 * werden darf, und schränkt sie ein: Rechte abschalten, Selbstständigkeit strenger; mehr als der Verwalter des LLM erteilt hat, nie.
 */
function AgentsInProject({ readOnly }: { readOnly: boolean }) {
  const { detail, reload } = useProject();
  const pid = detail.project.id;
  const d = useData<ProjectAgents>(`/projects/${pid}/agents`);
  const pol = useData<AgentPolicies>(`/projects/${pid}/agent-policy`);
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<ProjectAgents['inProject'][number] | null>(null);
  const { error, run } = useAsync();
  const dialog = useDialog();
  if (!d.data) return null;
  const reloadAll = async () => { await d.reload(); await pol.reload(); await reload(); };
  const remove = (a: { id: string; name: string }) => void dialog.confirm({ title: 'Agent entfernen', text: `${a.name} aus dem Projekt entfernen? Zuständigkeiten fallen an die PL zurück, Log und Läufe bleiben.`, confirmLabel: 'Entfernen', danger: true })
    .then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${pid}/members/${a.id}`); await reloadAll(); }); });
  const usable = d.data.candidates.filter((c) => c.usable);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row between"><h3 style={{ margin: 0 }}>Agenten im Projekt</h3>{!readOnly && <button className="btn primary sm" disabled={usable.length === 0} title={usable.length === 0 ? 'Kein einladbarer Agent (Verwaltung › KI oder eigenes LLM unten)' : undefined} onClick={() => setInvite(true)}>Agent einladen</button>}</div>
      {error && <div className="error small">{error}</div>}
      {d.data.inProject.length === 0 ? <div className="empty">Noch kein Agent im Projekt. Ohne Agent sind die KI-Funktionen hier aus.</div> : <table className="table"><thead><tr><th>Agent</th><th>LLM</th><th>Rolle</th><th>Darf hier</th><th /></tr></thead><tbody>
        {d.data.inProject.map((a) => {
          const here = a.rights.filter((r) => !a.deny.includes(r));
          return <tr key={a.id} style={a.usable ? undefined : { opacity: 0.7 }}>
            <td>{a.name}{detail.project.agentUserId === a.id && <span className="badge" style={{ marginLeft: 6 }}>Projektagent</span>}{!a.usable && <div className="small"><span className="badge warn">läuft nicht</span> <span className="muted">{a.reason}</span></div>}</td>
            <td className="small">{a.profileName ?? <span className="muted">kein LLM</span>}<div className="muted">{a.profileProjectId ? 'eigenes LLM' : 'Organisation'}</div></td>
            <td className="small">{a.role === 'pl' ? 'stellv. PL' : 'Mitglied'}</td>
            <td className="small">{rightsSummary(here)}{a.deny.length > 0 && <div className="muted">hier aus: {a.deny.map(labelOf).join(', ')}</div>}</td>
            <td className="nowrap">{!readOnly && <><button className="btn sm link" onClick={() => setEdit(a)}>Einschränken</button><button className="btn sm link" onClick={() => remove(a)}>Entfernen</button></>}</td>
          </tr>;
        })}
      </tbody></table>}
      {!readOnly && d.data.candidates.length === 0 && <p className="muted small" style={{ margin: 0 }}>Kein Agent zum Einladen: Agenten legt an, wer ein LLM verwaltet (Org-Admin unter Verwaltung › KI, bei einem eigenen LLM du unten).</p>}
      {!readOnly && d.data.candidates.some((c) => !c.usable) && <p className="muted small" style={{ margin: 0 }}>Nicht einladbar: {d.data.candidates.filter((c) => !c.usable).map((c) => `${c.name} (${c.reason})`).join('; ')}</p>}
      {invite && <InviteAgent candidates={usable} onClose={() => setInvite(false)} onSaved={async () => { setInvite(false); await reloadAll(); }} />}
      {edit && <RestrictAgent agent={edit} policy={pol.data?.agents.find((x) => x.userId === edit.id) ?? null} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await reloadAll(); }} />}
    </div>
  );
}

/** Agent einladen: Agent wählen (nur hier einsetzbare), Rolle, Mailversand; Rechte bringt er vom Verwalter seines LLM mit. */
function InviteAgent({ candidates, onClose, onSaved }: { candidates: ProjectAgent[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { detail } = useProject();
  const [f, setF] = useState({ id: candidates[0]?.id ?? '', role: 'member' as 'member' | 'pl', agentCanMail: false });
  const { busy, error, run } = useAsync();
  const a = candidates.find((c) => c.id === f.id);
  return (
    <Modal title="Agent einladen" onClose={onClose}>
      <div className="form">
        <label className="field"><span>Agent</span><select value={f.id} autoFocus onChange={(e) => setF({ ...f, id: e.target.value })}>{candidates.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.profileName ?? 'kein LLM'}</option>)}</select></label>
        {a && <p className="small" style={{ margin: 0 }}>Bringt mit: {rightsSummary(a.rights)}{a.persona && <span className="muted"> · {a.persona}</span>}</p>}
        <label className="field"><span>Rolle</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as 'member' | 'pl' })}><option value="member">Mitglied (arbeitet an zugewiesenen Arbeitspaketen)</option><option value="pl">Stellvertretende PL (plant im ganzen Projekt; wird Projektagent, wenn noch keiner gesetzt ist)</option></select></label>
        <label className="check"><input type="checkbox" checked={f.agentCanMail} onChange={(e) => setF({ ...f, agentCanMail: e.target.checked })} /> darf Mails über das Projektkonto senden (sonst nur Entwürfe zur Freigabe)</label>
        <p className="muted small" style={{ margin: 0 }}>Nach dem Einladen kannst du ihn unter „Einschränken“ weiter begrenzen.</p>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || !f.id} onClick={() => void run(async () => { await api.put(`/projects/${detail.project.id}/members/${f.id}`, { role: f.role, isDeputy: true, agentCanMail: f.agentCanMail }); await onSaved(); })}>Einladen</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/**
 * Agent im Projekt einschränken: Rechte nur abschalten (nicht erteilte stehen ausgegraut), Selbstständigkeit nur strenger als die
 * Obergrenze des Verwalters, Workflow-Schritte, Rolle und Mailversand.
 */
function RestrictAgent({ agent, policy, onClose, onSaved }: { agent: ProjectAgents['inProject'][number]; policy: AgentPolicies['agents'][number] | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { detail } = useProject();
  const member = detail.members.find((m) => m.userId === agent.id);
  const cur = policy?.policy ?? {};
  const cap = agent.policy?.maxMode;
  const modes = AGENT_MODES.filter((m) => !cap || MODE_ORDER.indexOf(m.key) >= MODE_ORDER.indexOf(cap));
  const [f, setF] = useState({ allowed: agent.rights.filter((r) => !agent.deny.includes(r)), mode: cur.mode ?? '' as AgentMode | '', workflows: cur.workflows === undefined ? '' : cur.workflows ? 'yes' : 'no', role: agent.role, agentCanMail: member?.agentCanMail !== false });
  const { busy, error, run } = useAsync();
  const save = () => run(async () => {
    const pid = detail.project.id;
    const deny = agent.rights.filter((r) => !f.allowed.includes(r));
    const next: AgentPolicy = { ...(cur.confirm ? { confirm: cur.confirm } : {}), ...(cur.depth ? { depth: cur.depth } : {}), ...(deny.length ? { deny } : {}), ...(f.mode ? { mode: f.mode } : {}), ...(f.workflows ? { workflows: f.workflows === 'yes' } : {}) };
    await api.put(`/projects/${pid}/members/${agent.id}/agent-policy`, Object.keys(next).length ? next : null);
    if (f.role !== agent.role || f.agentCanMail !== (member?.agentCanMail !== false)) await api.put(`/projects/${pid}/members/${agent.id}`, { role: f.role, isDeputy: true, agentCanMail: f.agentCanMail, canFinalize: member?.canFinalize ?? false });
    await onSaved();
  });
  return (
    <Modal title={`${agent.name} im Projekt`} onClose={onClose}>
      <div className="form">
        <p className="muted small" style={{ margin: 0 }}>Was {agent.name} grundsätzlich darf, legt der Verwalter von {agent.profileName ?? 'seinem LLM'} fest. Hier schaltest du nur ab.</p>
        <RightsEditor value={f.allowed} granted={agent.rights} onChange={(allowed) => setF({ ...f, allowed })} />
        <div className="grid cols-2">
          <label className="field"><span>Selbstständigkeit{cap && <span className="muted"> (höchstens {AGENT_MODES.find((m) => m.key === cap)?.label})</span>}</span><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as AgentMode | '' })}><option value="">wie Projekt ({AGENT_MODES.find((m) => m.key === policy?.effective.mode)?.label ?? '…'})</option>{modes.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label>
          <label className="field"><span>Workflow-Schritte</span><select value={f.workflows} onChange={(e) => setF({ ...f, workflows: e.target.value })}><option value="">wie Projekt</option><option value="yes">erlaubt</option><option value="no">aus</option></select></label>
          <label className="field"><span>Rolle</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as 'member' | 'pl' })}><option value="member">Mitglied</option><option value="pl">Stellvertretende PL</option></select></label>
          <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.agentCanMail} onChange={(e) => setF({ ...f, agentCanMail: e.target.checked })} /> darf Mails über das Projektkonto senden</label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy} onClick={() => void save()}>Speichern</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/**
 * Agenten-Policy des Projekts (Konzept 6): Selbstständigkeit und zu bestätigende Schritte für alle Agenten im Projekt, Grenzen für
 * Arbeitspakete, Workflow-Schritte. Die Obergrenze am Agenten (Verwalter des LLM) gilt darüber.
 */
function ProjectAgentPolicy({ readOnly = false }: { readOnly?: boolean }) {
  const { detail, reload } = useProject();
  const d = useData<AgentPolicies>(`/projects/${detail.project.id}/agent-policy`);
  const [open, setOpen] = useState(false);
  if (!d.data) return null;
  return <span className="stack" style={{ gap: 4 }}>
    <span className="row"><EffectivePolicyText e={d.data.effective} />{!readOnly && <button className="btn sm link" onClick={() => setOpen((o) => !o)}>{open ? 'schließen' : 'ändern'}</button>}</span>
    {open && <AgentPolicyEditor value={d.data.project} limits workflows inheritFrom="Standard" effective={d.data.effective} onSave={async (v) => { await api.put(`/projects/${detail.project.id}/agent-policy`, v); setOpen(false); await d.reload(); await reload(); }} />}
    <span className="muted small">Grundmenge (Log, Tasks, Doku-Entwürfe, interner Chat, Fragen) ist immer frei; Angehaltenes legt der Agent der PL als Karte vor. Je Agent unter „Einschränken“, je Arbeitspaket im Arbeitspaket.</span>
    {detail.project.agentUserId && <ProjectReview readOnly={readOnly} scope={d.data.effective.scope} />}
  </span>;
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
 * Eigene Rechte im Projekt: Rolle, Einzelrechte und je KI-Funktion, die du anstoßen kannst, erlaubt oder die Begründung
 * (KI nutzen, Agent im Projekt mit dem Recht). Leser sehen nur „Frage ans Projekt“ und Chat.
 */
export function MyRights() {
  const { detail, ai } = useProject();
  const me = detail.project.myMembership;
  const features = AI_FEATURES.filter((f) => (f.category === 'assist' || f.key === 'agent.chat') && (me.role !== 'reader' || f.key === 'assist.ask' || f.key === 'agent.chat'));
  return (
    <>
      <p className="small">{roleLabel[me.role]}{me.role === 'pl' && (me.isDeputy ? ' (Stellvertretung)' : ' (verantwortlich)')} · Einzelrechte: {me.role === 'pl' ? 'alle' : rightsText(me)}</p>
      {!ai ? <p className="muted small">KI-Rechte werden geladen …</p>
        : <table className="table"><thead><tr><th>KI-Funktion</th><th>Für dich</th></tr></thead><tbody>
          {features.map((f) => {
            const c = ai.features[f.key];
            return <tr key={f.key}><td>{f.label}</td><td className="small">{!c ? <span className="muted">–</span> : c.allowed ? <span className="badge ok">erlaubt</span> : <span className="muted">gesperrt: {c.reason}</span>}</td></tr>;
          })}
        </tbody></table>}
    </>
  );
}

/**
 * Eigenes LLM des Projekts (wenn der Mandant es erlaubt): die PL bindet es ein und verwaltet seine Agenten (anlegen, berechtigen);
 * sie sind nur hier Mitglied. Der Org-Admin sieht Name, Anbieter, Adresse und Verbrauch und kann sperren.
 */
function OwnLlmCard() {
  const { detail, reload } = useProject();
  const d = useData<ProjectLlms>(`/projects/${detail.project.id}/llms`);
  const ag = useData<ProjectAgents>(`/projects/${detail.project.id}/agents`);
  const [edit, setEdit] = useState<OwnLlm | 'new' | null>(null);
  const [agent, setAgent] = useState<{ agent: AgentUser | null; llmId: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useAsync();
  if (!d.data || (!d.data.canAddOwn && !d.data.ownLlmAllowed && d.data.own.length === 0)) return null;
  const base = `/projects/${detail.project.id}/llms`;
  const agentsOf = (id: string) => (ag.data?.inProject ?? []).filter((a) => a.aiProfileId === id);
  const llms = d.data.own.map((l) => ({ id: l.id, name: l.name, provider: l.provider, thinkingOff: l.thinkingOff }));
  const reloadAll = async () => { await d.reload(); await ag.reload(); await reload(); };
  return (
    <div className="mt" id="llm">
      <div className="row between mb"><h3 style={{ margin: 0 }}>Eigenes LLM</h3>{(d.data.canAddOwn || d.data.ownLlmAllowed) && <button className="btn sm" disabled={!d.data.canAddOwn} title={d.data.addOwnReason ?? undefined} onClick={() => setEdit('new')}>LLM einbinden</button>}</div>
      {!d.data.canAddOwn && d.data.addOwnReason && <div className="notice small mb">{d.data.addOwnReason}</div>}
      <p className="muted small">Ein LLM nur für dieses Projekt (lokal, OpenAI-kompatibel, oder Anthropic). Du legst seine Agenten an und legst fest, was sie dürfen; sie sind gleich Mitglied. Der Schlüssel liegt verschlüsselt; der Org-Admin sieht Name, Anbieter, Adresse und Verbrauch und kann sperren.</p>
      {error && <div className="error small">{error}</div>}
      {msg && <div className="success small">{msg}</div>}
      {d.data.own.map((l) => <section key={l.id} className="llm-block" style={l.active && !l.adminBlocked ? undefined : { opacity: 0.6 }}>
        <div className="row between" style={{ flexWrap: 'wrap' }}>
          <div><strong>{l.name}</strong> {l.adminBlocked ? <span className="badge danger">vom Org-Admin gesperrt</span> : l.active ? <span className="badge ok">aktiv</span> : <span className="badge">inaktiv</span>}<div className="muted small">{l.provider === 'local' ? l.baseUrl : 'Anthropic'} · {l.model} · {(l.tokensIn + l.tokensOut).toLocaleString('de-DE')} Token</div></div>
          <span className="nowrap"><button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ model: string; reply: string }>(`${base}/${l.id}/test`); setMsg(`${l.name}: ${r.model} antwortet „${r.reply}“.`); })}>Testen</button> <button className="btn sm link" onClick={() => setEdit(l)}>Bearbeiten</button> <button className="btn sm link" disabled={busy} onClick={() => void run(async () => { await api.del(`${base}/${l.id}`); await reloadAll(); })}>Entfernen</button> <button className="btn sm primary" disabled={!d.data!.canAddOwn} onClick={() => setAgent({ agent: null, llmId: l.id })}>Agent anlegen</button></span>
        </div>
        {agentsOf(l.id).length > 0 && <table className="table"><tbody>{agentsOf(l.id).map((a) => <tr key={a.id} style={a.active ? undefined : { opacity: 0.6 }}>
          <td>{a.name}{!a.active && <span className="badge" style={{ marginLeft: 6 }}>deaktiviert</span>}<div className="muted small">{a.persona ?? 'Standardstil'}</div></td>
          <td className="small">{rightsSummary(a.rights)}<div className="muted">{a.dailyBudget ?? ag.data?.budget}/Tag · {a.runs} Läufe</div></td>
          <td className="nowrap">{a.canManage && <><button className="btn sm link" onClick={() => setAgent({ agent: a, llmId: l.id })}>Bearbeiten</button><button className="btn sm link" disabled={busy} onClick={() => void run(async () => { await api.patch(`/agents/${a.id}`, { active: !a.active }); await reloadAll(); })}>{a.active ? 'Deaktivieren' : 'Aktivieren'}</button></>}</td>
        </tr>)}</tbody></table>}
      </section>)}
      {edit && <OwnLlmForm llm={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await reloadAll(); }} />}
      {agent && <AgentEditorModal agent={agent.agent} llms={llms} llmId={agent.llmId} orgBudget={ag.data?.budget ?? 0} scoped={false} onClose={() => setAgent(null)} onSaved={async (w) => { setAgent(null); if (w.length) setMsg(w.join(' · ')); await reloadAll(); }} />}
    </div>
  );

  function OwnLlmForm({ llm, onClose, onSaved }: { llm: OwnLlm | null; onClose: () => void; onSaved: () => Promise<void> }) {
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
          <label className="check" title="Dazu braucht der Agent das Recht „Online-Recherche“; lokale LLMs brauchen den Suchdienst des Mandanten"><input type="checkbox" checked={f.webSearch} onChange={(e) => setF({ ...f, webSearch: e.target.checked })} /> Online-Recherche mit diesem LLM erlaubt</label>
          {llm && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>}
          {f2.error && <div className="error">{f2.error}</div>}
          <div className="row"><button className="btn primary" disabled={f2.busy || !f.name.trim() || !f.model.trim() || (f.provider === 'local' && !f.baseUrl)} onClick={() => void f2.run(async () => { const body = { name: f.name, provider: f.provider, baseUrl: f.provider === 'local' ? f.baseUrl : null, model: f.model, apiKey: f.apiKey || undefined, thinkingOff: f.provider === 'local' && f.thinkingOff, webSearch: f.webSearch, ...(llm ? { active: f.active } : {}) }; if (llm) await api.patch(`${base}/${llm.id}`, body); else await api.post(base, body); await onSaved(); })}>{llm ? 'Speichern' : 'Einbinden'}</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
        </div>
      </Modal>
    );
  }
}

/**
 * Projekt › Einstellungen › KI: Agenten im Projekt (einladen, einschränken), Projektagent, Agenten-Policy, eigenes LLM mit seinen
 * Agenten, eigene Rechte.
 */
export function AiTab() {
  const { detail } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  return (
    <>
      <SettingsCard title="KI" action={<Link className="btn sm link" to="/hilfe/ki-agenten" title="KI-Handbuch">Hilfe</Link>} hint="Im Projekt arbeiten nur Agenten. Was ein Agent darf, legt der Verwalter seines LLM fest; hier lädst du ihn ein und kannst nur weiter einschränken.">
        {!isPl && <ReadOnlyNote who="PL" />}
        <AgentsInProject readOnly={!isPl} />
        <dl className="kv mt">
          <dt>Projektagent</dt><dd><ProjectAgentSelect readOnly={!isPl} /></dd>
          <dt>Agenten-Policy</dt><dd><ProjectAgentPolicy readOnly={!isPl} /></dd>
        </dl>
        {isPl && <OwnLlmCard />}
      </SettingsCard>
      <SettingsCard title="Deine Rechte" hint="Rolle, Einzelrechte und je KI-Funktion erlaubt oder die Begründung (KI nutzen, Agent im Projekt mit dem Recht)."><MyRights /></SettingsCard>
    </>
  );
}

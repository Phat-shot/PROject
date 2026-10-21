import { useState } from 'react';
import type { AgentUser, AiFeedbackEntry, AiProfile } from '@projekttool/shared';
import { AGENT_MODES, AI_FEEDBACK_KINDS } from '@projekttool/shared';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync, useDialog } from '../../components/ui';
import { invalidateAi, useAiStatus } from '../../lib/useAi';
import { AgentEditorModal, ScopeEditor, rightsSummary } from '../../components/AgentEditor';

/**
 * Verwaltung › KI: ein Weg von oben nach unten. 1 LLM anlegen und für Projekte freigeben, 2 an jedem LLM seine Agenten anlegen
 * und berechtigen, 3 die PL lädt Agenten ins Projekt ein und schränkt dort nur weiter ein. Darunter Notaus, Budget, eigene LLMs
 * der Projekte und Online-Recherche.
 */
export function AiSection() {
  return (
    <div id="ki">
      <div className="card"><h2 style={{ margin: 0 }}>KI</h2>
        <ol className="small ai-steps">
          <li><strong>LLM anlegen</strong> und festlegen, in welchen Projekten es laufen darf.</li>
          <li>Am LLM <strong>Agenten anlegen</strong> und berechtigen: was er darf, wie selbstständig höchstens, Budget.</li>
          <li>Die <strong>PL lädt Agenten ein</strong> (Projekt › Einstellungen › KI) und kann ihre Rechte dort nur abschalten. Im Projekt arbeiten nur Agenten; Personen mit „KI nutzen“ lösen Assistenz aus.</li>
        </ol>
        <p className="muted small" style={{ marginBottom: 0 }}>Außenprüfung und Arbeitszeitfenster für Mails nach außen stehen unter <Link to="/verwaltung/mail">Mail</Link>.</p>
      </div>
      <LlmsCard />
      <ProjectLlmsCard />
      <LimitsCard />
      <FeedbackCard />
    </div>
  );
}

const ctxText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v, null, 1));
/**
 * Feedback zu den Agenten: Daumen mit Kommentar und automatische Signale (Ablehnungen, Bearbeitungen, ersetzte Behauptungen,
 * nicht ausgeführte Befehle, Fehler). Nur für die KI-Verwaltung; Export als JSONL oder CSV, um Prompt und KI-Sheet zu verbessern.
 */
function FeedbackCard() {
  const [f, setF] = useState({ kind: '', agentId: '', rating: '', from: '', to: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const d = useData<{ items: AiFeedbackEntry[]; counts: { kind: string; n: number; up: number; down: number }[] }>(`/ai/feedback${qs ? `?${qs}` : ''}`, [qs]);
  const agents = useData<{ agents: AgentUser[] }>('/agents');
  const label = (k: string) => AI_FEEDBACK_KINDS.find((x) => x.key === k)?.label ?? k;
  const count = (k: string) => d.data?.counts.find((c) => c.kind === k);
  const rating = count('rating');
  return (
    <div className="card" id="feedback">
      <div className="row between mb" style={{ flexWrap: 'wrap', gap: 6 }}><h2 style={{ margin: 0 }}>Feedback zu den Agenten</h2>
        <span className="row" style={{ gap: 4 }}><a className="btn sm" href={`/api/ai/feedback/export?format=jsonl${qs ? `&${qs}` : ''}`} download>Export JSONL</a><a className="btn sm" href={`/api/ai/feedback/export?format=csv${qs ? `&${qs}` : ''}`} download>Export CSV</a></span></div>
      <p className="muted small">Jede Rückmeldung wird gesichert: 👍/👎 an Chat-Antworten und Läufen sowie automatisch Ablehnungen mit Grund, bearbeitete Vorschläge und Entwürfe (vorher/nachher), ersetzte Behauptungen, nicht ausgeführte Befehle und Fehler. Sichtbar nur hier; der Export (gefiltert) dient dazu, Prompt, KI-Sheet und Agenten zu verbessern.</p>
      {d.data && <div className="row small mb filterbar" style={{ flexWrap: 'wrap', gap: 4 }}>
        {rating && <span className="badge">Bewertungen: 👍 {rating.up} · 👎 {rating.down}</span>}
        {AI_FEEDBACK_KINDS.filter((k) => k.key !== 'rating' && count(k.key)).map((k) => <button key={k.key} className={`chip ${f.kind === k.key ? 'on' : ''}`} onClick={() => setF({ ...f, kind: f.kind === k.key ? '' : k.key })}>{k.label}: {count(k.key)!.n}</button>)}
        {d.data.counts.length === 0 && <span className="muted">Noch kein Feedback.</span>}
      </div>}
      <div className="row small mb" style={{ flexWrap: 'wrap', gap: 6 }}>
        <select aria-label="Art" value={f.kind} style={{ width: 'auto' }} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="">alle Arten</option>{AI_FEEDBACK_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select>
        <select aria-label="Agent" value={f.agentId} style={{ width: 'auto' }} onChange={(e) => setF({ ...f, agentId: e.target.value })}><option value="">alle Agenten</option>{(agents.data?.agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select aria-label="Bewertung" value={f.rating} style={{ width: 'auto' }} onChange={(e) => setF({ ...f, rating: e.target.value })}><option value="">alles</option><option value="down">nur Probleme (👎 und automatische)</option><option value="up">nur 👍</option></select>
        <label className="row" style={{ gap: 4 }}>von <input type="date" value={f.from} style={{ width: 'auto' }} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="row" style={{ gap: 4 }}>bis <input type="date" value={f.to} style={{ width: 'auto' }} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
      </div>
      {d.data && (d.data.items.length === 0 ? <div className="empty">Kein Feedback{qs ? ' für diesen Filter' : ''}.</div> : <table className="table"><thead><tr><th>Zeit</th><th>Art</th><th>Agent</th><th>Projekt</th><th>Kommentar und Kontext</th></tr></thead><tbody>
        {d.data.items.map((x) => <tr key={x.id}>
          <td className="small nowrap">{fmtDateTime(x.updatedAt)}</td>
          <td className="small">{x.kind === 'rating' ? (x.rating === 1 ? '👍' : '👎') : label(x.kind)}{x.user && <div className="muted">{x.user.name}</div>}</td>
          <td className="small">{x.agent?.name ?? '–'}</td>
          <td className="small">{x.project ?? '–'}</td>
          <td className="small">{x.comment && <div>„{x.comment}“</div>}{typeof x.context.reason === 'string' && x.context.reason !== x.comment && <div className="muted">{x.context.reason}</div>}{typeof x.context.detail === 'string' && <div className="muted">{x.context.detail}</div>}
            <details><summary className="muted">Kontext</summary>{(['input', 'output', 'before', 'after', 'replaced', 'command', 'findings'] as const).filter((k) => x.context[k] !== undefined).map((k) => <div key={k}><strong>{({ input: 'Anfrage', output: 'Agent', before: 'Vorher (Agent)', after: 'Nachher (Person)', replaced: 'Ersetzt', command: 'Befehl', findings: 'Fundstellen' } as Record<string, string>)[k]}:</strong><pre className="small" style={{ whiteSpace: 'pre-wrap', margin: '2px 0 6px' }}>{ctxText(x.context[k])}</pre></div>)}</details></td>
        </tr>)}
      </tbody></table>)}
    </div>
  );
}

type ProjectLlmRow = { id: string; name: string; provider: string; model: string; baseUrl: string | null; active: boolean; adminBlocked: boolean; tokensIn: number; tokensOut: number; lastUsedAt: string | null; project: string; createdBy: string | null };

const fmtTokens = (n: number) => `${n.toLocaleString('de-DE')} Token`;
const maxModeText = (a: AgentUser) => (a.policy?.maxMode ? AGENT_MODES.find((m) => m.key === a.policy!.maxMode)?.label ?? a.policy.maxMode : null);

/** Agenten eines LLM: Rechte, Obergrenze, Budget, Einsatz, Projekte (läuft oder Grund), Läufe; bearbeiten nur, wer das LLM verwaltet. */
function AgentRows({ agents, onEdit, onToggle, busy, orgBudget }: { agents: AgentUser[]; onEdit?: (a: AgentUser) => void; onToggle: (a: AgentUser) => void; busy: boolean; orgBudget: number }) {
  const scopeText = (a: AgentUser) => (a.scope === 'project' ? `nur ${a.projectBound?.label ?? 'eigenes Projekt'}` : a.scope === 'selected' ? `${(a.projectIds ?? []).length} ausgewählte Projekte` : 'alle Projekte');
  if (!agents.length) return <div className="muted small" style={{ padding: '4px 0' }}>Noch kein Agent an diesem LLM.</div>;
  return <table className="table"><thead><tr><th>Agent</th><th>Darf</th><th>Selbstständigkeit</th><th>Budget · Einsatz</th><th>Projekte</th><th>Läufe</th><th /></tr></thead><tbody>
    {agents.map((a) => <tr key={a.id} style={a.active ? undefined : { opacity: 0.6 }}>
      <td>{a.name}{!a.active && <span className="badge" style={{ marginLeft: 6 }}>deaktiviert</span>}<div className="muted small">{a.persona ?? 'Standardstil'}</div></td>
      <td className="small">{rightsSummary(a.rights)}</td>
      <td className="small">{maxModeText(a) ? `höchstens: ${maxModeText(a)}` : 'ohne Grenze (Projekt entscheidet)'}{(a.policy?.lockedConfirm?.length ?? 0) > 0 && <div className="muted">immer bestätigen: {a.policy!.lockedConfirm!.length}</div>}</td>
      <td className="small">{a.dailyBudget ?? orgBudget}/Tag<div className="muted">{scopeText(a)}</div></td>
      <td className="small">{a.projects.length === 0 ? <span className="muted">nicht eingeladen</span> : a.projects.map((p) => <span key={p.id} className={`badge ${p.usable === false ? 'warn' : ''}`} style={{ marginRight: 4 }} title={p.usable === false ? p.reason ?? '' : `${p.name}: läuft`}>{p.key}{p.usable === false ? ' ⚠' : ''}</span>)}</td>
      <td className="small">{a.runs}{a.lastRunAt && <div className="muted">{fmtDateTime(a.lastRunAt)}</div>}</td>
      <td className="nowrap">{onEdit && a.canManage && <><button className="btn sm" disabled={busy} onClick={() => onEdit(a)}>Bearbeiten</button>{' '}</>}
        <button className={`btn sm ${a.active ? 'danger' : ''}`} disabled={busy} onClick={() => onToggle(a)}>{a.active ? 'Deaktivieren' : 'Aktivieren'}</button></td>
    </tr>)}
  </tbody></table>;
}

/** LLMs der Organisation, je LLM mit seinen Agenten (anlegen, berechtigen, Einsatz). */
function LlmsCard() {
  const st = useAiStatus();
  const agents = useData<{ agents: AgentUser[] }>('/agents');
  const projects = useData<{ projects: { id: string; label: string }[] }>('/ai/release-projects');
  const [edit, setEdit] = useState<AiProfile | 'new' | null>(null);
  const [agentEdit, setAgentEdit] = useState<{ llmId: string; agent: AgentUser | null } | null>(null);
  const empty = { name: '', provider: 'local' as 'local' | 'anthropic', baseUrl: '', model: '', apiKey: '', thinkingOff: false, projectScope: 'all' as 'all' | 'selected' | 'none', projectIds: [] as string[], personalScope: false, webSearch: false, contextTokens: '' };
  const [f, setF] = useState(empty);
  const [msg, setMsg] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  if (!st) return null;
  const open = (p: AiProfile | 'new') => { setEdit(p); setF(p === 'new' ? empty : { name: p.name, provider: p.provider, baseUrl: p.baseUrl ?? '', model: p.model, apiKey: '', thinkingOff: p.thinkingOff, projectScope: p.projectScope ?? 'all', projectIds: p.projectIds ?? [], personalScope: Boolean(p.personalScope), webSearch: Boolean(p.webSearch), contextTokens: p.contextTokens ? String(p.contextTokens) : '' }); };
  const label = (id: string) => projects.data?.projects.find((x) => x.id === id)?.label ?? '?';
  const scopeText = (p: AiProfile) => p.projectScope === 'selected' ? <span title={(p.projectIds ?? []).map(label).join(', ')}>{(p.projectIds ?? []).length} ausgewählte Projekte</span> : p.projectScope === 'none' ? <span className="muted">kein Projekt (nur Verbindungstest)</span> : <>alle Projekte{p.personalScope ? ' und persönliche' : ''}</>;
  const after = async (w?: string[]) => { await invalidateAi(); await agents.reload(); setWarnings(w ?? []); };
  const toggle = (a: AgentUser) => void (a.active
    ? dialog.confirm({ title: 'Agent deaktivieren', text: `${a.name} deaktivieren? Zuweisungen werden entfernt, Mitgliedschaften und Historie bleiben.`, confirmLabel: 'Deaktivieren', danger: true }).then((ok) => { if (ok) void run(async () => { const r = await api.patch<{ warnings?: string[] }>(`/agents/${a.id}`, { active: false }); await after(r.warnings); }); })
    : run(async () => { const r = await api.patch<{ warnings?: string[] }>(`/agents/${a.id}`, { active: true }); await after(r.warnings); }));
  const llmChoices = st.profiles.map((p) => ({ id: p.id, name: p.name, provider: p.provider, thinkingOff: p.thinkingOff }));
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>LLMs und ihre Agenten</h2><button className="btn primary sm" onClick={() => open('new')}>LLM anlegen</button></div>
      <p className="muted small">Ein LLM ist ein Modell mit Zugang: lokal mit OpenAI-kompatibler API (vLLM, Ollama, LM Studio) oder Anthropic. Jeder Agent gehört zu genau einem LLM und läuft nur in Projekten, für die sein LLM freigegeben ist.</p>
      {error && <div className="error mb">{error}</div>}
      {msg && <div className="success mb small">{msg}</div>}
      {warnings.length > 0 && <div className="notice mb small"><strong>Folgen:</strong><ul style={{ margin: '4px 0 0 16px' }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
      {st.profiles.length === 0 && <div className="empty mb">Noch kein LLM. Ohne LLM gibt es keine Agenten und damit keine KI.</div>}
      {st.profiles.map((p) => <section key={p.id} className="llm-block" style={p.active ? undefined : { opacity: 0.7 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div><strong>{p.name}</strong> {p.active ? <span className="badge ok">aktiv</span> : <span className="badge">inaktiv</span>}{!p.hasKey && p.provider === 'anthropic' && <span className="badge warn" style={{ marginLeft: 4 }}>kein Schlüssel</span>}
            <div className="muted small">{p.provider === 'local' ? 'Lokal' : 'Anthropic'} · {p.model}{p.baseUrl ? ` · ${p.baseUrl}` : ''} · {scopeText(p)} · {fmtTokens((p.tokensIn ?? 0) + (p.tokensOut ?? 0))}{p.lastUsedAt ? ` · zuletzt ${fmtDateTime(p.lastUsedAt)}` : ''}</div></div>
          <div className="nowrap"><button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ model: string; reply: string }>(`/ai/profiles/${p.id}/test`); setMsg(`${p.name}: ${r.model} antwortet „${r.reply}“.`); })}>Testen</button>{' '}
            <button className="btn sm" onClick={() => open(p)}>Bearbeiten</button>{' '}
            <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'LLM löschen', text: `„${p.name}“ löschen? Geht nur, wenn keine aktiven Agenten mehr daran hängen.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/ai/profiles/${p.id}`); await after(); }); })}>Löschen</button>{' '}
            <button className="btn primary sm" disabled={busy} onClick={() => setAgentEdit({ llmId: p.id, agent: null })}>Agent anlegen</button></div>
        </div>
        <AgentRows agents={(agents.data?.agents ?? []).filter((a) => a.aiProfileId === p.id)} busy={busy} orgBudget={st.agentDailyBudget} onEdit={(a) => setAgentEdit({ llmId: p.id, agent: a })} onToggle={toggle} />
      </section>)}
      {agentEdit && <AgentEditorModal agent={agentEdit.agent} llms={llmChoices} llmId={agentEdit.llmId} orgBudget={st.agentDailyBudget} scoped onClose={() => setAgentEdit(null)} onSaved={async (w) => { setAgentEdit(null); await after(w); }} />}
      {edit && (
        <Modal title={edit === 'new' ? 'LLM anlegen (Verwalter: Organisation)' : `LLM: ${edit.name}`} onClose={() => setEdit(null)}>
          <div className="form cols-2">
            <label className="field full"><span>Name</span><input type="text" value={f.name} autoFocus placeholder="z. B. Qwen3 auf der KI-VM" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field"><span>Anbieter</span><select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as any, model: '' })}><option value="local">Lokales LLM (OpenAI-kompatibel: vLLM, Ollama, LM Studio)</option><option value="anthropic">Anthropic (Claude)</option></select></label>
            {f.provider === 'local'
              ? <label className="field"><span>Adresse der API</span><input type="url" value={f.baseUrl} placeholder="http://llm.intern:8000/v1" onChange={(e) => setF({ ...f, baseUrl: e.target.value })} /><span className="muted small">vLLM: Port 8000, Pfad /v1 · Ollama: http://host:11434/v1</span></label>
              : <label className="field"><span>API-Schlüssel{edit !== 'new' && edit.hasKey && <span className="muted"> · gesetzt, leer = unverändert</span>}</span><input type="password" value={f.apiKey} autoComplete="new-password" placeholder="sk-ant-…" onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>}
            <label className="field"><span>Modell</span>{f.provider === 'local'
              ? <input type="text" value={f.model} placeholder="Name wie in vLLM/Ollama, z. B. Qwen/Qwen3-32B" onChange={(e) => setF({ ...f, model: e.target.value })} />
              : <select value={f.model || st.models[0]} onChange={(e) => setF({ ...f, model: e.target.value })}>{st.models.map((m) => <option key={m} value={m}>{m}</option>)}</select>}</label>
            {f.provider === 'local' && <label className="field"><span>Schlüssel (optional, Bearer)</span><input type="password" value={f.apiKey} autoComplete="new-password" placeholder="leer, wenn der Server keinen verlangt" onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>}
            {f.provider === 'local' && <div className="full stack" style={{ gap: 4 }}>
              <label className="check"><input type="checkbox" checked={f.thinkingOff} onChange={(e) => setF({ ...f, thinkingOff: e.target.checked })} /> Denkmodus aus <span className="muted small">(Modelle mit Thinking wie Qwen: schneller, weniger Token; sendet chat_template_kwargs.enable_thinking = false)</span></label>
              <label className="field" title="Kontextfenster des Modells; die Eingabe eines Agentenlaufs belegt höchstens 45 % davon, Überschüssiges wird gekürzt"><span>Kontextgröße in Token (leer = 32.000)</span><input type="number" min={4000} step={1000} value={f.contextTokens} placeholder="32000" onChange={(e) => setF({ ...f, contextTokens: e.target.value })} /></label>
            </div>}
            <label className="check full" title="Dazu braucht der Agent das Recht „Online-Recherche“; lokale LLMs brauchen einen Suchdienst (Grenzen und Vorgaben), Anthropic-LLMs suchen über das Server-Tool web_search"><input type="checkbox" checked={f.webSearch} onChange={(e) => setF({ ...f, webSearch: e.target.checked })} /> Online-Recherche mit diesem LLM erlaubt</label>
            <ScopeEditor scope={f.projectScope} projectIds={f.projectIds} onChange={(projectScope, projectIds) => setF({ ...f, projectScope, projectIds, personalScope: projectScope === 'all' && f.personalScope })} />
            {f.projectScope === 'all' && <label className="check full"><input type="checkbox" checked={f.personalScope} onChange={(e) => setF({ ...f, personalScope: e.target.checked })} /> auch in persönlichen Projekten <span className="muted small">(sonst sehen persönliche Projekte nur ihr eigenes LLM)</span></label>}
            {f.projectScope === 'selected' && <span className="muted small full">Persönliche Projekte stehen als „persönlich (Name)“ in der Liste und werden einzeln ausgewählt. Agenten mit diesem LLM laufen nur in den gewählten Projekten.</span>}
            {error && <div className="error full">{error}</div>}
            <div className="full row">
              <button className="btn primary" disabled={busy || !f.name.trim() || (f.provider === 'local' ? !f.baseUrl || !f.model : false)} onClick={() => void run(async () => { const body = { name: f.name, provider: f.provider, baseUrl: f.baseUrl || null, model: f.model || st.models[0], apiKey: f.apiKey || undefined, thinkingOff: f.thinkingOff, projectScope: f.projectScope, projectIds: f.projectIds, personalScope: f.personalScope, webSearch: f.webSearch, contextTokens: f.contextTokens ? Number(f.contextTokens) : null }; const r = edit === 'new' ? await api.post<{ warnings?: string[] }>('/ai/profiles', body) : await api.patch<{ warnings?: string[] }>(`/ai/profiles/${edit.id}`, body); setEdit(null); await after(r.warnings); })}>Speichern</button>
              {edit !== 'new' && <button className="btn" disabled={busy} onClick={() => void run(async () => { const r = await api.patch<{ warnings?: string[] }>(`/ai/profiles/${edit.id}`, { active: !edit.active }); setEdit(null); await after(r.warnings); })}>{edit.active ? 'Deaktivieren' : 'Aktivieren'}</button>}
              <button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Eigene LLMs der Projekte (die PL verwaltet sie und ihre Agenten): Metadaten, Verbrauch, sperren; Agenten nur (de)aktivieren. */
function ProjectLlmsCard() {
  const own = useData<{ llms: ProjectLlmRow[] }>('/ai/project-llms');
  const agents = useData<{ agents: AgentUser[] }>('/agents');
  const st = useAiStatus();
  const [warnings, setWarnings] = useState<string[]>([]);
  const { busy, error, run } = useAsync();
  if (!own.data || !own.data.llms.length) return null;
  return (
    <div className="card">
      <h2>Eigene LLMs der Projekte</h2>
      <p className="muted small">Bindet die PL ein, wenn es unten erlaubt ist; sie legt daran auch die Agenten an. Du siehst Metadaten und Verbrauch, nicht Schlüssel oder Inhalte, und kannst LLM oder Agenten sperren.</p>
      {error && <div className="error mb">{error}</div>}
      {warnings.length > 0 && <div className="notice mb small"><ul style={{ margin: '0 0 0 16px' }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
      {own.data.llms.map((l) => <section key={l.id} className="llm-block" style={l.adminBlocked || !l.active ? { opacity: 0.7 } : undefined}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div><strong>{l.name}</strong> {l.adminBlocked ? <span className="badge danger">gesperrt</span> : l.active ? <span className="badge ok">aktiv</span> : <span className="badge">inaktiv</span>}
            <div className="muted small">Projekt {l.project} · von {l.createdBy ?? '–'} · {l.provider === 'local' ? 'Lokal' : 'Anthropic'} · {l.model} · {fmtTokens(l.tokensIn + l.tokensOut)}{l.lastUsedAt ? ` · zuletzt ${fmtDateTime(l.lastUsedAt)}` : ' · nie genutzt'}</div></div>
          <button className={`btn sm ${l.adminBlocked ? '' : 'danger'}`} disabled={busy} onClick={() => void run(async () => { const r = await api.patch<{ warnings?: string[] }>(`/ai/profiles/${l.id}`, { adminBlocked: !l.adminBlocked }); setWarnings(r.warnings ?? []); await own.reload(); })}>{l.adminBlocked ? 'Entsperren' : 'Sperren'}</button>
        </div>
        <AgentRows agents={(agents.data?.agents ?? []).filter((a) => a.aiProfileId === l.id)} busy={busy} orgBudget={st?.agentDailyBudget ?? 50} onToggle={(a) => void run(async () => { await api.patch(`/agents/${a.id}`, { active: !a.active }); await agents.reload(); })} />
      </section>)}
    </div>
  );
}

/** Notaus, Tagesbudget je Agent (Obergrenze), eigene LLMs der Projekte, Online-Recherche. */
function LimitsCard() {
  const st = useAiStatus();
  const [budget, setBudget] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  if (!st) return null;
  const saved = async (m: string) => { await invalidateAi(); setMsg(m); };
  return (
    <div className="card">
      <h2>Grenzen und Vorgaben</h2>
      {error && <div className="error mb">{error}</div>}
      {msg && <div className="success mb small">{msg}</div>}
      <div className="row mb"><span className={st.killswitch ? 'badge danger' : 'badge ok'}>{st.killswitch ? 'Notaus aktiv: alle KI aus' : 'KI eingeschaltet'}</span>
        <button className={`btn sm ${st.killswitch ? '' : 'danger'}`} disabled={busy} onClick={() => void (st.killswitch ? run(async () => { await api.put('/ai/settings', { enabled: true }); await saved('KI wieder eingeschaltet.'); })
          : dialog.confirm({ title: 'Notaus', text: 'Alle KI im Mandanten sofort abschalten? Agenten laufen nicht, Assistenz und Verbindungstests sind gesperrt.', confirmLabel: 'Abschalten', danger: true }).then((ok) => { if (ok) void run(async () => { await api.put('/ai/settings', { enabled: false }); await saved('Notaus aktiv.'); }); }))}>{st.killswitch ? 'Wieder einschalten' : 'Notaus'}</button></div>
      <div className="row small"><span className="muted" title="Obergrenze je Agent; der Verwalter des LLM setzt je Agent weniger. 0 = Agenten laufen nicht.">Tagesbudget je Agent höchstens (Läufe):</span><input type="number" min={0} max={1000} value={budget ?? st.agentDailyBudget} onChange={(e) => setBudget(Number(e.target.value))} style={{ width: 90 }} /><button className="btn sm" disabled={busy || budget == null} onClick={() => void run(async () => { await api.put('/ai/settings', { agentDailyBudget: budget }); setBudget(null); await saved('Budget gespeichert.'); })}>Speichern</button></div>
      <label className="field mt"><span>Eigenes LLM in Projekten (verwaltet dann die PL, samt Agenten daran)</span><select value={st.ownLlm ?? 'personal'} disabled={busy} style={{ width: 'auto' }} onChange={(e) => void run(async () => { await api.put('/ai/settings', { ownLlm: e.target.value }); await saved('Gespeichert.'); })}><option value="off">nicht erlaubt</option><option value="personal">nur in persönlichen Projekten</option><option value="all">in allen Projekten</option></select></label>
      <WebSearchForm st={st} onSaved={() => saved('Einstellungen gespeichert.')} />
    </div>
  );
}

/** Online-Recherche (Konzept 8): Suchdienst für lokale Profile, Grenzen, Domains. */
function WebSearchForm({ st, onSaved }: { st: NonNullable<ReturnType<typeof useAiStatus>>; onSaved: () => Promise<void> }) {
  const w = st.web ?? {};
  const [f, setF] = useState({ provider: w.provider ?? 'none', url: w.url ?? '', apiKey: '', maxPerRun: w.maxPerRun ?? 5, dailyPerAgent: w.dailyPerAgent ?? 20, allowed: (w.allowedDomains ?? []).join(', '), blocked: (w.blockedDomains ?? []).join(', ') });
  const { busy, error, run } = useAsync();
  const list = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  return <>
    <h3 className="mt">Online-Recherche</h3>
    <p className="muted small">Beim Anlegen eines Agenten aus: freigegeben wird über das Recht „Online-Recherche“ am Agenten und das Häkchen am LLM. Anthropic-Profile suchen über das Server-Tool web_search (Kosten je Suche laut Preisliste); lokale Profile brauchen SearXNG (eigener Dienst) oder die Brave Search API. Nur lesen, Quellen werden gespeichert und Seiten als Abschnitt „Quellen“ angehängt; Suchbegriffe ohne Namen, Adressen und Interna.</p>
    <div className="form cols-2">
      <label className="field"><span>Suchdienst für lokale Profile</span><select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as 'none' | 'searxng' | 'brave' })}><option value="none">keiner (nur Anthropic-Profile recherchieren)</option><option value="searxng">SearXNG (eigene Instanz)</option><option value="brave">Brave Search API</option></select></label>
      {f.provider === 'searxng' && <label className="field"><span>SearXNG-Adresse</span><input type="url" value={f.url} placeholder="https://searx.firma.local" onChange={(e) => setF({ ...f, url: e.target.value })} /></label>}
      {f.provider === 'brave' && <label className="field"><span>Brave-Schlüssel {w.hasKey && <span className="muted">(gesetzt; leer lassen = behalten)</span>}</span><input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>}
      <label className="field"><span>Suchen je Lauf (höchstens 20)</span><input type="number" min={1} max={20} value={f.maxPerRun} onChange={(e) => setF({ ...f, maxPerRun: Number(e.target.value) })} /></label>
      <label className="field"><span>Suchen je Agent und Tag</span><input type="number" min={0} max={500} value={f.dailyPerAgent} onChange={(e) => setF({ ...f, dailyPerAgent: Number(e.target.value) })} /></label>
      <label className="field"><span>Nur diese Domains (Komma)</span><input type="text" value={f.allowed} placeholder="leer = alle" onChange={(e) => setF({ ...f, allowed: e.target.value, blocked: e.target.value ? '' : f.blocked })} /></label>
      <label className="field"><span>Gesperrte Domains (Komma)</span><input type="text" value={f.blocked} disabled={Boolean(f.allowed)} onChange={(e) => setF({ ...f, blocked: e.target.value })} /></label>
      <div className="full"><button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.put('/ai/settings', { web: { provider: f.provider, url: f.url || null, ...(f.apiKey ? { apiKey: f.apiKey } : {}), maxPerRun: f.maxPerRun, dailyPerAgent: f.dailyPerAgent, allowedDomains: list(f.allowed), blockedDomains: list(f.blocked) } }); setF({ ...f, apiKey: '' }); await onSaved(); })}>Speichern</button></div>
    </div>
  </>;
}


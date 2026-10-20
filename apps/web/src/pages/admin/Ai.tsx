import { useEffect, useState } from 'react';
import { AI_CATEGORIES, AI_FEATURES, type AgentUser, type AiDecision, type AiPolicyRule, type AiProfile } from '@projekttool/shared';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync, useDialog } from '../../components/ui';
import { invalidateAi, useAiStatus } from '../../lib/useAi';
import { AgentPolicyEditor } from '../../components/AgentPolicy';

/** KI-Profile je Mandant: Anbieter (lokales LLM oder Anthropic), Adresse, Modell, Schlüssel; Agenten und Projekte bekommen je eines zugewiesen. */
/** Verwaltung › KI: vier Karten nach Konzept LLM/Agenten 3.1 – LLMs, Agenten, Freigaben, Grenzen und Vorgaben. */
export function AiSection() {
  return (
    <div id="ki">
      <div className="card"><h2 style={{ margin: 0 }}>KI</h2>
        <p className="muted small" style={{ marginBottom: 0 }}>LLMs und Agenten haben je einen <strong>Verwalter</strong> (Organisation oder ein Projekt) und einen <strong>Einsatz</strong> (alle Projekte, ausgewählte, nur das eigene). Ein Agent läuft nur in Projekten, die sein Einsatz umfasst und in denen sein LLM freigegeben ist. Die Freigaben sperren, die Grenzen begrenzen. Konzept: docs/Konzept-LLM-Agenten-Einsatz.md. Außenprüfung und Arbeitszeitfenster für Mails nach außen stehen unter <Link to="/verwaltung/mail">Mail</Link>.</p>
      </div>
      <LlmsCard />
      <AgentsCard />
      <AiPolicyCard />
      <LimitsCard />
    </div>
  );
}

type ProjectLlmRow = { id: string; name: string; provider: string; model: string; baseUrl: string | null; active: boolean; adminBlocked: boolean; tokensIn: number; tokensOut: number; lastUsedAt: string | null; project: string; createdBy: string | null };

const fmtTokens = (n: number) => `${n.toLocaleString('de-DE')} Token`;

/** LLMs: Org-LLMs (anlegen, Einsatz, Standard) und Projekt-LLMs (sperren) in einer Tabelle mit Verwalter und Einsatz. */
function LlmsCard() {
  const st = useAiStatus();
  const own = useData<{ llms: ProjectLlmRow[] }>('/ai/project-llms');
  const projects = useData<{ projects: { id: string; label: string }[] }>('/ai/release-projects');
  const [edit, setEdit] = useState<AiProfile | 'new' | null>(null);
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
  const after = async (w?: string[]) => { await invalidateAi(); await own.reload(); setWarnings(w ?? []); };
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>LLMs</h2><button className="btn primary sm" onClick={() => open('new')}>LLM anlegen</button></div>
      <p className="muted small">Ein LLM ist ein Modell mit Zugang: lokal mit OpenAI-kompatibler API (vLLM, Ollama, LM Studio) oder Anthropic. <strong>Verwalter</strong> Organisation: du legst es an und bestimmst den Einsatz. Verwalter Projekt: die PL hat es eingebunden (nur dort nutzbar), du siehst Metadaten und Verbrauch und kannst es sperren. Das <strong>Standard-LLM</strong> gilt für Agenten ohne eigenes LLM.</p>
      {error && <div className="error mb">{error}</div>}
      {msg && <div className="success mb small">{msg}</div>}
      {warnings.length > 0 && <div className="notice mb small"><strong>Folgen:</strong><ul style={{ margin: '4px 0 0 16px' }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
      {st.profiles.length === 0 && (own.data?.llms.length ?? 0) === 0 && <div className="empty mb">Noch kein LLM. Ohne LLM ist KI für den Mandanten aus.</div>}
      {(st.profiles.length > 0 || (own.data?.llms.length ?? 0) > 0) && <table className="table mb"><thead><tr><th>Name</th><th>Verwalter</th><th>Einsatz</th><th>Anbieter · Modell</th><th>Status · Verbrauch</th><th /></tr></thead><tbody>
        {st.profiles.map((p) => <tr key={p.id} style={p.active ? undefined : { opacity: 0.6 }}>
          <td>{p.name}{st.defaultProfileId === p.id && <span className="badge ok" style={{ marginLeft: 6 }} title="Gilt für Agenten ohne eigenes LLM">Standard</span>}</td>
          <td className="small">Organisation</td>
          <td className="small">{scopeText(p)}</td>
          <td className="small">{p.provider === 'local' ? 'Lokal' : 'Anthropic'}<div className="muted">{p.model}{p.baseUrl ? ` · ${p.baseUrl}` : ''}</div></td>
          <td className="small">{p.active ? <span className="badge ok">aktiv</span> : <span className="badge">inaktiv</span>}{!p.hasKey && p.provider === 'anthropic' && <span className="badge warn" style={{ marginLeft: 4 }}>kein Schlüssel</span>}<div className="muted">{fmtTokens((p.tokensIn ?? 0) + (p.tokensOut ?? 0))}{p.lastUsedAt ? ` · ${fmtDateTime(p.lastUsedAt)}` : ''}</div></td>
          <td className="nowrap"><button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ model: string; reply: string }>(`/ai/profiles/${p.id}/test`); setMsg(`${p.name}: ${r.model} antwortet „${r.reply}“.`); })}>Testen</button>{' '}
            <button className="btn sm" onClick={() => open(p)}>Bearbeiten</button>{' '}
            {st.defaultProfileId !== p.id && <><button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.put('/ai/settings', { defaultProfileId: p.id }); await after(); })}>Als Standard</button>{' '}</>}
            <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'LLM löschen', text: `„${p.name}“ löschen? Agenten und Projekte, die es nutzen, verlieren ihre KI, bis ein anderes LLM zugewiesen ist.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/ai/profiles/${p.id}`); await after(); }); })}>Löschen</button></td></tr>)}
        {(own.data?.llms ?? []).map((l) => <tr key={l.id} style={l.adminBlocked || !l.active ? { opacity: 0.6 } : undefined}>
          <td>{l.name}</td>
          <td className="small">Projekt {l.project}<div className="muted">von {l.createdBy ?? '–'}</div></td>
          <td className="small">nur dieses Projekt</td>
          <td className="small">{l.provider === 'local' ? 'Lokal' : 'Anthropic'}<div className="muted">{l.model}{l.baseUrl ? ` · ${l.baseUrl}` : ''}</div></td>
          <td className="small">{l.adminBlocked ? <span className="badge danger">gesperrt</span> : l.active ? <span className="badge ok">aktiv</span> : <span className="badge">inaktiv</span>}<div className="muted">{fmtTokens(l.tokensIn + l.tokensOut)}{l.lastUsedAt ? ` · ${fmtDateTime(l.lastUsedAt)}` : ' · nie genutzt'}</div></td>
          <td className="nowrap"><button className={`btn sm ${l.adminBlocked ? '' : 'danger'}`} disabled={busy} onClick={() => void run(async () => { const r = await api.patch<{ warnings?: string[] }>(`/ai/profiles/${l.id}`, { adminBlocked: !l.adminBlocked }); await after(r.warnings); })}>{l.adminBlocked ? 'Entsperren' : 'Sperren'}</button></td></tr>)}
      </tbody></table>}
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
            <label className="check full" title="Dazu muss die KI-Freigabe „Online-Recherche“ (agent.web) erlauben; lokale LLMs brauchen einen Suchdienst (Grenzen und Vorgaben), Anthropic-Profile suchen über das Server-Tool web_search"><input type="checkbox" checked={f.webSearch} onChange={(e) => setF({ ...f, webSearch: e.target.checked })} /> Online-Recherche mit diesem LLM erlaubt</label>
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

/** Grenzen und Vorgaben: Budgets, Außenprüfung, Rechte der PL (eigene LLMs und Agenten), Agenten-Policy, Online-Recherche, Arbeitszeitfenster. */
function LimitsCard() {
  const st = useAiStatus();
  const [budget, setBudget] = useState<number | null>(null);
  const [assist, setAssist] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useAsync();
  if (!st) return null;
  return (
    <div className="card">
      <h2>Grenzen und Vorgaben</h2>
      {error && <div className="error mb">{error}</div>}
      {msg && <div className="success mb small">{msg}</div>}
      <h3>Budgets</h3>
      <div className="row small"><span className="muted" title="0 = Agenten laufen nicht; gezählt werden ausgeführte Läufe (auch mit Fehler)">Tagesbudget je Agent (Läufe, 0 = keine):</span><input type="number" min={0} max={1000} value={budget ?? st.agentDailyBudget} onChange={(e) => setBudget(Number(e.target.value))} style={{ width: 90 }} /><button className="btn sm" disabled={busy || budget == null} onClick={() => void run(async () => { await api.put('/ai/settings', { agentDailyBudget: budget }); setBudget(null); await invalidateAi(); setMsg('Budget gespeichert.'); })}>Speichern</button></div>
      <div className="row small mt"><span className="muted" title="Zusammenfassen, Essenz, Statusbericht, Frage ans Projekt, Abschluss-Antwort; 0 = keine">Tagesbudget KI-Assistenz je Projekt (Anfragen, 0 = keine):</span><input type="number" min={0} max={10000} value={assist ?? st.assistDailyBudget ?? 200} onChange={(e) => setAssist(Number(e.target.value))} style={{ width: 90 }} /><button className="btn sm" disabled={busy || assist == null} onClick={() => void run(async () => { await api.put('/ai/settings', { assistDailyBudget: assist }); setAssist(null); await invalidateAi(); setMsg('Budget gespeichert.'); })}>Speichern</button></div>
      <h3 className="mt">Was die Projektleitung selbst darf</h3>
      <PlAgentPolicy st={st} onSaved={async () => { await invalidateAi(); setMsg('Einstellungen gespeichert.'); }} />
      <h3 className="mt">Agenten-Policy des Mandanten</h3>
      <p className="muted small">Vorgabe für alle Projekte: Selbstständigkeit (ohne Angabe „Rückfrage bei wichtigen Schritten“; Bestandsprojekte stehen auf „Selbstständig“) und Grenzen, die kein Projekt unterschreiten kann. Die PL stellt je Projekt, Agent und Arbeitspaket weiter ein; gesperrte Klassen regeln die KI-Freigaben.</p>
      <AgentPolicyEditor value={st.agentPolicy ?? {}} limits workflows inheritFrom="Standard" onSave={async (v) => { await api.put('/ai/settings', { agentPolicy: v }); await invalidateAi(); setMsg('Agenten-Policy gespeichert.'); }} />
      <WebSearchForm st={st} onSaved={async () => { await invalidateAi(); setMsg('Einstellungen gespeichert.'); }} />
    </div>
  );
}

/** Eigene LLMs der Projekte und höchstes Tagesbudget eigener Agenten der PL (nie über dem Mandantenwert); ob PL Agenten anlegen dürfen, regeln die KI-Freigaben. */
/** Online-Recherche (Konzept 8): Suchdienst für lokale Profile, Grenzen, Domains. */
function WebSearchForm({ st, onSaved }: { st: NonNullable<ReturnType<typeof useAiStatus>>; onSaved: () => Promise<void> }) {
  const w = st.web ?? {};
  const [f, setF] = useState({ provider: w.provider ?? 'none', url: w.url ?? '', apiKey: '', maxPerRun: w.maxPerRun ?? 5, dailyPerAgent: w.dailyPerAgent ?? 20, allowed: (w.allowedDomains ?? []).join(', '), blocked: (w.blockedDomains ?? []).join(', ') });
  const { busy, error, run } = useAsync();
  const list = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  return <>
    <h3 className="mt">Online-Recherche</h3>
    <p className="muted small">Standardmäßig gesperrt: freigegeben wird über die KI-Freigabe „Online-Recherche“ (agent.web) je Mandant, Projekt oder Agent und das Häkchen am Profil. Anthropic-Profile suchen über das Server-Tool web_search (Kosten je Suche laut Preisliste); lokale Profile brauchen SearXNG (eigener Dienst) oder die Brave Search API. Nur lesen, Quellen werden gespeichert und Seiten als Abschnitt „Quellen“ angehängt; Suchbegriffe ohne Namen, Adressen und Interna.</p>
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

function PlAgentPolicy({ st, onSaved }: { st: NonNullable<ReturnType<typeof useAiStatus>>; onSaved: () => Promise<void> }) {
  const cur = { maxBudget: st.plAgents?.maxBudget ?? 20, ownLlm: st.ownLlm ?? 'personal' };
  const [f, setF] = useState<typeof cur | null>(null);
  const v = f ?? cur;
  const { busy, error, run } = useAsync();
  return (
    <div className="mt" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <label className="field"><span>Eigenes LLM in Projekten einbinden (durch die PL)</span><select value={v.ownLlm} onChange={(e) => setF({ ...v, ownLlm: e.target.value as any })} style={{ width: 'auto' }}><option value="off">nicht erlaubt</option><option value="personal">nur in persönlichen Projekten</option><option value="all">in allen Projekten</option></select></label>
      <div className="small mt">
        <div className="row"><span className="muted">Eigene Agenten der PL ({st.plAgents?.enabled ? 'erlaubt' : 'gesperrt'}, Regel unter KI-Freigaben), höchstes Tagesbudget je Agent:</span><input type="number" min={0} max={st.agentDailyBudget} value={v.maxBudget} onChange={(e) => setF({ ...v, maxBudget: Number(e.target.value) })} style={{ width: 90 }} /><span className="muted">(Mandant: {st.agentDailyBudget})</span></div>
        <p className="muted">Eigene Agenten laufen auf den im Projekt verfügbaren LLMs (Freigabe je Profil oben, eigenes LLM des Projekts). Sie gehören zum Projekt: nur dort einsetzbar, Chat nur für Mitglieder. Du siehst sie unten und kannst sie deaktivieren, aber nicht ihre Inhalte oder Läufe.</p>
      </div>
      {error && <div className="error small">{error}</div>}
      <button className="btn sm mt" disabled={busy || !f} onClick={() => void run(async () => { await api.put('/ai/settings', { plAgents: { maxBudget: v.maxBudget }, ownLlm: v.ownLlm }); setF(null); await onSaved(); })}>Speichern</button>
    </div>
  );
}

/** Einsatz eines LLM (alle, ausgewählte, keins) bzw. eines Agenten (alle, ausgewählte) in Projekten. */
export function ScopeEditor({ scope, projectIds, onChange, agent = false }: { scope: 'all' | 'selected' | 'none'; projectIds: string[]; onChange: (scope: 'all' | 'selected' | 'none', projectIds: string[]) => void; agent?: boolean }) {
  const projects = useData<{ projects: { id: string; label: string }[] }>(scope === 'selected' ? '/ai/release-projects' : null, [scope]);
  return (
    <div className="full stack" style={{ gap: 4 }}>
      <label className="field"><span>Einsatz</span><select value={scope} onChange={(e) => onChange(e.target.value as any, projectIds)}><option value="all">alle Projekte</option><option value="selected">ausgewählte Projekte</option>{!agent && <option value="none">kein Projekt (nur Verbindungstest; Agenten damit laufen nirgends)</option>}</select></label>
      {scope === 'selected' && <div className="row small" style={{ flexWrap: 'wrap' }}>{(projects.data?.projects ?? []).map((p) => <label key={p.id} className="check"><input type="checkbox" checked={projectIds.includes(p.id)} onChange={(e) => onChange(scope, e.target.checked ? [...projectIds, p.id] : projectIds.filter((x) => x !== p.id))} /> {p.label}</label>)}{projects.data && projects.data.projects.length === 0 && <span className="muted">keine aktiven Projekte</span>}</div>}
    </div>
  );
}

/** Denkmodus je Agent: wie Profil, aus oder an; wirkt nur bei lokalen Modellen. */
function ThinkingSelect({ agent, profile, disabled, onChange }: { agent: AgentUser; profile: AiProfile | null; disabled: boolean; onChange: (v: 'off' | 'on' | null) => void }) {
  const local = profile?.provider === 'local';
  return (
    <select className="mt" style={{ display: 'block' }} value={agent.thinkingMode ?? ''} disabled={disabled || !local} title={local ? 'Denkmodus des Modells für diesen Agenten' : 'Nur bei lokalen Modellen'} onChange={(e) => onChange((e.target.value || null) as 'off' | 'on' | null)}>
      <option value="">Denken: wie Profil ({profile?.thinkingOff ? 'aus' : 'Standard'})</option>
      <option value="off">Denken: aus</option>
      <option value="on">Denken: an</option>
    </select>
  );
}

/** Tagesbudget eines Org-Agenten (Läufe): leer = Mandantenwert; wirksam ist das Minimum aus beidem. */
function BudgetField({ value, orgBudget, disabled, onSave }: { value: number | null | undefined; orgBudget: number; disabled: boolean; onSave: (v: number | null) => void }) {
  const [v, setV] = useState(value == null ? '' : String(value));
  useEffect(() => setV(value == null ? '' : String(value)), [value]);
  return <label className="row small mt" style={{ gap: 4 }} title="Läufe je Tag für diesen Agenten; leer = Tagesbudget des Mandanten, höchstens dieses">Budget/Tag
    <input type="number" min={0} max={1000} value={v} disabled={disabled} placeholder={`${orgBudget} (Mandant)`} style={{ width: 90 }} onChange={(e) => setV(e.target.value)}
      onBlur={() => { const n = v === '' ? null : Number(v); if (n !== (value ?? null)) onSave(n); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>;
}

/** Persona eines Agenten: eine Zeile, Speichern beim Verlassen oder mit Enter, Escape verwirft. */
function PersonaField({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input type="text" maxLength={300} value={v} disabled={disabled} style={{ width: '100%' }} placeholder="z. B. freundlich, knapp, duzt das Team" title="Persona: beschreibt den Schreibstil des Agenten (Log, Mails, Doku, Chat)"
    onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== value) onSave(v.trim()); }}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value); (e.target as HTMLInputElement).blur(); } }} />;
}

/** Unterschrift für Mails des Agenten: frei, mehrzeilig; leer = „Name (KI-Agent, Projekt KEY)“. */
function SignatureField({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <details className="small" style={{ marginTop: 4 }}><summary className="muted">{value ? 'Unterschrift: eigene' : 'Unterschrift: Standard'}</summary>
    <textarea rows={3} maxLength={500} value={v} disabled={disabled} style={{ width: '100%', minHeight: 64 }} placeholder={'leer = „Name (KI-Agent, Projekt KEY)“\nz. B. Viele Grüße\nMorton, Assistenz von Philipp Schwarz'} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== value) onSave(v.trim()); }} /></details>;
}

/** KI-Agenten: Verwalter (Organisation oder Projekt), LLM, Einsatz und Projekte mit Einsetzbarkeit; Org-Agenten legt die KI-Verwaltung an. */
function AgentsCard() {
  const d = useData<{ agents: AgentUser[] }>('/agents');
  const st = useAiStatus();
  const projects = useData<{ projects: { id: string; label: string }[] }>('/ai/release-projects');
  const empty = { name: '', persona: '', aiProfileId: '', scope: 'all' as 'all' | 'selected', projectIds: [] as string[] };
  const [edit, setEdit] = useState<AgentUser | 'new' | null>(null);
  const [f, setF] = useState(empty);
  const [warnings, setWarnings] = useState<string[]>([]);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  const label = (id: string) => projects.data?.projects.find((x) => x.id === id)?.label ?? '?';
  const open = (a: AgentUser | 'new') => { setEdit(a); setF(a === 'new' ? empty : { name: a.name, persona: a.persona ?? '', aiProfileId: a.aiProfileId ?? '', scope: a.scope === 'selected' ? 'selected' : 'all', projectIds: a.projectIds ?? [] }); };
  const save = (id: string, body: Record<string, unknown>) => run(async () => { const r = await api.patch<{ warnings?: string[] }>(`/agents/${id}`, body); setWarnings(r.warnings ?? []); await d.reload(); });
  const scopeText = (a: AgentUser) => a.scope === 'project' ? `nur ${a.projectBound?.label ?? 'eigenes Projekt'}` : a.scope === 'selected' ? <span title={(a.projectIds ?? []).map(label).join(', ')}>{(a.projectIds ?? []).length} ausgewählte Projekte</span> : 'alle Projekte';
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>KI-Agenten</h2><button className="btn primary sm" onClick={() => open('new')}>Agent anlegen</button></div>
      <p className="muted small">Ein Agent ist ein Benutzer ohne Login: nie verantwortliche PL oder Org-Admin. Die PL nimmt ihn als Mitglied oder stellvertretende PL ins Projekt und macht ihn zuständig; er handelt im Rahmen der KI-Freigaben und der Agenten-Policy. <strong>Verwalter</strong> Organisation: du gestaltest ihn (Name, Persona, LLM, Einsatz). Verwalter Projekt: die PL hat ihn angelegt, du kannst ihn nur deaktivieren. Er läuft nur in Projekten, die sein Einsatz umfasst und in denen sein LLM freigegeben ist; wo nicht, steht der Grund bei den Projekten.</p>
      {error && <div className="error mb">{error}</div>}
      {warnings.length > 0 && <div className="notice mb small"><strong>Folgen:</strong><ul style={{ margin: '4px 0 0 16px' }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
      {d.data && d.data.agents.length === 0 && <div className="empty mb">Noch kein Agent.</div>}
      {d.data && d.data.agents.length > 0 && <table className="table mb"><thead><tr><th>Name</th><th>Verwalter</th><th>LLM</th><th>Einsatz</th><th>Projekte</th><th>Läufe</th><th /></tr></thead><tbody>
        {d.data.agents.map((a) => <tr key={a.id} style={a.active ? undefined : { opacity: 0.6 }}>
          <td>{a.name}{!a.active && <span className="badge" style={{ marginLeft: 6 }}>deaktiviert</span>}<div className="muted small">{a.persona ?? 'Standardstil'}</div>
            {!a.projectBound && <>
              <PersonaField value={a.persona ?? ''} disabled={busy} onSave={(persona) => void save(a.id, { persona: persona || null })} />
              <SignatureField value={a.signature ?? ''} disabled={busy} onSave={(signature) => void save(a.id, { signature: signature || null })} />
            </>}</td>
          <td className="small">{a.projectBound ? <>Projekt {a.projectBound.label}</> : 'Organisation'}</td>
          <td className="small">{a.projectBound ? (a.profileName ?? '–') : <>
            <select value={a.aiProfileId ?? ''} disabled={busy} onChange={(e) => void save(a.id, { aiProfileId: e.target.value || null })}><option value="">Standard{st?.defaultProfileId ? ` (${st.profiles.find((p) => p.id === st.defaultProfileId)?.name ?? ''})` : ' (keins)'}</option>{(st?.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <ThinkingSelect agent={a} profile={st?.profiles.find((p) => p.id === (a.aiProfileId ?? st?.defaultProfileId)) ?? null} disabled={busy} onChange={(thinkingMode) => void save(a.id, { thinkingMode })} />
            <BudgetField value={a.dailyBudget} orgBudget={st?.agentDailyBudget ?? 50} disabled={busy} onSave={(dailyBudget) => void save(a.id, { dailyBudget })} /></>}</td>
          <td className="small">{scopeText(a)}</td>
          <td className="small">{a.projects.length === 0 ? <span className="muted">–</span> : a.projects.map((p) => <span key={p.id} className={`badge ${p.usable === false ? 'warn' : ''}`} style={{ marginRight: 4 }} title={p.usable === false ? p.reason ?? '' : `${p.name}: läuft`}>{p.key}{p.usable === false ? ' ⚠' : ''}</span>)}</td>
          <td className="small">{a.runs}{a.lastRunAt && <div className="muted">{fmtDateTime(a.lastRunAt)}</div>}</td>
          <td className="nowrap">{!a.projectBound && <><button className="btn sm" disabled={busy} onClick={() => open(a)}>Bearbeiten</button>{' '}</>}
            {a.active ? <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Agent deaktivieren', text: `${a.name} deaktivieren? Zuweisungen werden entfernt, Mitgliedschaften und Historie bleiben.`, confirmLabel: 'Deaktivieren', danger: true }).then((ok) => { if (ok) void save(a.id, { active: false }); })}>Deaktivieren</button>
              : <button className="btn sm" disabled={busy} onClick={() => void save(a.id, { active: true })}>Aktivieren</button>}</td></tr>)}
      </tbody></table>}
      {edit && (
        <Modal title={edit === 'new' ? 'Agent anlegen (Verwalter: Organisation)' : `Agent: ${edit.name}`} onClose={() => setEdit(null)}>
          <div className="form">
            <label className="field"><span>Name</span><input type="text" value={f.name} autoFocus maxLength={80} placeholder="z. B. Nachfasser" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field"><span>Persona (Schreibstil, eine Zeile)</span><input type="text" value={f.persona} maxLength={300} placeholder="z. B. freundlich, knapp, duzt das Team" onChange={(e) => setF({ ...f, persona: e.target.value })} /></label>
            <label className="field"><span>LLM</span><select value={f.aiProfileId} onChange={(e) => setF({ ...f, aiProfileId: e.target.value })}><option value="">Standard{st?.defaultProfileId ? ` (${st.profiles.find((p) => p.id === st.defaultProfileId)?.name ?? ''})` : ' (keins)'}</option>{(st?.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><span className="muted small">Der Agent läuft nur in Projekten, in denen sein LLM freigegeben ist (Einsatz des LLM).</span></label>
            <ScopeEditor agent scope={f.scope} projectIds={f.projectIds} onChange={(scope, projectIds) => setF({ ...f, scope: scope === 'selected' ? 'selected' : 'all', projectIds })} />
            {error && <div className="error">{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={busy || !f.name.trim()} onClick={() => void run(async () => { const body = { name: f.name, persona: f.persona.trim() || null, aiProfileId: f.aiProfileId || null, scope: f.scope, projectIds: f.scope === 'selected' ? f.projectIds : [] }; const r = edit === 'new' ? await api.post<{ warnings?: string[] }>('/agents', body) : await api.patch<{ warnings?: string[] }>(`/agents/${edit.id}`, body); setWarnings(r.warnings ?? []); setEdit(null); await d.reload(); })}>Speichern</button>
              <button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

type PolicyListing = { rules: AiPolicyRule[]; killswitch: boolean; stoppedAgents: { id: string; name: string; projectId: string; projectLabel: string; createdById: string | null; createdByName: string | null; reason: string }[] };

type PolicyTargets = { projects: { id: string; label: string }[]; users: { id: string; name: string; email: string }[]; agents: { id: string; name: string }[]; groups: { id: string; name: string }[] };

type PolicyRow = { projectId: string | null; userId: string | null; groupId: string | null };

type RowKind = 'org' | 'group' | 'project' | 'user' | 'agent' | 'exception';

const ROW_SECTIONS: { kind: RowKind; label: string; hint: string }[] = [
  { kind: 'org', label: 'Mandant', hint: 'alle Personen und Agenten in allen Projekten' },
  { kind: 'group', label: 'Gruppen', hint: 'Mitglieder der Gruppe in allen Projekten' },
  { kind: 'project', label: 'Projekte', hint: 'alle Personen und Agenten im Projekt, auch Agenten der Org' },
  { kind: 'user', label: 'Benutzer', hint: 'eigene Nutzung der Person in allen Projekten' },
  { kind: 'agent', label: 'Agenten', hint: 'Läufe, Chat und Mail-Ansichten des Agenten in allen Projekten (für ein Projekt: Ausnahmen)' },
  { kind: 'exception', label: 'Ausnahmen', hint: 'Person, Agent oder Gruppe in einem Projekt: übersteuert Person bzw. Agent und Projekt, nicht den Notaus' }
];

const STAGE_LABEL: Record<string, string> = { killswitch: 'Notaus', policy: 'Regeln', project: 'Ebene der PL', profile: 'Profil', budget: 'Budget', ok: '' };

const rowKey = (r: PolicyRow) => `${r.projectId ?? ''}|${r.userId ?? ''}|${r.groupId ?? ''}`;

/**
 * KI-Freigaben (ersetzt den Schalter für eigene Agenten der PL): roter Notaus; Matrix mit den Zeilen Mandant, Gruppen,
 * Projekte, Benutzer, Agenten und Ausnahmen und den Spalten Kategorien bzw. Funktionen, jede Zelle erben, erlauben oder
 * sperren mit Notiz; Vorschau der Wirkung für eine Person oder einen Agenten in einem Projekt mit Spur. Sperre gewinnt;
 * eine Ausnahme gibt es nur über „Person in Projekt“; die PL kann im Projekt weiter einschränken.
 */
export function AiPolicyCard() {
  const d = useData<PolicyListing>('/ai/policies');
  const tg = useData<PolicyTargets>('/ai/policy-targets');
  const [detailed, setDetailed] = useState(false);
  const [added, setAdded] = useState<PolicyRow[]>([]);
  const [add, setAdd] = useState<{ kind: RowKind; target: string; projectId: string }>({ kind: 'project', target: '', projectId: '' });
  const [cell, setCell] = useState<{ row: PolicyRow; label: string; feature: string; effect: 'allow' | 'deny' | null; note: string } | null>(null);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  if (!d.data || !tg.data) return null;
  const { rules, killswitch, stoppedAgents } = d.data;
  const t = tg.data;
  const kindOf = (r: PolicyRow): RowKind => r.projectId ? (r.userId || r.groupId ? 'exception' : 'project') : r.groupId ? 'group' : r.userId ? (t.agents.some((a) => a.id === r.userId) || rules.some((x) => x.userId === r.userId && x.userKind === 'agent') ? 'agent' : 'user') : 'org';
  const projectName = (id: string) => t.projects.find((p) => p.id === id)?.label ?? rules.find((x) => x.projectId === id)?.projectLabel ?? 'Projekt';
  const whoName = (r: PolicyRow) => r.userId ? ([...t.users, ...t.agents].find((u) => u.id === r.userId)?.name ?? rules.find((x) => x.userId === r.userId)?.userName ?? '?') : r.groupId ? `Gruppe ${t.groups.find((g) => g.id === r.groupId)?.name ?? rules.find((x) => x.groupId === r.groupId)?.groupName ?? '?'}` : '';
  const label = (r: PolicyRow) => { const k = kindOf(r); return k === 'org' ? 'Alle (Mandant)' : k === 'project' ? projectName(r.projectId!) : k === 'exception' ? `${whoName(r)} in ${projectName(r.projectId!)}` : whoName(r); };
  const rows = new Map<string, PolicyRow>([[rowKey({ projectId: null, userId: null, groupId: null }), { projectId: null, userId: null, groupId: null }]]);
  for (const r of [...rules.map((x) => ({ projectId: x.projectId, userId: x.userId, groupId: x.groupId })), ...added]) rows.set(rowKey(r), r);
  const cols = [{ key: '*', label: 'Alle' }, ...AI_CATEGORIES.flatMap((c) => [{ key: c.key as string, label: c.label }, ...(detailed ? AI_FEATURES.filter((f) => f.category === c.key && !('later' in f && f.later)).map((f) => ({ key: f.key as string, label: f.label })) : [])])];
  const ruleAt = (r: PolicyRow, feature: string) => rules.find((x) => rowKey(x) === rowKey(r) && x.feature === feature);
  const save = (row: PolicyRow, feature: string, effect: 'allow' | 'deny' | null, note: string | null) => run(async () => { d.setData(await api.put<PolicyListing>('/ai/policies', { ...row, feature, effect, note })); await invalidateAi(); });
  // Auswahl je Zeilenart; Ausnahmen gelten für Personen, Agenten (z. B. Morton nur in BAU) und Gruppen in einem Projekt
  const people = t.users.map((u) => ({ id: u.id, label: u.name }));
  const agentOpts = t.agents.map((a) => ({ id: a.id, label: a.name }));
  const targetGroups: { label: string | null; options: { id: string; label: string }[] }[] = add.kind === 'group' ? [{ label: null, options: t.groups.map((g) => ({ id: g.id, label: g.name })) }]
    : add.kind === 'project' ? [{ label: null, options: t.projects.map((p) => ({ id: p.id, label: p.label })) }]
    : add.kind === 'agent' ? [{ label: null, options: agentOpts }]
    : add.kind === 'exception' ? [{ label: 'Personen', options: people }, { label: 'Agenten', options: agentOpts }, { label: 'Gruppen', options: t.groups.map((g) => ({ id: `g:${g.id}`, label: `Gruppe ${g.name}` })) }]
    : [{ label: null, options: people }];
  const addRow = () => {
    const tid = add.target;
    const row: PolicyRow = add.kind === 'group' ? { projectId: null, userId: null, groupId: tid } : add.kind === 'project' ? { projectId: tid, userId: null, groupId: null }
      : add.kind === 'exception' ? { projectId: add.projectId, userId: tid.startsWith('g:') ? null : tid, groupId: tid.startsWith('g:') ? tid.slice(2) : null } : { projectId: null, userId: tid, groupId: null };
    setAdded([...added, row]);
    setAdd({ ...add, target: '' });
  };
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>KI-Freigaben</h2>
        {killswitch
          ? <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.put('/ai/settings', { enabled: true }); await d.reload(); await invalidateAi(); })}>KI wieder einschalten</button>
          : <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Notaus: KI abschalten', text: 'Alle KI-Funktionen im Mandanten sind sofort aus: Assistenz, Mail-KI, Agentenläufe und Chat mit Agenten, auch Verbindungstests. Ausnahmen gelten nicht. Läufe stehen als übersprungen im Protokoll.', confirmLabel: 'KI abschalten', danger: true }).then((ok) => { if (ok) void run(async () => { await api.put('/ai/settings', { enabled: false }); await d.reload(); await invalidateAi(); }); })}>Notaus: KI abschalten</button>}
      </div>
      {killswitch && <div className="notice danger mt"><strong>Notaus aktiv:</strong> KI ist im Mandanten abgeschaltet, auch gegen Ausnahmen.</div>}
      <p className="muted small">Regeln für Ort (alle Projekte oder ein Projekt), Wer (alle, Gruppe, Person, Agent) und Funktion. Ohne Regel wird geerbt; innerhalb einer Zeile gilt die Funktion vor der Kategorie vor „Alle“. Sperre gewinnt: Ist ein Projekt gesperrt, hilft eine Personenfreigabe nicht; eine Ausnahme gibt es nur als „Person in Projekt“. Die PL kann im Projekt weiter einschränken (Projekt-KI, „KI nutzen“, Agenten), der Notaus gilt immer. Ohne Regel erlaubt, außer „Eigene Agenten der PL“.</p>
      {error && <div className="error mb">{error}</div>}
      {stoppedAgents.length > 0 && <div className="notice mb small">
        <strong>Gestoppte Agenten der PL</strong> (Regel „Eigene Agenten der PL“):
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{stoppedAgents.map((a) => <li key={a.id}>{a.name} · {a.projectLabel}{a.createdByName ? ` · angelegt von ${a.createdByName}` : ''} <button className="btn sm link" disabled={busy} title="Ausnahme für die PL in ihrem Projekt" onClick={() => void save({ projectId: a.projectId, userId: a.createdById, groupId: null }, 'pl.agents', 'allow', `Agent ${a.name} erlaubt`)}>erlauben</button><div className="muted">{a.reason}</div></li>)}</ul>
      </div>}
      <div className="row mb small"><label className="check"><input type="checkbox" checked={detailed} onChange={(e) => setDetailed(e.target.checked)} /> Funktionen einzeln</label><span className="muted">✓ erlaubt · ✕ gesperrt · · erbt; Klick ändert, • = mit Notiz</span></div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table ai-matrix"><thead><tr><th>Wer / Ort</th>{cols.map((c) => <th key={c.key} className="small" title={c.key}>{c.label}</th>)}</tr></thead><tbody>
          {ROW_SECTIONS.map((sec) => {
            const list = [...rows.values()].filter((r) => kindOf(r) === sec.kind);
            if (!list.length) return null;
            return [<tr key={sec.kind} className="sec"><td colSpan={cols.length + 1}>{sec.label} <span className="muted" style={{ fontWeight: 400 }}>· {sec.hint}</span></td></tr>,
              ...list.map((r) => <tr key={rowKey(r)}><td className="small">{label(r)}</td>{cols.map((c) => { const x = ruleAt(r, c.key); return <td key={c.key}><button className={`ai-cell ${x?.effect ?? ''} ${x?.note ? 'note' : ''}`} disabled={busy} title={x ? `${x.effect === 'allow' ? 'erlaubt' : 'gesperrt'}${x.note ? `: ${x.note}` : ''}${x.setByName ? ` (${x.setByName})` : ''}` : 'erbt'} onClick={() => setCell({ row: r, label: label(r), feature: c.key, effect: x?.effect ?? null, note: x?.note ?? '' })}>{x ? (x.effect === 'allow' ? '✓' : '✕') : '·'}</button></td>; })}</tr>)];
          })}
        </tbody></table>
      </div>
      <div className="row small mt" style={{ flexWrap: 'wrap' }}>
        <span className="muted">Zeile hinzufügen:</span>
        <select aria-label="Zeilenart" value={add.kind} onChange={(e) => setAdd({ kind: e.target.value as RowKind, target: '', projectId: '' })} style={{ width: 'auto' }}>{ROW_SECTIONS.filter((x) => x.kind !== 'org').map((x) => <option key={x.kind} value={x.kind}>{x.label}</option>)}</select>
        {add.kind === 'exception' && <select aria-label="Projekt" value={add.projectId} onChange={(e) => setAdd({ ...add, projectId: e.target.value })} style={{ width: 'auto' }}><option value="">Projekt …</option>{t.projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>}
        <select aria-label="Wer" value={add.target} onChange={(e) => setAdd({ ...add, target: e.target.value })} style={{ width: 'auto' }}><option value="">{add.kind === 'exception' ? 'Person, Agent oder Gruppe …' : 'wählen …'}</option>
          {targetGroups.map((g) => { const opts = g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>); return g.label ? (g.options.length ? <optgroup key={g.label} label={g.label}>{opts}</optgroup> : null) : opts; })}</select>
        <button className="btn sm" disabled={!add.target || (add.kind === 'exception' && !add.projectId)} onClick={addRow}>Hinzufügen</button>
      </div>
      <AiPolicyPreview targets={t} />
      {cell && (
        <Modal title={`${cell.label} · ${cols.find((c) => c.key === cell.feature)?.label ?? cell.feature}`} onClose={() => setCell(null)}>
          <div className="form">
            <div className="row">{([[null, 'erben'], ['allow', 'erlauben'], ['deny', 'sperren']] as const).map(([v, l]) => <label key={l} className="check"><input type="radio" name="ai-cell" checked={cell.effect === v} onChange={() => setCell({ ...cell, effect: v })} /> {l}</label>)}</div>
            {cell.effect && <label className="field"><span>Notiz (erscheint in der Begründung)</span><input type="text" maxLength={300} value={cell.note} placeholder="z. B. Datenschutz Bauherr" onChange={(e) => setCell({ ...cell, note: e.target.value })} /></label>}
            <div className="row"><button className="btn primary" disabled={busy} onClick={() => void save(cell.row, cell.feature, cell.effect, cell.note.trim() || null).then(() => setCell(null))}>Speichern</button><button className="btn" onClick={() => setCell(null)}>Abbrechen</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Vorschau: Wirkung für eine Person oder einen Agenten (optional in einem Projekt), je Funktion mit Begründung und Spur. */
function AiPolicyPreview({ targets }: { targets: PolicyTargets }) {
  const [who, setWho] = useState('');
  const [projectId, setProjectId] = useState('');
  const eff = useData<{ subject: { name: string; kind: string }; project: { label: string } | null; features: { feature: string; label: string; decision: AiDecision }[] }>(who ? `/ai/policies/effective?userId=${who}${projectId ? `&projectId=${projectId}` : ''}` : null, [who, projectId]);
  return (
    <div className="mt" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div className="row small" style={{ flexWrap: 'wrap' }}>
        <strong>Wirkung für</strong>
        <select value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 'auto' }}><option value="">Person oder Agent …</option><optgroup label="Personen">{targets.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</optgroup><optgroup label="Agenten">{targets.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup></select>
        <span>in</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}><option value="">ohne Projekt</option>{targets.projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
      </div>
      {eff.error && <div className="error small mt">{eff.error}</div>}
      {who && eff.data && <table className="table mt"><thead><tr><th>Funktion</th><th>Ergebnis</th><th>Begründung</th></tr></thead><tbody>
        {eff.data.features.map((f) => <tr key={f.feature}><td className="small">{f.label}<div className="muted"><code>{f.feature}</code></div></td>
          <td>{f.decision.allowed ? <span className="badge ok">erlaubt</span> : <span className="badge danger">{STAGE_LABEL[f.decision.stage] || 'gesperrt'}</span>}</td>
          <td className="small">{f.decision.reason}<details><summary className="muted">Spur</summary><ol style={{ margin: '2px 0 0', paddingLeft: 18 }}>{f.decision.trace.map((s, i) => <li key={i} style={s.ok ? undefined : { color: 'var(--danger)' }}>{s.ok ? '✓' : '✕'} {STAGE_LABEL[s.stage]}: {s.text}</li>)}</ol></details></td></tr>)}
      </tbody></table>}
    </div>
  );
}

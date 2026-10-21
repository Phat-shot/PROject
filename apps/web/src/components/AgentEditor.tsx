import { useState } from 'react';
import { AGENT_ACTION_CLASSES, AGENT_DEPTHS, AGENT_MODES, AI_CATEGORIES, AI_FEATURES, DEFAULT_AGENT_RIGHTS, type AgentActionClass, type AgentDepth, type AgentMode, type AgentPolicy, type AgentUser, type AiFeature } from '@projekttool/shared';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { Modal, useAsync } from './ui';

/**
 * Rechte eines Agenten als Häkchen je Bereich (Assistenz, Mail, Arbeit, Aktionen). granted: nur diese sind wählbar, die übrigen
 * stehen ausgegraut mit Hinweis (Einschränkung im Projekt: die PL kann nur abschalten, was der Verwalter erteilt hat).
 */
export function RightsEditor({ value, onChange, granted, disabled = false }: { value: AiFeature[]; onChange: (v: AiFeature[]) => void; granted?: AiFeature[]; disabled?: boolean }) {
  const toggle = (k: AiFeature, on: boolean) => onChange(on ? [...new Set([...value, k])] : value.filter((x) => x !== k));
  return (
    <div className="rights-editor">
      {AI_CATEGORIES.map((c) => (
        <fieldset key={c.key}>
          <legend>{c.label} <span className="muted small">{c.hint}</span></legend>
          {AI_FEATURES.filter((f) => f.category === c.key).map((f) => {
            const off = granted ? !granted.includes(f.key) : false;
            return <label key={f.key} className="check small" title={off ? 'Vom Verwalter des LLM nicht erteilt' : f.key}>
              <input type="checkbox" checked={!off && value.includes(f.key)} disabled={disabled || off} onChange={(e) => toggle(f.key, e.target.checked)} /> <span className={off ? 'muted' : ''}>{f.label}{off ? ' (nicht erteilt)' : ''}</span>
            </label>;
          })}
        </fieldset>
      ))}
    </div>
  );
}

/** Kurztext der Rechte: „alle“, „alle außer …“ oder die Liste. */
export function rightsSummary(r: AiFeature[] | undefined): string {
  const v = r ?? DEFAULT_AGENT_RIGHTS;
  const all = AI_FEATURES.map((f) => f.key);
  const missing = all.filter((k) => !v.includes(k));
  if (!missing.length) return 'alle Rechte';
  if (missing.length <= 4) return `alle außer ${missing.map((k) => AI_FEATURES.find((f) => f.key === k)?.label ?? k).join(', ')}`;
  return `${v.length} von ${all.length} Rechten`;
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

export interface LlmChoice { id: string; name: string; provider: 'local' | 'anthropic'; thinkingOff?: boolean }

/**
 * Agent anlegen oder bearbeiten, an einem LLM, das die Person verwaltet: Name, Persona, Unterschrift, LLM (nur dieselbe Ebene),
 * Denkmodus, Tagesbudget, Einsatz (nur bei LLMs der Organisation), Rechte und die Obergrenze der Selbstständigkeit, die keine
 * Ebene darunter lockern kann.
 */
export function AgentEditorModal({ agent, llms, llmId, orgBudget, scoped, onClose, onSaved }: { agent: AgentUser | null; llms: LlmChoice[]; llmId: string; orgBudget: number; scoped: boolean; onClose: () => void; onSaved: (warnings: string[]) => Promise<void> | void }) {
  const p0: AgentPolicy = agent?.policy ?? {};
  const [f, setF] = useState({
    name: agent?.name ?? '', persona: agent?.persona ?? '', signature: agent?.signature ?? '', aiProfileId: agent?.aiProfileId ?? llmId, thinkingMode: agent?.thinkingMode ?? null as 'off' | 'on' | null,
    dailyBudget: agent?.dailyBudget == null ? '' : String(agent.dailyBudget), scope: (agent?.scope === 'selected' ? 'selected' : 'all') as 'all' | 'selected', projectIds: agent?.projectIds ?? [],
    rights: agent?.rights ?? DEFAULT_AGENT_RIGHTS, maxMode: p0.maxMode ?? '' as AgentMode | '', lockedConfirm: p0.lockedConfirm ?? [] as AgentActionClass[], maxDepth: p0.maxDepth ?? '' as AgentDepth | ''
  });
  const { busy, error, run } = useAsync();
  const llm = llms.find((l) => l.id === f.aiProfileId);
  const lock = (c: AgentActionClass, on: boolean) => setF({ ...f, lockedConfirm: on ? [...f.lockedConfirm, c] : f.lockedConfirm.filter((x) => x !== c) });
  const save = () => run(async () => {
    const policy: AgentPolicy = { ...(f.maxMode ? { maxMode: f.maxMode } : {}), ...(f.lockedConfirm.length ? { lockedConfirm: f.lockedConfirm } : {}), ...(f.maxDepth ? { maxDepth: f.maxDepth } : {}) };
    const body = { name: f.name.trim(), persona: f.persona.trim() || null, signature: f.signature.trim() || null, aiProfileId: f.aiProfileId, thinkingMode: f.thinkingMode, dailyBudget: f.dailyBudget === '' ? null : Number(f.dailyBudget), rights: f.rights, policy, ...(scoped ? { scope: f.scope, projectIds: f.scope === 'selected' ? f.projectIds : [] } : {}) };
    const r = agent ? await api.patch<{ warnings?: string[] }>(`/agents/${agent.id}`, body) : await api.post<{ warnings?: string[] }>('/agents', body);
    await onSaved(r.warnings ?? []);
  });
  return (
    <Modal title={agent ? `Agent: ${agent.name}` : `Agent anlegen an ${llm?.name ?? 'LLM'}`} onClose={onClose}>
      <div className="form">
        <div className="grid cols-2">
          <label className="field"><span>Name</span><input type="text" value={f.name} autoFocus maxLength={80} placeholder="z. B. Morton" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>LLM</span><select value={f.aiProfileId} disabled={llms.length < 2} onChange={(e) => setF({ ...f, aiProfileId: e.target.value })}>{llms.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        </div>
        <label className="field"><span>Persona (Schreibstil, eine Zeile)</span><input type="text" value={f.persona} maxLength={300} placeholder="z. B. freundlich, knapp, duzt das Team" onChange={(e) => setF({ ...f, persona: e.target.value })} /></label>
        <label className="field"><span>Unterschrift für Mails (leer = „Name (KI-Agent, Projekt KEY)“)</span><textarea rows={2} maxLength={500} value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} /></label>
        <div className="grid cols-2">
          <label className="field"><span>Tagesbudget (Läufe, leer = Mandant {orgBudget})</span><input type="number" min={0} max={orgBudget} value={f.dailyBudget} placeholder={String(orgBudget)} onChange={(e) => setF({ ...f, dailyBudget: e.target.value })} /></label>
          <label className="field"><span>Denkmodus</span><select value={f.thinkingMode ?? ''} disabled={llm?.provider !== 'local'} title={llm?.provider === 'local' ? undefined : 'Nur bei lokalen Modellen'} onChange={(e) => setF({ ...f, thinkingMode: (e.target.value || null) as 'off' | 'on' | null })}><option value="">wie LLM ({llm?.thinkingOff ? 'aus' : 'Standard'})</option><option value="off">aus</option><option value="on">an</option></select></label>
        </div>
        {scoped && <ScopeEditor agent scope={f.scope} projectIds={f.projectIds} onChange={(scope, projectIds) => setF({ ...f, scope: scope === 'selected' ? 'selected' : 'all', projectIds })} />}
        <h3 style={{ margin: '8px 0 0' }}>Was der Agent darf</h3>
        <p className="muted small" style={{ margin: 0 }}>Die PL lädt ihn ins Projekt ein und kann dort nur abschalten, nie mehr erlauben.</p>
        <RightsEditor value={f.rights} onChange={(rights) => setF({ ...f, rights })} />
        <h3 style={{ margin: '8px 0 0' }}>Obergrenze der Selbstständigkeit</h3>
        <div className="grid cols-2">
          <label className="field"><span>höchstens</span><select value={f.maxMode} onChange={(e) => setF({ ...f, maxMode: e.target.value as AgentMode | '' })}><option value="">keine Grenze (Projekt entscheidet)</option>{AGENT_MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label>
          <label className="field"><span>höchste Denktiefe</span><select value={f.maxDepth} onChange={(e) => setF({ ...f, maxDepth: e.target.value as AgentDepth | '' })}><option value="">keine Grenze</option>{AGENT_DEPTHS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></label>
        </div>
        <div className="field"><span>Immer bestätigen lassen <span className="muted">(gilt in jedem Projekt, auch bei „Selbstständig“)</span></span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{AGENT_ACTION_CLASSES.map((c) => <label key={c.key} className="check small" style={{ margin: 0 }}><input type="checkbox" checked={f.lockedConfirm.includes(c.key)} onChange={(e) => lock(c.key, e.target.checked)} /> {c.label}</label>)}</div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || !f.name.trim() || !f.aiProfileId} onClick={() => void save()}>{agent ? 'Speichern' : 'Anlegen'}</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

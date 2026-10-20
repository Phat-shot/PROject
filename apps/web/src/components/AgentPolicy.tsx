import { useState } from 'react';
import { AGENT_ACTION_CLASSES, AGENT_DEPTHS, AGENT_MODES, type AgentActionClass, type AgentDepth, type AgentMode, type AgentPolicy, type AgentScope, type ChatOrdersLevel, type EffectiveAgentPolicy, type Question, type SynergyMode } from '@projekttool/shared';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { PromptModal, useAsync } from './ui';
import { InheritSelect } from './settings/Settings';

/** Beschriftungen der Agenten-Policy (Konzept 6). */
export const modeLabel = (m: AgentMode | undefined | null) => AGENT_MODES.find((x) => x.key === m)?.label ?? 'erben';
export const scopeLabel = (s: AgentScope | undefined | null) => (s === 'project' ? 'ganzes Projekt' : 'zugewiesene Arbeitspakete');
export const synergyLabel = (s: SynergyMode | undefined | null) => ({ off: 'aus', ask: 'nachfragen', use: 'nutzen' }[s ?? 'ask'] ?? 'nachfragen');
export const depthLabel = (d: AgentDepth | undefined | null) => AGENT_DEPTHS.find((x) => x.key === d)?.label ?? 'Standard';
export const classLabel = (c: AgentActionClass | string | null | undefined) => AGENT_ACTION_CLASSES.find((x) => x.key === c)?.label ?? String(c ?? '');

/**
 * Bearbeiten einer Policy-Ebene: Selbstständigkeit, zu bestätigende Klassen, optional Grenzen für tiefere Ebenen (Org, Projekt)
 * und ob Agenten Workflow-Schritte übernehmen. Leere Felder erben von der Ebene darüber.
 */
export function AgentPolicyEditor({ value, onSave, limits = false, workflows = true, inheritFrom, effective }: { value: AgentPolicy | null | undefined; onSave: (v: AgentPolicy) => Promise<void>; limits?: boolean; workflows?: boolean; inheritFrom: string; effective?: EffectiveAgentPolicy | null }) {
  const [f, setF] = useState<AgentPolicy>({ ...(value ?? {}) });
  const { busy, error, run } = useAsync();
  const toggle = (k: 'confirm' | 'lockedConfirm', c: AgentActionClass) => { const cur = new Set(f[k] ?? []); if (cur.has(c)) cur.delete(c); else cur.add(c); setF({ ...f, [k]: [...cur] }); };
  const list = (k: 'confirm' | 'lockedConfirm', title: string, hint: string) => (
    <div className="field"><span>{title} <span className="muted">{hint}</span></span>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{AGENT_ACTION_CLASSES.map((c) => <label key={c.key} className="check small" style={{ margin: 0 }}><input type="checkbox" checked={(f[k] ?? []).includes(c.key)} onChange={() => toggle(k, c.key)} /> {c.label}</label>)}</div>
    </div>
  );
  return (
    <div className="form">
      <label className="field"><span>Selbstständigkeit</span>
        <select value={f.mode ?? ''} onChange={(e) => setF({ ...f, mode: (e.target.value || undefined) as AgentMode | undefined })}>
          <option value="">erben ({inheritFrom}{effective ? `: ${modeLabel(effective.mode)}` : ''})</option>{AGENT_MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select></label>
      {(f.mode ?? effective?.mode) === 'confirm_critical' && <>
        <label className="check small"><input type="checkbox" checked={f.confirm !== undefined} onChange={(e) => setF({ ...f, confirm: e.target.checked ? [...(effective?.confirm ?? AGENT_ACTION_CLASSES.filter((c) => c.critical).map((c) => c.key))] : undefined })} /> eigene Liste der zu bestätigenden Schritte (sonst geerbt{effective ? `: ${effective.confirm.map(classLabel).join(', ') || 'keine'}` : ''})</label>
        {f.confirm !== undefined && list('confirm', 'Bestätigung nötig vor', '(Grundmenge wie Log, Tasks, Doku-Entwürfe, interner Chat bleibt immer frei)')}
      </>}
      {limits && <>
        <label className="field"><span>Grenze für tiefere Ebenen: mindestens</span>
          <select value={f.maxMode ?? ''} onChange={(e) => setF({ ...f, maxMode: (e.target.value || undefined) as AgentMode | undefined })}><option value="">keine Grenze</option>{AGENT_MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label>
        {list('lockedConfirm', 'Immer bestätigen lassen', '(gilt auf allen tieferen Ebenen, auch bei „Selbstständig“)')}
        <label className="field"><span>Aufträge an Agenten im Chat</span>
          <select value={f.chatOrders ?? ''} onChange={(e) => setF({ ...f, chatOrders: (e.target.value || undefined) as ChatOrdersLevel | undefined })}><option value="">erben{effective ? ` (${effective.chatOrders})` : ' (Standard: PL und Stellvertretung)'}</option><option value="pl">PL und Stellvertretung</option><option value="tp">dazu Teilprojekt-Verantwortung im eigenen Teilprojekt</option><option value="responsible">dazu Zuständige für Aufgaben unter dem eigenen AP</option><option value="members">alle Mitglieder</option></select></label>
      </>}
      <label className="field" title="„ganzes Projekt“ schaltet für den Projektagenten den werktäglichen Projektdurchlauf frei (Doppelarbeit, Synergien, Widersprüche, Steckbrief)"><span>Reichweite</span>
        <select value={f.scope ?? ''} onChange={(e) => setF({ ...f, scope: (e.target.value || undefined) as AgentScope | undefined })}><option value="">erben{effective ? ` (${scopeLabel(effective.scope)})` : ' (Standard: zugewiesene Arbeitspakete)'}</option><option value="task">zugewiesene Arbeitspakete</option><option value="project">ganzes Projekt (Projektdurchlauf)</option></select></label>
      <label className="field" title="Überschneidungen zwischen Arbeitspaketen: nachfragen stellt die Frage an die Zuständigen bzw. die PL; nutzen (nur bei „Selbstständig“) vermerkt Querverweise direkt"><span>Überschneidungen</span>
        <select value={f.synergies ?? ''} onChange={(e) => setF({ ...f, synergies: (e.target.value || undefined) as SynergyMode | undefined })}><option value="">erben{effective ? ` (${synergyLabel(effective.synergies)})` : ' (Standard: nachfragen)'}</option><option value="off">aus</option><option value="ask">nachfragen</option><option value="use">nutzen (nur bei Selbstständig)</option></select></label>
      <label className="field" title="schnell: eine Leserunde, knapper Kontext, Denkmodus aus; gründlich: bis zu vier Leserunden, voller Kontext, Denkmodus an, kostet zwei Läufe im Tagesbudget"><span>Denktiefe</span>
        <select value={f.depth ?? ''} onChange={(e) => setF({ ...f, depth: (e.target.value || undefined) as AgentDepth | undefined })}><option value="">erben{effective ? ` (${depthLabel(effective.depth)})` : ' (Standard)'}</option>{AGENT_DEPTHS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></label>
      {limits && <label className="field"><span>Höchste Denktiefe für tiefere Ebenen</span>
        <select value={f.maxDepth ?? ''} onChange={(e) => setF({ ...f, maxDepth: (e.target.value || undefined) as AgentDepth | undefined })}><option value="">keine Grenze</option>{AGENT_DEPTHS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></label>}
      {limits && <label className="field"><span>Uhrzeit des Projektdurchlaufs (werktags, Europe/Berlin)</span>
        <input type="time" value={f.reviewAt ?? ''} onChange={(e) => setF({ ...f, reviewAt: e.target.value || undefined })} placeholder={effective?.reviewAt ?? '06:45'} /></label>}
      {workflows && <label className="field"><span>Workflow-Schritte an Agenten</span>
        <select value={f.workflows === undefined ? '' : f.workflows ? 'yes' : 'no'} onChange={(e) => setF({ ...f, workflows: e.target.value === '' ? undefined : e.target.value === 'yes' })}><option value="">erben{effective ? ` (${effective.workflows ? 'erlaubt' : 'aus'})` : ''}</option><option value="yes">erlaubt</option><option value="no">aus (Schritt geht an die PL)</option></select></label>}
      {error && <div className="error small">{error}</div>}
      <div className="row"><button className="btn primary sm" disabled={busy} onClick={() => void run(() => onSave(f))}>Speichern</button><button className="btn sm" disabled={busy} onClick={() => setF({})}>Alles erben</button></div>
    </div>
  );
}

/**
 * Policy am Arbeitspaket (Selbstständigkeit, Denktiefe) als Inline-Felder mit wirksamem Wert und Herkunft; PL und „Projektplan ändern“
 * (nur verschärfen, prüft die API). Leer = erbt von Agent, Projekt oder Mandant.
 */
export function TaskPolicyInline({ task, onChanged }: { task: { id: string; agentPolicy?: AgentPolicy | null }; onChanged: () => unknown }) {
  const d = useData<{ policy: AgentPolicy | null; effective: EffectiveAgentPolicy }>(`/tasks/${task.id}/agent-policy`, [task.id, JSON.stringify(task.agentPolicy ?? null)]);
  const { busy, error, run } = useAsync();
  const own = d.data?.policy ?? task.agentPolicy ?? {};
  const save = (next: AgentPolicy) => run(async () => { await api.put(`/tasks/${task.id}/agent-policy`, Object.keys(next).length ? next : null); await d.reload(); await onChanged(); });
  const e = d.data?.effective;
  return <>
    <span className="muted" title="Agenten-Policy für dieses Arbeitspaket und seine Aufgaben; mit „Projektplan ändern“ nur verschärfen">Selbstständigkeit hier:</span>
    <InheritSelect ariaLabel="Selbstständigkeit" value={own.mode ?? undefined} effective={e ? { value: e.mode, origin: e.origin.mode } : null} options={AGENT_MODES} disabled={busy} text={(v) => modeLabel(v)} onChange={(mode) => void save({ ...own, mode: mode ?? undefined })} />
    <span className="muted" title="Denktiefe für dieses Arbeitspaket: schnell (eine Leserunde), Standard, gründlich (vier Leserunden, kostet zwei Läufe); Grenze des Mandanten oder Projekts gilt">Denktiefe:</span>
    <InheritSelect ariaLabel="Denktiefe" value={own.depth ?? undefined} effective={e ? { value: e.depth, origin: e.origin.depth } : null} options={AGENT_DEPTHS} disabled={busy} text={(v) => depthLabel(v)} onChange={(depth) => void save({ ...own, depth: depth ?? undefined })} />
    {error && <span className="error small">{error}</span>}
  </>;
}

const DEFAULT_CONFIRM = AGENT_ACTION_CLASSES.filter((c) => c.critical).map((c) => c.key);
/** Wirksame Policy auf Mandantenebene (nur Code-Standard darunter), damit der Editor der Verwaltung geerbte Werte benennt. */
export function orgEffectivePolicy(org: AgentPolicy | null | undefined): EffectiveAgentPolicy {
  const o = org ?? {};
  const mode = o.mode ?? 'confirm_critical';
  const pick = <K extends keyof AgentPolicy>(k: K) => (o[k] !== undefined ? 'Mandant' : 'Standard');
  const confirm = mode === 'confirm_all' ? AGENT_ACTION_CLASSES.map((c) => c.key) : mode === 'confirm_critical' ? [...(o.confirm ?? DEFAULT_CONFIRM)] : [];
  for (const k of o.lockedConfirm ?? []) if (!confirm.includes(k)) confirm.push(k);
  return {
    mode, confirm, workflows: o.workflows ?? true, chatOrders: o.chatOrders ?? 'pl', scope: o.scope ?? 'task', synergies: o.synergies ?? 'ask', reviewAt: o.reviewAt ?? '06:45', depth: o.depth ?? 'standard',
    origin: { mode: pick('mode'), confirm: Object.fromEntries(confirm.map((k) => [k, (o.lockedConfirm ?? []).includes(k) ? 'Mandant erzwungen' : pick('confirm')])), workflows: pick('workflows'), chatOrders: pick('chatOrders'), scope: pick('scope'), synergies: pick('synergies'), depth: pick('depth') },
    denied: {}
  };
}

/** Wirksame Policy als Text mit Herkunft. */
export function EffectivePolicyText({ e }: { e: EffectiveAgentPolicy }) {
  return <span className="small">
    <strong>{modeLabel(e.mode)}</strong> <span className="muted">({e.origin.mode})</span>
    {e.confirm.length > 0 && <> · Bestätigung vor: {e.confirm.map((c) => <span key={c} title={e.origin.confirm[c]}>{classLabel(c)}{e.origin.confirm[c]?.includes('erzwungen') ? ' 🔒' : ''}; </span>)}</>}
    {Object.keys(e.denied).length > 0 && <> · <span style={{ color: 'var(--danger)' }}>gesperrt: {(Object.keys(e.denied) as AgentActionClass[]).map(classLabel).join(', ')}</span></>}
    {!e.workflows && <> · keine Workflow-Schritte</>}
    {e.chatOrders !== 'pl' && <> · Aufträge im Chat: {e.chatOrders}</>}
    {e.scope === 'project' && <> · Reichweite: ganzes Projekt (Durchlauf {e.reviewAt})</>}
    {e.synergies !== 'ask' && <> · Überschneidungen: {synergyLabel(e.synergies)}</>}
    {e.depth !== 'standard' && <> · Denktiefe: {depthLabel(e.depth)} <span className="muted">({e.origin.depth})</span></>}
  </span>;
}

/**
 * Karte einer Freigabefrage (approval): angehaltene Aktionen des Agenten mit Häkchen; Bestätigen führt mit den Rechten des Agenten
 * aus, Ablehnen braucht einen Grund und sperrt dieselbe Aktion 14 Tage. Freitext im Thread ist keine Bestätigung.
 */
export function ApprovalCard({ q, onChanged, canDecide = true }: { q: Question; onChanged: () => void; canDecide?: boolean }) {
  const { busy, error, run } = useAsync();
  const props = q.proposals ?? [];
  const pending = props.filter((p) => p.status === 'pending');
  const [sel, setSel] = useState<Set<string>>(() => new Set(pending.map((p) => p.id)));
  const [rejecting, setRejecting] = useState<string[] | null>(null);
  const STATUS: Record<string, string> = { pending: 'offen', approved: 'ausgeführt', rejected: 'abgelehnt', stale: 'veraltet', failed: 'fehlgeschlagen', expired: 'abgelaufen', withdrawn: 'zurückgezogen' };
  const decide = (approve: string[], reject: string[], reason?: string) => run(async () => { await api.post(`/questions/${q.id}/decide`, { approve, reject, reason }); onChanged(); });
  if (!props.length) return null;
  return (
    <div className="approval-card small mt">
      {props.map((p) => <label key={p.id} className="row check" style={{ gap: 6, margin: '2px 0' }}>
        {p.status === 'pending' && q.status === 'open' && canDecide ? <input type="checkbox" checked={sel.has(p.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(p.id); else n.delete(p.id); setSel(n); }} /> : <span className={`badge ${p.status === 'approved' ? 'ok' : p.status === 'pending' ? '' : 'warn'}`}>{STATUS[p.status] ?? p.status}</span>}
        <span>{p.seq + 1}) {p.label}</span>{p.class && <span className="muted">· {classLabel(p.class)}</span>}
      </label>)}
      {q.status === 'open' && pending.length > 0 && canDecide && <div className="row mt" style={{ gap: 6 }}>
        <button className="btn sm primary" disabled={busy || !sel.size} onClick={() => void decide([...sel].filter((id) => pending.some((p) => p.id === id)), [])}>{sel.size === pending.length ? 'Alle bestätigen' : `${sel.size} bestätigen`}</button>
        <button className="btn sm" disabled={busy || !sel.size} onClick={() => setRejecting([...sel].filter((id) => pending.some((p) => p.id === id)))}>Ablehnen …</button>
      </div>}
      {rejecting && <PromptModal title="Ablehnen" label="Grund (Pflicht; dieselbe Aktion wird 14 Tage nicht erneut vorgeschlagen)" submitLabel="Ablehnen" onClose={() => setRejecting(null)} onSubmit={(v) => { if (v.trim()) { void decide([], rejecting, v.trim()); setRejecting(null); } }} />}
      {error && <div className="error small mt">{error}</div>}
    </div>
  );
}

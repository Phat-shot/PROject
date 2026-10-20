import { useState } from 'react';
import { AGENT_ACTION_CLASSES, AGENT_MODES, type AgentActionClass, type AgentMode, type AgentPolicy, type EffectiveAgentPolicy, type Question } from '@projekttool/shared';
import { api } from '../lib/api';
import { PromptModal, useAsync } from './ui';

/** Beschriftungen der Agenten-Policy (Konzept 6). */
export const modeLabel = (m: AgentMode | undefined | null) => AGENT_MODES.find((x) => x.key === m)?.label ?? 'erben';
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
      </>}
      {workflows && <label className="field"><span>Workflow-Schritte an Agenten</span>
        <select value={f.workflows === undefined ? '' : f.workflows ? 'yes' : 'no'} onChange={(e) => setF({ ...f, workflows: e.target.value === '' ? undefined : e.target.value === 'yes' })}><option value="">erben{effective ? ` (${effective.workflows ? 'erlaubt' : 'aus'})` : ''}</option><option value="yes">erlaubt</option><option value="no">aus (Schritt geht an die PL)</option></select></label>}
      {error && <div className="error small">{error}</div>}
      <div className="row"><button className="btn primary sm" disabled={busy} onClick={() => void run(() => onSave(f))}>Speichern</button><button className="btn sm" disabled={busy} onClick={() => setF({})}>Alles erben</button></div>
    </div>
  );
}

/** Wirksame Policy als Text mit Herkunft. */
export function EffectivePolicyText({ e }: { e: EffectiveAgentPolicy }) {
  return <span className="small">
    <strong>{modeLabel(e.mode)}</strong> <span className="muted">({e.origin.mode})</span>
    {e.confirm.length > 0 && <> · Bestätigung vor: {e.confirm.map((c) => <span key={c} title={e.origin.confirm[c]}>{classLabel(c)}{e.origin.confirm[c]?.includes('erzwungen') ? ' 🔒' : ''}; </span>)}</>}
    {Object.keys(e.denied).length > 0 && <> · <span style={{ color: 'var(--danger)' }}>gesperrt: {(Object.keys(e.denied) as AgentActionClass[]).map(classLabel).join(', ')}</span></>}
    {!e.workflows && <> · keine Workflow-Schritte</>}
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

import { AGENT_ACTION_CLASSES, AGENT_MODES, type AgentActionClass, type AgentMode, type AgentPolicy, type AgentScope, type ChatOrdersLevel, type EffectiveAgentPolicy, type SynergyMode } from '@projekttool/shared';
import type { Db } from '../db.js';
import { resolveRules } from './policy.js';

/**
 * Agenten-Policy (Konzept 6, Regel A): Selbstständigkeit je Org → Projekt → Agent im Projekt → Arbeitspaket.
 * - mode: auto (alles, was Rechte und KI-Freigaben erlauben), confirm_critical (Klassen in confirm werden bestätigt),
 *   confirm_all (alles außer der Grundmenge). Die tiefste gesetzte Angabe gilt, begrenzt durch die strengste maxMode von Org und Projekt.
 * - confirm: gewählte Klassen plus lockedConfirm von Org und Projekt; bei auto nur die gesperrten, bei confirm_all alle.
 * - Gesperrte Klassen kommen aus den KI-Freigaben (agent.<klasse>): weder ausführen noch vorschlagen.
 * Grundmenge (immer frei): Log, Tasks, Status außer Erledigt, Aufgaben unter dem eigenen AP ohne Zuweisung an Dritte, Doku (nicht final),
 * Ordner, intern kommunizieren (chat, ask), lesen, wait, blocked, escalate, resolve, refer, none; create_event ist selbst die Rückfrage.
 */
export const MODE_ORDER: AgentMode[] = ['auto', 'confirm_critical', 'confirm_all'];
export const CLASS_KEYS: AgentActionClass[] = AGENT_ACTION_CLASSES.map((c) => c.key);
export const DEFAULT_CONFIRM: AgentActionClass[] = AGENT_ACTION_CLASSES.filter((c) => c.critical).map((c) => c.key);
export const DEFAULT_MODE: AgentMode = 'confirm_critical';
export const CHAT_ORDERS: ChatOrdersLevel[] = ['pl', 'tp', 'responsible', 'members'];
export const classLabel = (c: AgentActionClass) => AGENT_ACTION_CLASSES.find((x) => x.key === c)?.label ?? c;
export const modeLabel = (m: AgentMode) => AGENT_MODES.find((x) => x.key === m)?.label ?? m;
const stricter = (a: AgentMode, b: AgentMode) => (MODE_ORDER.indexOf(a) >= MODE_ORDER.indexOf(b) ? a : b);

/** Eingabe einer Ebene prüfen; limits = darf Grenzen setzen (Org, Projekt); unbekannte Felder fallen weg. */
export function parseAgentPolicy(raw: unknown, opts: { limits: boolean; workflows: boolean } = { limits: true, workflows: true }): AgentPolicy {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object') throw new Error('Agenten-Policy: Objekt erwartet');
  const x = raw as any;
  const out: AgentPolicy = {};
  const mode = (v: unknown, name: string) => { if (v === undefined || v === null || v === '') return undefined; if (!MODE_ORDER.includes(v as AgentMode)) throw new Error(`Agenten-Policy: ${name} muss auto, confirm_critical oder confirm_all sein`); return v as AgentMode; };
  const classes = (v: unknown, name: string) => { if (v === undefined || v === null) return undefined; if (!Array.isArray(v)) throw new Error(`Agenten-Policy: ${name} ist eine Liste`); const bad = v.find((c) => !CLASS_KEYS.includes(c)); if (bad) throw new Error(`Agenten-Policy: unbekannte Klasse ${String(bad)}`); return [...new Set(v as AgentActionClass[])]; };
  const m = mode(x.mode, 'mode'); if (m) out.mode = m;
  const c = classes(x.confirm, 'confirm'); if (c) out.confirm = c;
  if (opts.limits) {
    const mm = mode(x.maxMode, 'maxMode'); if (mm) out.maxMode = mm;
    const lc = classes(x.lockedConfirm, 'lockedConfirm'); if (lc) out.lockedConfirm = lc;
  }
  if (opts.workflows && typeof x.workflows === 'boolean') out.workflows = x.workflows;
  if (x.scope !== undefined && x.scope !== null && x.scope !== '') { if (!['task', 'project'].includes(x.scope)) throw new Error('Agenten-Policy: scope task oder project'); out.scope = x.scope; }
  if (x.synergies !== undefined && x.synergies !== null && x.synergies !== '') { if (!['off', 'ask', 'use'].includes(x.synergies)) throw new Error('Agenten-Policy: synergies off, ask oder use'); out.synergies = x.synergies; }
  if (opts.limits && x.reviewAt !== undefined && x.reviewAt !== null && x.reviewAt !== '') { if (!/^\d{2}:\d{2}$/.test(String(x.reviewAt))) throw new Error('Agenten-Policy: reviewAt als HH:MM'); out.reviewAt = String(x.reviewAt); }
  if (opts.limits && x.chatOrders !== undefined && x.chatOrders !== null && x.chatOrders !== '') { if (!CHAT_ORDERS.includes(x.chatOrders)) throw new Error('Agenten-Policy: chatOrders muss pl, tp, responsible oder members sein'); out.chatOrders = x.chatOrders; }
  return out;
}

const pol = (v: any): AgentPolicy => (v && typeof v === 'object' ? (v as AgentPolicy) : {});

/**
 * Wirksame Policy mit Herkunft je Feld. Ohne Angabe auf allen Ebenen gilt „Rückfrage bei wichtigen Schritten“ (Entscheidung 6;
 * Bestandsprojekte haben per Migration auto). taskId darf eine Aufgabe sein: ihre Policy, sonst die ihres Arbeitspakets.
 */
export async function effectiveAgentPolicy(db: Db, q: { agentId?: string | null; projectId: string; taskId?: string | null }): Promise<EffectiveAgentPolicy> {
  const p = await db.one(`select p.agent_policy, p.key, p.org_id, o.settings->'ai'->'agentPolicy' as org_policy from projects p join orgs o on o.id = p.org_id where p.id = $1`, [q.projectId]);
  const org = pol(p.org_policy); const project = pol(p.agent_policy);
  const member = q.agentId ? pol((await db.maybeOne(`select agent_policy from project_members where project_id = $1 and user_id = $2`, [q.projectId, q.agentId]))?.agent_policy) : {};
  let task: AgentPolicy = {}; let taskLabel = 'Arbeitspaket';
  if (q.taskId) {
    const t = await db.maybeOne(`select t.agent_policy, t.number, pt.agent_policy as parent_policy, pt.number as parent_number from tasks t left join tasks pt on pt.id = t.parent_id where t.id = $1`, [q.taskId]);
    if (t?.agent_policy && typeof t.agent_policy === 'object' && Object.keys(t.agent_policy).length) { task = pol(t.agent_policy); taskLabel = `${p.key}-${t.number}`; }
    else if (t?.parent_policy && typeof t.parent_policy === 'object' && Object.keys(t.parent_policy).length) { task = pol(t.parent_policy); taskLabel = `Arbeitspaket ${p.key}-${t.parent_number}`; }
  }
  const levels: [string, AgentPolicy][] = [[taskLabel, task], ['Agent im Projekt', member], [`Projekt ${p.key}`, project], ['Mandant', org]];
  const pick = <K extends keyof AgentPolicy>(k: K): { value: AgentPolicy[K]; origin: string } | null => { for (const [name, v] of levels) if (v[k] !== undefined) return { value: v[k], origin: name }; return null; };
  const m = pick('mode');
  let mode: AgentMode = (m?.value as AgentMode) ?? DEFAULT_MODE;
  let modeOrigin = m ? m.origin : 'Standard';
  // Grenze: die strengste maxMode von Org und Projekt (ein lascherer mode wird angehoben)
  const caps: [string, AgentMode | undefined][] = [['Mandant', org.maxMode], [`Projekt ${p.key}`, project.maxMode]];
  for (const [name, cap] of caps) if (cap && MODE_ORDER.indexOf(mode) < MODE_ORDER.indexOf(cap)) { mode = stricter(mode, cap); modeOrigin = `${name} erzwungen`; }
  const c = pick('confirm');
  const chosen = (c?.value as AgentActionClass[] | undefined) ?? DEFAULT_CONFIRM;
  const confirm = new Map<AgentActionClass, string>();
  if (mode === 'confirm_all') for (const k of CLASS_KEYS) confirm.set(k, modeOrigin === 'Standard' ? 'Rückfrage bei allem' : `${modeOrigin} (Rückfrage bei allem)`);
  else if (mode === 'confirm_critical') for (const k of chosen) confirm.set(k, c ? c.origin : 'Standard');
  for (const [name, v] of [['Mandant', org], [`Projekt ${p.key}`, project]] as [string, AgentPolicy][]) for (const k of v.lockedConfirm ?? []) confirm.set(k, `${name} erzwungen`);
  const w = pick('workflows');
  const co = pick('chatOrders');
  const sc = pick('scope'); const sy = pick('synergies'); const ra = pick('reviewAt');
  // Synergien: in den Rückfrage-Stufen immer nachfragen
  const synergies: SynergyMode = (sy?.value as SynergyMode | undefined) ?? 'ask';
  const denied: Partial<Record<AgentActionClass, string>> = {};
  if (q.agentId) {
    for (const k of CLASS_KEYS) {
      const r = await resolveRules(db, { orgId: p.org_id, userId: q.agentId, projectId: q.projectId, feature: `agent.${k}` as any });
      if (r.effect === 'deny') denied[k] = r.publicText;
    }
  }
  return { mode, confirm: [...confirm.keys()], workflows: w ? Boolean(w.value) : true, chatOrders: (co?.value as ChatOrdersLevel | undefined) ?? 'pl', scope: (sc?.value as AgentScope | undefined) ?? 'task', synergies: synergies === 'use' && mode !== 'auto' ? 'ask' : synergies, reviewAt: (ra?.value as string | undefined) ?? '06:45', origin: { mode: modeOrigin, confirm: Object.fromEntries(confirm) as Partial<Record<AgentActionClass, string>>, workflows: w ? w.origin : 'Standard', chatOrders: co ? co.origin : 'Standard', scope: sc ? sc.origin : 'Standard', synergies: sy ? (synergies === 'use' && mode !== 'auto' ? `${sy.origin} (nutzen nur bei Selbstständig)` : sy.origin) : 'Standard' }, denied };
}

/** Text für den variablen Teil des Prompts (nicht ins Sheet, damit der Prefix-Cache bleibt). */
export function policyText(e: EffectiveAgentPolicy): string {
  const held = e.confirm.filter((k) => !e.denied[k]);
  const parts = [`Selbstständigkeit: ${modeLabel(e.mode)}.`];
  if (held.length) parts.push(`Bestätigung durch eine Person vor: ${held.map(classLabel).join(', ')} (das System hält diese Aktionen an und legt sie der PL vor; schlage sie trotzdem vor, wenn sie nötig sind, aber nicht erneut, solange sie offen sind).`);
  const den = Object.keys(e.denied) as AgentActionClass[];
  if (den.length) parts.push(`Gesperrt (KI-Freigaben, nicht vorschlagen): ${den.map(classLabel).join(', ')}.`);
  return parts.join(' ');
}

/** Kontext für die Einordnung einer Aktion: eigenes AP, Spalten, Agent. */
export interface ClassifyCtx { task: { id: string; number: number; parent_id: string | null; parent_number: number | null; workflow_run_id?: string | null }; agentEmail: string; doneColumns: Set<string>; pageStatus?: (pageId: string) => string | null }

/** Aktionsklassen einer Aktion (leer = Grundmenge). Mehrere möglich, z. B. create_ap mit Zuweisung an Dritte = plan + assign. */
export function classifyAction(a: any, c: ClassifyCtx): AgentActionClass[] {
  const out = new Set<AgentActionClass>();
  const own = (ref: unknown) => { const r = String(ref ?? '').trim(); if (!r) return true; const n = Number(r.split('-').pop()); return n === c.task.number || n === c.task.parent_number; };
  const third = (resp: unknown) => { const r = String(resp ?? '').trim().toLowerCase(); return Boolean(r) && r !== c.agentEmail.toLowerCase(); };
  switch (a?.type) {
    case 'doc_status': { const to = String(a.status ?? ''); const from = c.pageStatus?.(String(a.pageId ?? '')) ?? null; if (to === 'final' || from === 'final') out.add('finalize'); break; }
    case 'doc_send_pdf': out.add('distribute'); break;
    case 'mail': case 'reply_origin': out.add('send_external'); break;
    case 'set_status': { if (c.doneColumns.has(String(a.column ?? '').toLowerCase()) && (!c.task.parent_id || c.task.workflow_run_id)) out.add('close'); break; }
    case 'create_ap': case 'create_subproject': case 'create_milestone': out.add('plan'); if (a.type !== 'create_milestone' && third(a.responsible)) out.add('assign'); break;
    case 'create_aufgabe': if (third(a.responsible)) out.add('assign'); if (!own(a.ref)) out.add('foreign'); break;
    case 'assign': out.add('assign'); if (!own(a.ref)) out.add('foreign'); break;
    case 'set_dates': out.add('schedule'); if (!own(a.ref)) out.add('foreign'); break;
    default: break;
  }
  return [...out];
}

/** Kurztext einer Aktion für Karte, Log und Vorschlagsliste. */
export function actionLabel(a: any, c?: { pageTitle?: (id: string) => string | null }): string {
  const cut = (s: unknown, n: number) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };
  const page = (id: unknown) => c?.pageTitle?.(String(id ?? '')) ?? 'Seite';
  switch (a?.type) {
    case 'doc_status': return `„${page(a.pageId)}“ → ${{ draft: 'Entwurf', review: 'In Prüfung', final: 'Final' }[String(a.status)] ?? a.status}`;
    case 'doc_send_pdf': return `PDF „${page(a.pageId)}“ an ${Array.isArray(a.to) && a.to.length ? a.to.join(', ') : 'Verteiler'}: ${cut(a.subject, 60)}`;
    case 'mail': return `Mail an ${(a.to ?? []).join(', ')}: ${cut(a.subject, 60)}`;
    case 'reply_origin': return `Antwort auf die Ursprungsmail: ${cut(a.text, 80)}`;
    case 'set_status': return `Status → ${a.column}`;
    case 'create_ap': return `Arbeitspaket „${cut(a.title, 60)}“${a.responsible ? ` für ${a.responsible}` : ''}`;
    case 'create_aufgabe': return `Aufgabe „${cut(a.title, 60)}“${a.ref ? ` unter ${a.ref}` : ''}${a.responsible ? ` für ${a.responsible}` : ''}`;
    case 'create_subproject': return `Teilprojekt „${cut(a.title, 60)}“`;
    case 'create_milestone': return `Meilenstein „${cut(a.title, 60)}“ am ${a.dueDate ?? '?'}`;
    case 'assign': return `${a.ref ?? 'AP'} zuweisen an ${a.responsible || 'niemanden (geerbt)'}`;
    case 'set_dates': return `${a.ref ? `${a.ref}: ` : ''}Termine ${a.startDate ?? '–'} bis ${a.dueDate ?? '–'}`;
    default: return `${a?.type ?? '?'}${a?.title ? ` „${cut(a.title, 60)}“` : a?.text ? `: ${cut(a.text, 60)}` : ''}`;
  }
}

/** Kennung einer Aktion für die Ablehnungssperre (14 Tage): Typ und Zielfelder, ohne Freitext. */
export function actionFingerprint(a: any): string {
  const keys = ['type', 'pageId', 'status', 'column', 'ref', 'responsible', 'startDate', 'dueDate', 'title', 'subproject'];
  const parts = keys.map((k) => `${k}=${String(a?.[k] ?? '').trim().toLowerCase()}`);
  if (Array.isArray(a?.to)) parts.push(`to=${[...a.to].map((x: unknown) => String(x).toLowerCase()).sort().join(',')}`);
  return parts.join('|');
}

/** Zugriff der Agenten je Ordner, über die Hierarchie vererbt (die strengste Angabe gilt); Seiten ohne Ordner: write. */
export async function folderAccessMap(db: Db, projectId: string): Promise<Map<string, 'write' | 'read' | 'none'>> {
  const rows = await db.query(`select id, parent_id, agent_access from doc_folders where project_id = $1`, [projectId]);
  const by = new Map<string, { parent: string | null; access: 'write' | 'read' | 'none' }>();
  for (const r of rows.rows) by.set(r.id, { parent: r.parent_id, access: r.agent_access ?? 'write' });
  const rank = { write: 0, read: 1, none: 2 } as const;
  const out = new Map<string, 'write' | 'read' | 'none'>();
  for (const [id] of by) {
    let acc: 'write' | 'read' | 'none' = 'write'; let cur: string | null = id;
    for (let i = 0; cur && i < 20; i++) { const f = by.get(cur); if (!f) break; if (rank[f.access] > rank[acc]) acc = f.access; cur = f.parent; }
    out.set(id, acc);
  }
  return out;
}

/** Wer darf einen angehaltenen Vorschlag entscheiden: PL und Stellvertretung; sonst „Freigeben“ plus das Recht der Klasse; Agenten nie. */
export function canDecideClass(m: { role: string; canApprove: boolean; canFinalize: boolean; canEditPlan: boolean }, cls: AgentActionClass | null, extra: { canSend?: boolean; isContact?: boolean } = {}): boolean {
  if (m.role === 'pl') return true;
  if (!m.canApprove) return false;
  switch (cls) {
    case 'finalize': case 'distribute': return m.canFinalize;
    case 'plan': case 'foreign': case 'restructure': return m.canEditPlan;
    case 'send_external': return Boolean(extra.canSend);
    case 'close': case 'assign': case 'schedule': return true;
    default: return true;
  }
}

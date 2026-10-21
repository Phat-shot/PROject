import type { AiCapabilities, AiCapability, AiDecision, AiFeature, AiStage, AiTraceStep, User } from '@projekttool/shared';
import { AI_CATEGORIES, AI_FEATURES, DEFAULT_AGENT_RIGHTS } from '@projekttool/shared';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { mapMembership } from '../rights.js';
import { aiConfigForAgent, aiConfigForProfile, orgAiSettings, type AiConfig, agentUsableIn } from './client.js';
import { PROJECT_LABEL_SQL, projectPolicy } from '../projectPolicy.js';

/**
 * Prüfweg jeder KI-Nutzung. Im Projekt arbeiten nur Agenten: Ein Agent gehört zu einem LLM, wer das LLM verwaltet, legt seine
 * Rechte fest (users.agent_rights), die PL schränkt im Projekt nur weiter ein (project_members.agent_policy.deny). Personen
 * rufen kein LLM selbst; sie lösen Assistenz aus („KI nutzen“) oder chatten, ausgeführt wird von einem Agenten (assistAgent).
 * Reihenfolge, die erste Sperre gewinnt: 0 Notaus, 1 Rechte des Agenten, 2 Ebene der PL (Mitgliedschaft, „KI nutzen“,
 * Einschränkung im Projekt, Pause), 3 LLM, 4 Budget. Jede Stufe schreibt eine Zeile in die Spur.
 */
export type AiQueryFeature = AiFeature | 'profile.test';
export interface AiQuery {
  /** Person oder Agent, deren Nutzung geprüft wird */
  userId: string;
  projectId?: string | null;
  /** Funktion aus AI_FEATURES; profile.test = Verbindungstest eines LLM (nur Notaus und LLM) */
  feature: AiQueryFeature;
  /** Lauf an einem Arbeitspaket: Pause des Agenten dort */
  taskId?: string | null;
  /** Ansicht, auf die sich die Anfrage bezieht (derzeit ohne eigene Prüfung) */
  viewId?: string | null;
  /** Verbindungstest eines bestimmten LLM (profile.test) */
  profileId?: string | null;
  /** false: ohne Budgetstufe (Einschalten, Anzeige) */
  budget?: boolean;
  /** Zeitpunkt für das Tagesbudget (Worker, Tests) */
  now?: Date;
}

export const KILLSWITCH_TEXT = 'KI im Mandanten abgeschaltet (Notaus)';
export const NO_AI_RIGHT = 'Kein KI-Recht in diesem Projekt (Mitgliedschaft: „KI nutzen“)';
export { PROJECT_LABEL_SQL };

export const featureLabel = (k: string): string => AI_FEATURES.find((x) => x.key === k)?.label ?? AI_CATEGORIES.find((x) => x.key === k)?.label ?? k;
const featureDef = (k: string) => AI_FEATURES.find((x) => x.key === k) as { key: AiFeature; label: string; who: 'person' | 'agent' | 'both'; defaultDeny?: boolean } | undefined;
const ASSIST: AiFeature[] = AI_FEATURES.filter((f) => f.category === 'assist').map((f) => f.key);

/** Rechte, die der Verwalter des LLM dem Agenten gegeben hat (ohne Angabe: Standard beim Anlegen). */
export const rightsOf = (row: { agent_rights?: string[] | null }): AiFeature[] => (Array.isArray(row.agent_rights) ? (row.agent_rights as AiFeature[]) : DEFAULT_AGENT_RIGHTS);
/** Von der PL im Projekt abgeschaltete Rechte des Agenten. */
export async function projectDeny(db: Db, projectId: string, agentId: string): Promise<AiFeature[]> {
  const r = await db.maybeOne(`select agent_policy from project_members where project_id = $1 and user_id = $2`, [projectId, agentId]);
  const d = r?.agent_policy?.deny;
  return Array.isArray(d) ? (d as AiFeature[]) : [];
}
/** Wirksame Rechte des Agenten im Projekt: Rechte des Verwalters ohne die Einschränkungen der PL. */
export async function agentRightsIn(db: Db, agentId: string, projectId: string | null): Promise<AiFeature[]> {
  const u = await db.maybeOne(`select agent_rights from users where id = $1`, [agentId]);
  if (!u) return [];
  const deny = projectId ? await projectDeny(db, projectId, agentId) : [];
  return rightsOf(u).filter((f) => !deny.includes(f));
}

/** Läufe, die einem Agenten heute noch zustehen: Tagesbudget des Agenten (vom Verwalter), höchstens der Wert des Mandanten; übersprungene zählen nicht. */
export async function agentBudgetLeft(db: Db, agent: { id: string; org_id: string }, now = new Date()): Promise<number> {
  const settings = await orgAiSettings(db, agent.org_id);
  const own = (await db.maybeOne(`select agent_daily_budget from users where id = $1`, [agent.id]))?.agent_daily_budget;
  const limit = own == null ? settings.agentDailyBudget : Math.min(settings.agentDailyBudget, Number(own));
  // Kosten je Lauf (Denktiefe gründlich = 2) statt Zeilen; Assistenz zählt je Aufruf
  const used = await db.one(`select coalesce(sum(cost), 0)::int as c from agent_runs where agent_user_id = $1 and status in ('ok','error') and created_at >= $2::date`, [agent.id, now.toISOString().slice(0, 10)]);
  return Math.max(0, limit - used.c);
}

/** Prüfung mit Konfiguration; die Konfiguration (mit Schlüssel) gibt nur aiConfigFor() weiter, Routen sehen nur die Entscheidung. Personen bekommen nie eine Konfiguration. */
export async function checkAi(db: Db, q: AiQuery): Promise<{ decision: AiDecision; cfg: AiConfig | null }> {
  const trace: AiTraceStep[] = [];
  const deny = (stage: AiStage, reason: string, missing = false) => {
    trace.push({ stage, ok: false, text: reason });
    return { decision: { allowed: false, reason, publicReason: reason, stage, trace, ...(missing ? { missing: true } : {}) }, cfg: null };
  };
  const pass = (stage: AiStage, text: string) => { trace.push({ stage, ok: true, text }); };
  const ok = (cfg: AiConfig | null, reason = 'Erlaubt') => ({ decision: { allowed: true, reason, publicReason: reason, stage: 'ok' as AiStage, trace }, cfg });

  const subj = await db.maybeOne(`select id, org_id, name, kind, active, agent_project_id, agent_rights from users where id = $1`, [q.userId]);
  if (!subj) return deny('project', 'Benutzer nicht gefunden');
  const settings = await orgAiSettings(db, subj.org_id);
  // 0 Notaus: sperrt alles
  if (!settings.enabled) return deny('killswitch', KILLSWITCH_TEXT);
  pass('killswitch', 'Notaus nicht aktiv');
  if (q.feature === 'profile.test') {
    const cfg = q.profileId ? await aiConfigForProfile(db, subj.org_id, q.profileId) : null;
    if (!cfg) return deny('profile', 'LLM unvollständig, inaktiv oder gesperrt (Adresse, Modell, Schlüssel prüfen)', true);
    pass('profile', `LLM ${cfg.name}`);
    return ok(cfg, `LLM ${cfg.name}`);
  }
  const f = q.feature;
  const def = featureDef(f);
  if (!def) return deny('policy', `Unbekannte KI-Funktion ${f}`);
  const isAgent = subj.kind === 'agent';
  const project = q.projectId ? await db.maybeOne(`select p.id, p.org_id, p.personal from projects p where p.id = $1`, [q.projectId]) : null;
  if (q.projectId && (!project || project.org_id !== subj.org_id)) return deny('project', 'Projekt nicht gefunden');

  if (!isAgent) {
    // Personen: nur auslösen (Assistenz, Chat, Aufträge); was der Agent darf, prüft dessen eigener Aufruf
    if (def.who === 'agent') return deny('project', `${def.label}: gilt nur für KI-Agenten`);
    if (project) {
      const row = await db.maybeOne(`select * from project_members where project_id = $1 and user_id = $2`, [project.id, subj.id]);
      // Implizite Leser (Sichtbarkeit „alle Benutzer“) haben keine KI
      if (!row) return deny('project', 'Kein eingetragenes Mitglied des Projekts (KI nur für ausdrückliche Mitglieder)');
      const m = mapMembership(row);
      // Leser: nur Auskunft (Frage ans Projekt, Chat mit Agenten), mit „KI nutzen“
      if (m.role === 'reader' && f !== 'assist.ask' && f !== 'agent.chat') return deny('project', 'Leser stellen nur Fragen ans Projekt');
      if (m.role !== 'pl' && !m.canUseAi) return deny('project', NO_AI_RIGHT);
      pass('project', m.role === 'pl' ? 'PL im Projekt' : `${m.role === 'reader' ? 'Leser' : 'Mitglied'} mit „KI nutzen“`);
    } else if (f === 'agent.chat') pass('project', 'ohne Projekt: Auskunft nur aus Projekten mit „KI nutzen“');
    else return deny('project', `${def.label}: nur in einem Projekt`);
    return ok(null);
  }

  // 1 Rechte des Agenten: vom Verwalter seines LLM
  if (!subj.active) return deny('project', `${subj.name} ist deaktiviert`);
  if (def.who === 'person') return deny('policy', `${def.label}: gilt nur für Personen`);
  if (!rightsOf(subj).includes(f)) return deny('policy', `${def.label}: für ${subj.name} nicht freigegeben (Rechte am Agenten, Verwalter des LLM)`);
  pass('policy', `${def.label}: Recht des Agenten`);

  // 2 Ebene der PL: Mitglied, Einschränkung im Projekt, Pause
  if (project) {
    const mem = await db.maybeOne(`select agent_policy from project_members where project_id = $1 and user_id = $2`, [project.id, subj.id]);
    if (!mem) return deny('project', `${subj.name} ist kein Mitglied des Projekts`);
    if (Array.isArray(mem.agent_policy?.deny) && mem.agent_policy.deny.includes(f)) return deny('project', `${def.label}: für ${subj.name} in diesem Projekt abgeschaltet (Einstellungen › KI)`);
    if (q.taskId && f === 'agent.run' && (await db.maybeOne(`select 1 from tasks where id = $1 and agent_paused`, [q.taskId]))) return deny('project', `${subj.name} ist an diesem Arbeitspaket pausiert`);
    if (subj.agent_project_id && project.id !== subj.agent_project_id) return deny('project', `${subj.name} gehört zu einem anderen Projekt`);
    pass('project', `${subj.name} ist aktiv und Mitglied`);
  } else pass('project', `${subj.name} ist aktiv`);

  // 3 LLM des Agenten: im Projekt freigegeben, aktiv, nicht gesperrt
  const cfg = await aiConfigForAgent(db, subj.id, project?.id ?? null);
  if (!cfg) {
    const u = project ? await agentUsableIn(db, subj.id, project.id) : null;
    return deny('profile', u && !u.ok ? u.reason : `Kein nutzbares LLM für ${subj.name} (Verwaltung › KI)`, true);
  }
  pass('profile', `LLM ${cfg.name}`);

  // 4 Budget je Agent; 0 sperrt; gezählt werden ausgeführte Läufe und Assistenz-Aufrufe
  if (q.budget !== false) {
    const left = await agentBudgetLeft(db, subj, q.now ?? new Date());
    if (left <= 0) return deny('budget', `Tagesbudget von ${subj.name} ist aufgebraucht`);
    pass('budget', `noch ${left} Läufe heute`);
  }
  return ok(cfg);
}

/** Darf Person bzw. Agent diese KI-Funktion jetzt nutzen? Ergebnis mit Begründung, Stufe und Spur. */
export async function aiAllowed(db: Db, q: AiQuery): Promise<AiDecision> {
  return (await checkAi(db, q)).decision;
}

/** Ablehnung als Fehler einer Route: Sperren 403, fehlende Einrichtung (LLM, Agent) und Budget 400, jeweils mit Begründung. */
export function aiError(d: AiDecision, shared = false): HttpError {
  return new HttpError(d.missing || d.stage === 'budget' ? 400 : 403, shared ? d.publicReason : d.reason);
}
const cap = (d: AiDecision): AiCapability => ({ allowed: d.allowed, reason: d.reason, stage: d.stage });

/** Agenten des Projekts (aktive Mitglieder) mit ihren wirksamen Assistenz-Rechten; der Projektagent zuerst. */
async function assistAgents(db: Db, projectId: string): Promise<{ id: string; name: string; org_id: string; assist: AiFeature[]; projectAgent: boolean }[]> {
  const rows = await db.query(`select u.id, u.name, u.org_id, u.agent_rights, m.agent_policy, (p.agent_user_id = u.id) as project_agent from project_members m join users u on u.id = m.user_id join projects p on p.id = m.project_id
    where m.project_id = $1 and u.kind = 'agent' and u.active order by (p.agent_user_id = u.id) desc nulls last, u.name`, [projectId]);
  return rows.rows.map((r: any) => {
    const deny: string[] = Array.isArray(r.agent_policy?.deny) ? r.agent_policy.deny : [];
    return { id: r.id, name: r.name, org_id: r.org_id, assist: rightsOf(r).filter((f) => ASSIST.includes(f) && !deny.includes(f)), projectAgent: Boolean(r.project_agent) };
  });
}
/** Standard für Assistenz: der Projektagent, sonst der einzige Agent mit diesem Recht; null = keiner oder mehrere (Auswahl). */
function defaultAssist(agents: Awaited<ReturnType<typeof assistAgents>>, feature?: AiFeature): string | null {
  const fit = agents.filter((a) => (feature ? a.assist.includes(feature) : a.assist.length > 0));
  return fit.find((a) => a.projectAgent)?.id ?? (fit.length === 1 ? fit[0].id : null);
}

/**
 * Assistenz auf Knopfdruck: die Person braucht „KI nutzen“ (Leser nur Frage ans Projekt), ausgeführt wird von einem Agenten des
 * Projekts mit diesem Recht: dem gewählten, sonst dem Projektagenten, sonst dem einzigen geeigneten. Liefert Konfiguration und Agent.
 */
export async function assistAgent(db: Db, user: User, projectId: string, feature: AiFeature, agentId?: string | null, now?: Date): Promise<{ cfg: AiConfig; agent: { id: string; name: string; org_id: string } }> {
  const person = await aiAllowed(db, { userId: user.id, projectId, feature });
  if (!person.allowed) throw aiError(person);
  const agents = await assistAgents(db, projectId);
  const pick = agentId ? agents.find((a) => a.id === agentId) : agents.find((a) => a.id === defaultAssist(agents, feature));
  if (!pick) {
    if (agentId) throw new HttpError(400, 'Dieser Agent ist nicht (mehr) im Projekt');
    const fit = agents.filter((a) => a.assist.includes(feature));
    throw new HttpError(400, fit.length ? `Mehrere Agenten können „${featureLabel(feature)}“: bitte einen wählen` : `Kein Agent im Projekt darf „${featureLabel(feature)}“ (Einstellungen › KI: Agent einladen oder Recht freigeben)`);
  }
  const { cfg, decision } = await checkAi(db, { userId: pick.id, projectId, feature, now });
  if (!cfg) throw aiError(decision);
  return { cfg, agent: { id: pick.id, name: pick.name, org_id: pick.org_id } };
}

/** Assistenz-Aufruf eines Agenten zählt in sein Tagesbudget und steht in seinen Läufen (ohne Inhalt). */
export async function recordAssist(db: Db, agent: { id: string; org_id: string }, projectId: string, kind: string, c: { inputTokens: number; outputTokens: number }): Promise<void> {
  await db.query(`insert into agent_runs (org_id, agent_user_id, project_id, trigger, status, reasoning, actions, input_tokens, output_tokens) values ($1,$2,$3,'assist','ok',$4,'[]',$5,$6)`,
    [agent.org_id, agent.id, projectId, `Assistenz: ${kind}`, c.inputTokens, c.outputTokens]);
}

/** Assistenz-Knopf: darf die Person, und kann ein Agent des Projekts es ausführen (Standard-Agent geprüft, sonst Auswahl)? */
export async function assistCapability(db: Db, user: User, projectId: string, feature: AiFeature, agents?: Awaited<ReturnType<typeof assistAgents>>): Promise<AiCapability> {
  const person = await aiAllowed(db, { userId: user.id, projectId, feature });
  if (!person.allowed) return cap(person);
  const list = agents ?? (await assistAgents(db, projectId));
  if (!list.some((a) => a.assist.includes(feature))) return { allowed: false, reason: `Kein Agent im Projekt darf „${featureLabel(feature)}“ (Einstellungen › KI)`, stage: 'project' };
  const def = defaultAssist(list, feature);
  return def ? cap(await aiAllowed(db, { userId: def, projectId, feature })) : { allowed: true, reason: 'Agent wählen', stage: 'ok' };
}

/** Fähigkeiten im Projekt für die Knöpfe: je Assistenz-Funktion Person und ausführender Agent; je Agent Läufe, Chat und Assistenz. */
export async function aiCapabilities(db: Db, user: User, projectId: string): Promise<AiCapabilities> {
  const agents = await assistAgents(db, projectId);
  const features: AiCapabilities['features'] = {};
  for (const f of ASSIST) features[f] = await assistCapability(db, user, projectId, f, agents);
  features['agent.chat'] = cap(await aiAllowed(db, { userId: user.id, projectId, feature: 'agent.chat' }));
  const out: AiCapabilities['agents'] = [];
  for (const a of agents) out.push({ id: a.id, name: a.name, assist: a.assist, run: cap(await aiAllowed(db, { userId: a.id, projectId, feature: 'agent.run' })), chat: cap(await aiAllowed(db, { userId: a.id, projectId, feature: 'agent.chat' })) });
  return { killswitch: !(await orgAiSettings(db, user.orgId)).enabled, features, agents: out, assistAgentId: defaultAssist(agents) };
}

/** Darf es in diesem Projekt ein eigenes LLM geben (Mandant: aus, nur persönliche, alle)? Dann verwaltet es die PL. */
export async function ownLlmAllowed(db: Db, orgId: string, projectId: string): Promise<boolean> {
  const s = await orgAiSettings(db, orgId);
  return projectPolicy(await db.one(`select personal from projects where id = $1`, [projectId])).ai.ownLlm(s.ownLlm);
}

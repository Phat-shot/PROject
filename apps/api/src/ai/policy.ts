import type { AiCapabilities, AiCapability, AiDecision, AiFeature, AiStage, AiTraceStep, User } from '@projekttool/shared';
import { AI_CATEGORIES, AI_FEATURES } from '@projekttool/shared';
import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../errors.js';
import { getViewRights, mapMembership } from '../rights.js';
import { aiConfigForAgent, aiConfigForProfile, aiConfigForProject, orgAiSettings, profileConfig, type AiConfig, type AiProfileRow } from './client.js';

/**
 * KI-Freigaben: einziger Prüfweg für jede KI-Nutzung. aiAllowed() prüft in fester Reihenfolge, die erste Sperre gewinnt:
 * 0 Notaus des Mandanten (gilt auch gegen Ausnahmen), 1 Regeln des Org-Admins (Regel K), 2 Ebene der PL (ausdrückliche
 * Mitgliedschaft, „KI nutzen“, Agent aktiv und Mitglied, Pause, eigene Agenten der PL), 3 Profil, 4 Budget. Jede Stufe
 * schreibt eine Zeile in die Spur, damit Verwaltung und Oberfläche die Begründung zeigen. Die Konfiguration für einen
 * Aufruf liefert nur aiConfigFor() (client.ts), das hierüber prüft.
 */
export type AiQueryFeature = AiFeature | 'profile.test';
export interface AiQuery {
  /** Person oder Agent, deren Nutzung geprüft wird */
  userId: string;
  projectId?: string | null;
  /** Funktion aus AI_FEATURES; profile.test = Verbindungstest eines Profils des Mandanten (nur Notaus und Profil) */
  feature: AiQueryFeature;
  /** Lauf an einem Arbeitspaket: Pause des Agenten dort */
  taskId?: string | null;
  /** mail.process: Rechte „KI“ und „Arbeitspaket erzeugen“ an dieser Ansicht */
  viewId?: string | null;
  /** Verbindungstest eines bestimmten Profils (profile.test, pl.own_llm) */
  profileId?: string | null;
  /** false: ohne Budgetstufe (Einschalten, Anzeige) */
  budget?: boolean;
  /** Zeitpunkt für das Tagesbudget (Worker, Tests) */
  now?: Date;
}

export const KILLSWITCH_TEXT = 'KI im Mandanten abgeschaltet (Notaus)';
export const NO_AI_RIGHT = 'Kein KI-Recht in diesem Projekt (Mitgliedschaft: „KI nutzen“)';
/** Projektname für Org-Admin und Begründungen (Aliase p = projects, ow = Ersteller); persönliche Projekte nur als „persönlich (Eigentümer)“. */
export const PROJECT_LABEL_SQL = `case when p.personal then 'persönlich (' || coalesce(ow.name, '?') || ')' else p.key || ' ' || p.name end`;

export const featureLabel = (k: string): string => AI_FEATURES.find((x) => x.key === k)?.label ?? AI_CATEGORIES.find((x) => x.key === k)?.label ?? (k === '*' ? 'alle Funktionen' : k);
const featureDef = (k: string) => AI_FEATURES.find((x) => x.key === k) as { key: string; label: string; who: 'person' | 'agent' | 'both'; defaultDeny?: boolean } | undefined;

interface RuleRow { id: string; project_id: string | null; user_id: string | null; group_id: string | null; feature: string; effect: 'allow' | 'deny'; note: string | null; set_by_name: string | null; set_by_role: string | null; project_label: string | null; user_name: string | null; user_kind: string | null; group_name: string | null }
/** text: volle Begründung (betroffene Person, Verwaltung); publicText: für geteilte Orte, ohne Namen und Notiz bei Regeln für Personen und Gruppen. */
export interface RuleResult { effect: 'allow' | 'deny'; rule: RuleRow | null; level: 'exception' | 'person' | 'project' | 'org' | 'default'; text: string; publicText: string }

/** Text einer Regel, z. B. „Gesperrt durch Org-Admin (A. Admin) für Projekt BAU Neubau, Agenten: Datenschutz Bauherr“. */
function ruleText(r: RuleRow): string {
  const by = r.set_by_name ? `${r.set_by_role === 'org_admin' ? 'Org-Admin' : 'KI-Verwaltung'} (${r.set_by_name})` : 'Regel';
  const who = r.user_id ? r.user_name : r.group_id ? `Gruppe ${r.group_name}` : null;
  const scope = r.project_id ? (who ? `für ${who} in Projekt ${r.project_label}` : `für Projekt ${r.project_label}`) : who ? `für ${who}` : 'für den Mandanten';
  return `${r.effect === 'deny' ? 'Gesperrt' : 'Erlaubt'} durch ${by} ${scope}${r.feature === '*' ? '' : `, ${featureLabel(r.feature)}`}${r.note ? `: ${r.note}` : ''}`;
}
/**
 * Text einer Regel für geteilte Orte (Projektkanal, Lauflisten, Fähigkeiten der Agenten): Regeln für eine Person oder Gruppe
 * (auch als Ausnahme) ohne Namen und Notiz, z. B. „Gesperrt durch eine KI-Freigabe für diese Person, Chat mit Agenten“.
 * Regeln für Agenten, Projekte und den Mandanten bleiben vollständig.
 */
function publicRuleText(r: RuleRow): string {
  if (!r.group_id && (!r.user_id || r.user_kind === 'agent')) return ruleText(r);
  return `${r.effect === 'deny' ? 'Gesperrt' : 'Erlaubt'} durch eine KI-Freigabe für ${r.group_id ? 'eine Gruppe dieser Person' : 'diese Person'}${r.project_id ? ' in diesem Projekt' : ''}${r.feature === '*' ? '' : `, ${featureLabel(r.feature)}`}`;
}
const rank = (rule: string, f: string) => (rule === f ? 0 : rule === '*' ? 2 : 1);
/** Genaueste Regel einer Zelle: Funktion vor Kategorie vor „*“. */
const best = (rows: RuleRow[], f: string): RuleRow | null => [...rows].sort((a, b) => rank(a.feature, f) - rank(b.feature, f))[0] ?? null;
/** Gruppen einer Zelle: je Gruppe die genaueste Regel; treffen mehrere Gruppen zu, gewinnt die Sperre. */
function groupsCell(rows: RuleRow[], f: string): RuleRow | null {
  const byGroup = new Map<string, RuleRow[]>();
  for (const r of rows) byGroup.set(r.group_id!, [...(byGroup.get(r.group_id!) ?? []), r]);
  const picks = [...byGroup.values()].map((x) => best(x, f)!);
  return picks.find((r) => r.effect === 'deny') ?? picks[0] ?? null;
}

/**
 * Regel K: Auflösung der ai_policies für Person bzw. Agent u, Projekt p und Funktion f; die erste zutreffende Stufe entscheidet.
 * 1 Ausnahme: Regel für u in p, sonst für eine Gruppe von u in p. 2 Person und Projekt: Personenregel (ersatzweise Gruppen)
 * in allen Projekten und Projektregel für alle; gibt es beide, ist f nur erlaubt, wenn beide erlauben. 3 Mandant.
 * 4 Standard: erlaubt, außer bei Funktionen mit defaultDeny.
 */
export async function resolveRules(db: Db, q: { orgId: string; userId: string | null; projectId: string | null; feature: string }): Promise<RuleResult> {
  const f = q.feature;
  const rows = (await db.query<RuleRow>(
    `select r.*, sb.name as set_by_name, sb.global_role as set_by_role, ${PROJECT_LABEL_SQL} as project_label, u.name as user_name, u.kind as user_kind, g.name as group_name
     from ai_policies r left join users sb on sb.id = r.set_by left join projects p on p.id = r.project_id left join users ow on ow.id = p.created_by
       left join users u on u.id = r.user_id left join groups g on g.id = r.group_id
     where r.org_id = $1 and r.feature in ('*', $2, $3) and (r.project_id is null or r.project_id = $4::uuid)
       and ((r.user_id is null and r.group_id is null) or r.user_id = $5::uuid or r.group_id in (select group_id from group_members where user_id = $5::uuid))`,
    [q.orgId, f.split('.')[0], f, q.projectId, q.userId])).rows;
  const decide = (rule: RuleRow, level: RuleResult['level']): RuleResult => ({ effect: rule.effect, rule, level, text: ruleText(rule), publicText: publicRuleText(rule) });
  const inP = (r: RuleRow) => q.projectId !== null && r.project_id === q.projectId;
  if (q.projectId) {
    const ex = best(rows.filter((r) => inP(r) && r.user_id), f) ?? groupsCell(rows.filter((r) => inP(r) && r.group_id), f);
    if (ex) return decide(ex, 'exception');
  }
  const person = best(rows.filter((r) => !r.project_id && r.user_id), f) ?? groupsCell(rows.filter((r) => !r.project_id && r.group_id), f);
  const project = q.projectId ? best(rows.filter((r) => inP(r) && !r.user_id && !r.group_id), f) : null;
  if (person && project) {
    const deny = [person, project].find((r) => r.effect === 'deny');
    return deny ? decide(deny, deny === person ? 'person' : 'project') : { effect: 'allow', rule: project, level: 'project', text: `${ruleText(person)}; ${ruleText(project)}`, publicText: `${publicRuleText(person)}; ${ruleText(project)}` };
  }
  if (person) return decide(person, 'person');
  if (project) return decide(project, 'project');
  const org = best(rows.filter((r) => !r.project_id && !r.user_id && !r.group_id), f);
  if (org) return decide(org, 'org');
  const def = featureDef(f);
  const text = def?.defaultDeny ? `Standard: gesperrt, bis die Verwaltung „${def.label}“ freigibt (Verwaltung › KI-Freigaben)` : 'Keine Regel: Standard erlaubt';
  return { effect: def?.defaultDeny ? 'deny' : 'allow', rule: null, level: 'default', text, publicText: text };
}

/** Regel auf Ebene des Mandanten (alle Personen, alle Projekte), z. B. ob PL eigene Agenten anlegen dürfen. */
export async function orgRuleAllows(db: Db, orgId: string, feature: AiFeature): Promise<boolean> {
  return (await resolveRules(db, { orgId, userId: null, projectId: null, feature })).effect === 'allow';
}

/** Läufe, die einem Agenten heute noch zustehen: Tagesbudget des Mandanten bzw. das kleinere eigene (Agenten der PL); Läufe an Arbeitspaketen, im Chat und an Mails zählen, übersprungene nicht. */
export async function agentBudgetLeft(db: Db, agent: { id: string; org_id: string }, now = new Date()): Promise<number> {
  const settings = await orgAiSettings(db, agent.org_id);
  const own = (await db.maybeOne(`select agent_daily_budget from users where id = $1`, [agent.id]))?.agent_daily_budget;
  const limit = own == null ? settings.agentDailyBudget : Math.min(settings.agentDailyBudget, Number(own));
  const used = await db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1 and status in ('ok','error') and created_at >= $2::date`, [agent.id, now.toISOString().slice(0, 10)]);
  return Math.max(0, limit - used.c);
}

/** Prüfung mit Konfiguration; die Konfiguration (mit Schlüssel) gibt nur aiConfigFor() weiter, Routen sehen nur die Entscheidung. */
export async function checkAi(db: Db, q: AiQuery): Promise<{ decision: AiDecision; cfg: AiConfig | null }> {
  const trace: AiTraceStep[] = [];
  let rule: AiDecision['rule'] = null;
  const deny = (stage: AiStage, reason: string, missing = false, publicReason = reason) => {
    trace.push({ stage, ok: false, text: reason });
    return { decision: { allowed: false, reason, publicReason, stage, rule, trace, ...(missing ? { missing: true } : {}) }, cfg: null };
  };
  const pass = (stage: AiStage, text: string) => { trace.push({ stage, ok: true, text }); };

  const subj = await db.maybeOne(`select id, org_id, name, kind, active, agent_project_id, agent_created_by from users where id = $1`, [q.userId]);
  if (!subj) return deny('project', 'Benutzer nicht gefunden');
  const settings = await orgAiSettings(db, subj.org_id);
  // 0 Notaus: sperrt alles, auch Ausnahmen
  if (!settings.enabled) return deny('killswitch', KILLSWITCH_TEXT);
  pass('killswitch', 'Notaus nicht aktiv');
  if (q.feature === 'profile.test') {
    const cfg = q.profileId ? await aiConfigForProfile(db, subj.org_id, q.profileId) : null;
    if (!cfg) return deny('profile', 'Profil unvollständig oder inaktiv (Adresse, Modell, Schlüssel prüfen)', true);
    pass('profile', `Profil ${cfg.name}`);
    return { decision: { allowed: true, reason: `Profil ${cfg.name}`, publicReason: `Profil ${cfg.name}`, stage: 'ok', rule, trace }, cfg };
  }
  const f = q.feature;
  const def = featureDef(f);
  if (!def) return deny('policy', `Unbekannte KI-Funktion ${f}`);
  const isAgent = subj.kind === 'agent';
  const project = q.projectId ? await db.maybeOne(`select p.id, p.org_id, p.personal, p.ai_profile_id, ${PROJECT_LABEL_SQL} as label from projects p left join users ow on ow.id = p.created_by where p.id = $1`, [q.projectId]) : null;
  if (q.projectId && (!project || project.org_id !== subj.org_id)) return deny('project', 'Projekt nicht gefunden');

  // 1 Regeln des Org-Admins (Regel K)
  const k = await resolveRules(db, { orgId: subj.org_id, userId: subj.id, projectId: project?.id ?? null, feature: f });
  rule = k.rule ? { id: k.rule.id, effect: k.rule.effect } : null;
  if (k.effect === 'deny') return deny('policy', k.text, false, k.publicText);
  pass('policy', k.text);

  // 2 Ebene der PL: nur einschränken
  if (def.who === 'agent' && !isAgent) return deny('project', `${def.label}: gilt nur für KI-Agenten`);
  if (def.who === 'person' && isAgent) return deny('project', `${def.label}: gilt nur für Personen`);
  if (isAgent) {
    if (!subj.active) return deny('project', `${subj.name} ist deaktiviert`);
    if (project && !(await db.maybeOne(`select 1 from project_members where project_id = $1 and user_id = $2`, [project.id, subj.id]))) return deny('project', `${subj.name} ist kein Mitglied des Projekts`);
    if (q.taskId && f === 'agent.run' && (await db.maybeOne(`select 1 from tasks where id = $1 and agent_paused`, [q.taskId]))) return deny('project', `${subj.name} ist an diesem Arbeitspaket pausiert`);
    if (subj.agent_project_id) {
      if (project && project.id !== subj.agent_project_id) return deny('project', `${subj.name} gehört zu einem anderen Projekt`);
      // Agent einer PL: „Eigene Agenten der PL“ gilt für die PL, die ihn angelegt hat, auch während er läuft
      const pk = await resolveRules(db, { orgId: subj.org_id, userId: subj.agent_created_by, projectId: subj.agent_project_id, feature: 'pl.agents' });
      if (pk.effect === 'deny') return deny('project', `Eigener Agent der PL: ${pk.text}`, false, `Eigener Agent der PL: ${pk.publicText === pk.text ? pk.text : 'Gesperrt durch eine KI-Freigabe für die PL, die ihn angelegt hat'}`);
    }
    pass('project', project ? `${subj.name} ist aktiv und Mitglied` : `${subj.name} ist aktiv`);
  } else if (project) {
    const row = await db.maybeOne(`select * from project_members where project_id = $1 and user_id = $2`, [project.id, subj.id]);
    // Implizite Leser (Sichtbarkeit „alle Benutzer“) haben keine KI
    if (!row) return deny('project', 'Kein eingetragenes Mitglied des Projekts (KI nur für ausdrückliche Mitglieder)');
    const m = mapMembership(row);
    if (f.startsWith('pl.') && m.role !== 'pl') return deny('project', `${def.label}: nur die PL`);
    // Leser: nur Auskunft (Frage ans Projekt, Chat mit Agenten), mit „KI nutzen“
    if (m.role === 'reader' && f !== 'assist.ask' && f !== 'agent.chat') return deny('project', 'Leser stellen nur Fragen ans Projekt');
    if (m.role !== 'pl' && !m.canUseAi) return deny('project', NO_AI_RIGHT);
    if (f === 'mail.process' && q.viewId) {
      const r = await getViewRights(db, q.viewId, { id: subj.id, orgId: subj.org_id } as User, m);
      if (!r.canAi || !r.canCreateTask) return deny('project', 'An der Mail-Ansicht fehlen die Rechte „KI“ und „Arbeitspaket erzeugen“');
    }
    pass('project', m.role === 'pl' ? 'PL im Projekt' : `${m.role === 'reader' ? 'Leser' : 'Mitglied'} mit „KI nutzen“`);
  } else if (f === 'agent.chat') pass('project', 'ohne Projekt: nur Regeln für Person und Mandant; Auskunft nur aus Projekten mit „KI nutzen“');
  else return deny('project', `${def.label}: nur in einem Projekt`);

  // 3 Profil: die Profilachse (Freigabe je Profil, eigenes LLM, Sperre durch den Org-Admin) bleibt, wie sie ist
  let cfg: AiConfig | null = null;
  if (isAgent) {
    cfg = await aiConfigForAgent(db, subj.id);
    if (!cfg) return deny('profile', `Kein freigegebenes KI-Profil für ${subj.name} (Verwaltung › KI-Agenten)`, true);
    pass('profile', `Profil ${cfg.name}`);
  } else if (f === 'pl.own_llm' && q.profileId) {
    cfg = profileConfig(await db.maybeOne<AiProfileRow>(`select * from ai_profiles where id = $1 and project_id = $2`, [q.profileId, project!.id]));
    if (!cfg) return deny('profile', 'LLM unvollständig, inaktiv oder vom Org-Admin gesperrt', true);
    pass('profile', `Eigenes LLM ${cfg.name}`);
  } else if (f.startsWith('assist.') || f === 'mail.process') {
    if (!project!.ai_profile_id) return deny('profile', 'KI im Projekt nicht aktiv: keine Projekt-KI gewählt (Einstellungen › Projekt › Projekt-KI)', true);
    cfg = await aiConfigForProject(db, project!.id);
    if (!cfg) return deny('profile', 'Kein freigegebenes KI-Profil im Projekt (Freigabe entzogen oder LLM gesperrt; die PL wählt ein anderes)', true);
    pass('profile', `Projekt-KI ${cfg.name}`);
  }

  // 4 Budget: Agenten je Agent, Mail-KI und Assistenz je Projekt; 0 sperrt; gezählt werden nur ausgeführte Läufe
  if (q.budget !== false) {
    const now = q.now ?? new Date();
    const today = now.toISOString().slice(0, 10);
    if (isAgent) {
      const left = await agentBudgetLeft(db, subj, now);
      if (left <= 0) return deny('budget', `Tagesbudget von ${subj.name} ist aufgebraucht (Verwaltung › KI)`);
      pass('budget', `noch ${left} Läufe heute`);
    } else if (f === 'mail.process') {
      const used = (await db.one(`select count(*)::int as c from mail_ai_runs where project_id = $1 and mode = 'process' and status in ('ok','error') and started_at >= $2::date`, [project!.id, today])).c;
      if (used >= settings.agentDailyBudget) return deny('budget', `Tagesbudget der Mail-KI im Projekt erreicht (${settings.agentDailyBudget} Läufe)`);
      pass('budget', `noch ${settings.agentDailyBudget - used} Läufe heute`);
    } else if (f.startsWith('assist.')) {
      const used = (await db.one(`select count(*)::int as c from audit_log where project_id = $1 and action in ('ai.call','ai.final_reply') and created_at >= $2::date`, [project!.id, today])).c;
      if (used >= settings.assistDailyBudget) return deny('budget', `Tagesbudget der KI-Assistenz im Projekt erreicht (${settings.assistDailyBudget} Anfragen)`);
      pass('budget', `noch ${settings.assistDailyBudget - used} Anfragen heute`);
    }
  }
  return { decision: { allowed: true, reason: k.level === 'default' ? 'Erlaubt' : k.text, publicReason: k.level === 'default' ? 'Erlaubt' : k.publicText, stage: 'ok', rule, trace }, cfg };
}

/** Darf Person bzw. Agent diese KI-Funktion jetzt nutzen? Ergebnis mit Begründung, Stufe, entscheidender Regel und Spur. */
export async function aiAllowed(db: Db, q: AiQuery): Promise<AiDecision> {
  return (await checkAi(db, q)).decision;
}

/**
 * Ablehnung als Fehler einer Route: Sperren 403, fehlende Einrichtung (Projekt-KI, Profil) und Budget 400, jeweils mit Begründung;
 * shared: die Prüfung galt nicht der anfragenden Person (z. B. einem Agenten), dann ohne Namen und Notiz persönlicher Regeln.
 */
export function aiError(d: AiDecision, shared = false): HttpError {
  return new HttpError(d.missing || d.stage === 'budget' ? 400 : 403, shared ? d.publicReason : d.reason);
}
/** Fähigkeit für einen Knopf; Agenten des Projekts sehen alle Mitglieder, daher dort die Begründung für geteilte Orte. */
const cap = (d: AiDecision, shared = false): AiCapability => ({ allowed: d.allowed, reason: shared ? d.publicReason : d.reason, stage: d.stage });

/** Funktionen, die eine Person im Projekt nutzt; für die Knöpfe der Oberfläche. */
const PERSON_FEATURES: AiFeature[] = ['assist.summarize', 'assist.essence', 'assist.report', 'assist.ask', 'assist.final_reply', 'mail.process', 'agent.chat', 'pl.agents', 'pl.own_llm'];

/** Fähigkeiten im Projekt: je Funktion erlaubt oder die Begründung; für jeden Agenten des Projekts Läufe und Chat. */
export async function aiCapabilities(db: Db, user: User, projectId: string): Promise<AiCapabilities> {
  const features: AiCapabilities['features'] = {};
  for (const f of PERSON_FEATURES) features[f] = cap(await aiAllowed(db, { userId: user.id, projectId, feature: f, budget: f.startsWith('assist.') }));
  const agents = await db.query(`select u.id, u.name from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.kind = 'agent' order by u.name`, [projectId]);
  const out: AiCapabilities['agents'] = [];
  for (const a of agents.rows) out.push({ id: a.id, name: a.name, run: cap(await aiAllowed(db, { userId: a.id, projectId, feature: 'agent.run' }), true), chat: cap(await aiAllowed(db, { userId: a.id, projectId, feature: 'agent.chat' }), true) });
  return { killswitch: !(await orgAiSettings(db, user.orgId)).enabled, features, agents: out };
}

/** Profilachse: erlaubt der Mandant eigene LLMs für diese Projektart (aus, nur persönliche, alle)? */
export async function ownLlmAllowed(db: Db, orgId: string, projectId: string): Promise<boolean> {
  const s = await orgAiSettings(db, orgId);
  const p = await db.one(`select personal from projects where id = $1`, [projectId]);
  return s.ownLlm === 'all' || (s.ownLlm === 'personal' && Boolean(p.personal));
}
/** Eigenes LLM einbinden, umkonfigurieren oder als Projekt-KI wählen: Profilachse und Freigabe pl.own_llm für die PL; null = erlaubt. */
export async function ownLlmReason(db: Db, user: User, projectId: string): Promise<string | null> {
  if (!(await ownLlmAllowed(db, user.orgId, projectId))) return 'Eigene LLMs sind für dieses Projekt nicht freigegeben (Verwaltung › KI)';
  const d = await aiAllowed(db, { userId: user.id, projectId, feature: 'pl.own_llm' });
  return d.allowed ? null : d.reason;
}

/** Regel der KI-Freigaben setzen (allow/deny) oder entfernen (effect null = erben); Audit ai.policy.set bzw. ai.policy.delete. */
export async function setAiPolicy(db: Db, by: User, r: { projectId: string | null; userId: string | null; groupId: string | null; feature: string; effect: 'allow' | 'deny' | null; note?: string | null }): Promise<void> {
  const key = [by.orgId, r.projectId, r.userId, r.groupId, r.feature];
  if (r.effect === null) {
    const del = await db.maybeOne(`delete from ai_policies where org_id = $1 and project_id is not distinct from $2::uuid and user_id is not distinct from $3::uuid and group_id is not distinct from $4::uuid and feature = $5 returning id`, key);
    if (del) await audit(db, { orgId: by.orgId, projectId: r.projectId, userId: by.id, action: 'ai.policy.delete', objectType: 'ai_policy', objectId: del.id, details: { projectId: r.projectId, userId: r.userId, groupId: r.groupId, feature: r.feature } });
    return;
  }
  const row = await db.one(`insert into ai_policies (org_id, project_id, user_id, group_id, feature, effect, note, set_by) values ($1,$2,$3,$4,$5,$6,$7,$8)
    on conflict (org_id, project_id, user_id, group_id, feature) do update set effect = excluded.effect, note = excluded.note, set_by = excluded.set_by, updated_at = now() returning id`, [...key, r.effect, r.note ?? null, by.id]);
  await audit(db, { orgId: by.orgId, projectId: r.projectId, userId: by.id, action: 'ai.policy.set', objectType: 'ai_policy', objectId: row.id, details: { projectId: r.projectId, userId: r.userId, groupId: r.groupId, feature: r.feature, effect: r.effect, note: r.note ?? null } });
}

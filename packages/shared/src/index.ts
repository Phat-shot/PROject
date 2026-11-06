// Gemeinsame Typen für API und Web-Client.

export type GlobalRole = 'org_admin' | 'project_creator' | 'user';
/** Einzelne Verwaltungsrechte neben der globalen Rolle: KI (Profile, Freigaben, Notaus, Agenten), Gruppen, Pool-Ressourcen */
export type OrgRight = 'ai_admin' | 'groups_admin' | 'resources_admin';
export const ORG_RIGHTS: { key: OrgRight; label: string }[] = [
  { key: 'ai_admin', label: 'KI verwalten' },
  { key: 'groups_admin', label: 'Gruppen verwalten' },
  { key: 'resources_admin', label: 'Ressourcen-Pool verwalten' }
];
export type ProjectRole = 'pl' | 'member' | 'reader';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';
export type DocStatus = 'draft' | 'review' | 'final';
export type MailAccountType = 'personal' | 'project' | 'org';
export type MailProviderKind = 'imap' | 'dev' | 'graph';
export type DraftStatus = 'draft' | 'pending_approval' | 'sent' | 'failed';

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  /** Org-Rechte (z. B. ai_admin: Verwaltung › KI ohne Org-Admin zu sein) */
  orgRights?: OrgRight[];
  active: boolean;
  settings?: UserSettings;
  /** Zweiter Faktor (TOTP) aktiv */
  totpEnabled?: boolean;
  /** KI-Agent (kein Login, Mitglied oder stellvertretende PL, Zuweisung nur durch PL) */
  kind?: 'person' | 'agent';
  /** Agent einer PL: nur in diesem Projekt einsetzbar */
  agentProjectId?: string;
  /** Agentenrolle: project = Projektagent (einladbar), assistant = persönlicher Assistent einer Person (nur ihr persönliches Projekt, nur Direktnachrichten) */
  agentRole?: AgentRole;
  /** Persönliches Projekt je Person: null = Mandantenschalter „Persönliche Projekte“ gilt, true = freigegeben (auch ohne Schalter), false = gesperrt (KI im persönlichen Projekt aus) */
  personalProjectAllowed?: boolean | null;
  /** Verwalter mindestens einer Gruppe (pflegt deren Mitglieder unter Verwaltung); nur in /auth/me und bei der Anmeldung */
  managesGroups?: boolean;
}

export interface UserSettings {
  theme?: 'light' | 'dark' | 'system';
  /** In der Seitenleiste angeheftete Projekte (höchstens 5, in dieser Reihenfolge) */
  pinnedProjects?: string[];
  /** Bestätigungskarten der Agenten im Chat: needed (Standard) nur bei Abgelehntem, Angehaltenem, Aufträgen und Bestätigungen; all auch bei Notiz, Priorität usw. */
  chatCards?: 'needed' | 'all';
}
/** Schlüssel, die PATCH /me in settings annimmt (null löscht den Schlüssel) */
/**
 * Rückfrage des KI-Agenten im Chat (Systemkarte meta.card = 'choices'): Thema wählen, wenn das System die Absicht einer
 * Nachricht nicht sicher erkennt. value ist zugleich das Markerwort, das die Person als Antwort schicken kann
 * („Projekt WEB“, „persönlich“, „allgemein“); meta.chosen hält den gewählten Wert, meta.forMessageId die Ursprungsnachricht.
 */
export interface ChatChoice { label: string; value: string; hint?: string }
/** Absicht einer Chat-Nachricht an einen Agenten: allgemein (kein Projektbezug), ein Projekt, persönlicher Assistent */
export type ChatIntent = 'general' | 'project' | 'personal';
/** Rolle eines KI-Agenten (users.agent_role) */
export type AgentRole = 'project' | 'assistant';
/** Freigabe eines Mandanten-LLM für persönliche Projekte: none (Standard), all, users (nur personalUserIds) */
export type PersonalUse = 'none' | 'all' | 'users';
export const PERSONAL_USES: { key: PersonalUse; label: string }[] = [
  { key: 'none', label: 'nicht in persönlichen Projekten' },
  { key: 'all', label: 'alle persönlichen Projekte' },
  { key: 'users', label: 'nur ausgewählte Personen' }
];
/** Zustand des persönlichen Assistenten (GET /projects/:id/assistant) */
export interface AssistantState {
  /** vorhandener Assistent (Agent mit agentRole assistant) */
  assistant: { id: string; name: string; persona: string | null; active: boolean; aiProfileId: string | null; profileName: string | null; dailyBudget: number | null; channelId: string } | null;
  /** wählbare LLM-Profile: freigegebene Mandanten-Profile für diese Person und eigene LLMs des Projekts */
  profiles: { id: string; name: string; provider: 'anthropic' | 'local'; model: string; own: boolean }[];
  /** Sperrgründe (leer = Assistent anlegbar bzw. nutzbar) */
  blocked: string[];
  canCreate: boolean;
}

export const USER_SETTING_KEYS = ['theme', 'pinnedProjects', 'chatCards'] as const satisfies readonly (keyof UserSettings)[];

export interface Membership {
  projectId: string;
  userId: string;
  role: ProjectRole;
  isDeputy: boolean;
  canEditPlan: boolean;
  canApprove: boolean;
  canFinalize: boolean;
  canUseAi: boolean;
  /** nur Agenten: darf Mails direkt senden (sonst Entwurf zur Freigabe) */
  agentCanMail?: boolean;
  /** nur Agenten: Policy im Projekt (null = erben) */
  agentPolicy?: AgentPolicy | null;
  /** Herkunft (Regel M): Direkteintrag (überschreibt alle Gruppen) oder über Gruppen des Projekts (höchste Rolle, Einzelrechte ODER-verknüpft) */
  origin?: 'direct' | 'group';
}

/**
 * Planungstiefe eines Projekts: auto = Regel (Aufgabe bei eigener Zuständigkeit, eigenem Termin oder eigenem Status/Log, sonst
 * Checklistenpunkt), aufgaben = Schritte immer als Aufgaben, checkliste = Schritte immer als Checklistenpunkte (Aufgaben nur auf Wunsch).
 */
export type PlanningDepth = 'auto' | 'aufgaben' | 'checkliste';
export const PLANNING_DEPTHS: { key: PlanningDepth; label: string; hint: string }[] = [
  { key: 'auto', label: 'Automatisch (Regel)', hint: 'Aufgabe, wenn ein Schritt eine eigene Zuständigkeit, einen eigenen Termin oder eigenen Status und Log braucht (delegierbar, nachverfolgbar); sonst Checklistenpunkt einer Aufgabe, den die zuständige Person selbst abhakt.' },
  { key: 'aufgaben', label: 'Immer Aufgaben', hint: 'Jeder Schritt wird eine Aufgabe mit eigenem Status, Termin und Log; Checklistenpunkte nur an Aufgaben.' },
  { key: 'checkliste', label: 'Immer Checklistenpunkte', hint: 'Schritte werden Checklistenpunkte einer Aufgabe (neues Arbeitspaket: eine Aufgabe „Schritte“); weitere Aufgaben nur auf ausdrücklichen Wunsch (mit Termin oder eigener Zuständigkeit).' }
];
export interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  mailAddress: string | null;
  visibility: 'members' | 'org';
  /** Persönliches Projekt: nur der Ersteller (PL) und KI-Agenten */
  personal?: boolean;
  /** Schlanke Oberfläche (persönliches Projekt ohne showAllTabs): Reiter Plan, Risiken, Zeiten und Auswertung ausblenden; Datenmodell und Routen bleiben vollständig */
  slim?: boolean;
  /** Persönliches Projekt: alle Reiter zeigen (Projekteinstellung, PATCH /projects/:id) */
  showAllTabs?: boolean;
  /** Projektagent (dritte PL-Rolle): KI-Agent als Stellvertretung; agentMail: off = nur Rolle, process = bearbeitet neue Mails der Projektkonten direkt, triage = schlägt nur vor */
  agentUserId?: string | null;
  agentMail?: AgentMailMode;
  /** Agenten-Policy des Projekts (Rohwert; wirksam über GET /projects/:id/agent-policy) */
  agentPolicy?: AgentPolicy;
  mailInquiry?: MailInquiry;
  /** workflow = Mini-Projekt eines isolierten Workflow-Laufs (nicht in Projektlisten) */
  kind?: 'project' | 'workflow';
  timeTrackingEnabled: boolean;
  /** Arbeitspaket automatisch erledigt, wenn alle Aufgaben erledigt sind (Vorgabe, je AP übersteuerbar) */
  autoCompleteParent?: boolean;
  /** Aufgabe automatisch erledigt, wenn alle ihre Checklistenpunkte erledigt sind (Vorgabe, Standard an, je Aufgabe übersteuerbar über Task.autoComplete) */
  autoDoneAufgabe?: boolean;
  /** Planungstiefe: wie Schritte eines Arbeitspakets angelegt werden (auto = Regel Aufgabe vs. Checklistenpunkt, aufgaben, checkliste) */
  planningDepth?: PlanningDepth;
  budgetHours: number | null;
  escalation?: EscalationPolicy;
  reporting?: ReportingPolicy;
  reminders?: ReminderPolicy;
  health?: ProjectHealth;
  /** KI-Profil für die Projekt-KI (Zusammenfassen, Essenz, Fragen, Statusbericht); null = aus */
  aiProfileId?: string | null;
  /** Externes Profil (Informationsgrenze): was Externe über das Projekt erfahren dürfen; pflegt die PL */
  externalProfile?: ExternalProfile;
  myRole?: ProjectRole;
  myMembership?: Membership;
  /** Kennzahlen für Projektkarten (nur in der Projektliste) */
  stats?: { open: number; overdue: number; done: number; nextMilestone: { name: string; date: string } | null };
}

export interface EscalationPolicy {
  enabled: boolean;
  stageDays: [number, number, number];
  staleDays: number;
  contactUserId: string | null;
  contactEmail: string | null;
  externalMode: 'proposal' | 'direct';
}

/** Erinnerungen über das Projektkonto an externe (und wahlweise interne) Zuständige vor und nach der Fälligkeit. */
export interface ReminderPolicy {
  enabled: boolean;
  /** Tage vor Fälligkeit, z. B. [3, 0] = drei Tage vorher und am Tag selbst */
  daysBefore: number[];
  /** Nach Fälligkeit alle n Tage erinnern; null = keine Erinnerung bei Verzug */
  overdueEveryDays: number | null;
  /** Auch interne Zuständige per Mail erinnern (zusätzlich zu den In-App-Meldungen) */
  includeInternal: boolean;
}

/** Reporting: Vorlage im Rhythmus an einen Empfängerkreis, erzeugt und versendet vom Worker. */
export interface ReportingPolicy {
  enabled: boolean;
  templateKey: string;
  interval: 'weekly' | 'biweekly' | 'monthly';
  /** ISO-Wochentag 1 (Mo) … 7 (So) für weekly/biweekly */
  weekday: number;
  /** Tag im Monat 1 … 28 für monthly */
  dayOfMonth: number;
  recipients: string[];
  /** proposal: Entwurf + Prüfung durch PL; direct: final setzen und sofort als PDF senden */
  mode: 'proposal' | 'direct';
  /** Oberseite, unter der Berichte abgelegt werden */
  parentPageId: string | null;
  lastRunOn: string | null;
  lastPageId: string | null;
  /** Aufbau des Berichts: Blöcke untereinander; leer/undefined = Standard „Management-Report“ (DEFAULT_REPORT_BLOCKS) */
  blocks?: ReportBlock[];
  /** Texte regelbasiert („rules“) oder von der Projekt-KI formuliert („ai“, fällt ohne Agent/Freigabe auf rules zurück) */
  textSource?: 'rules' | 'ai';
  /** Grafische Ausarbeitung (Diagramme als SVG in Seite und PDF) für alle Blöcke, die es unterstützen */
  graphic?: boolean;
}

/** Code-Standards der Projekt-Policies ohne Org-Ebene; die Oberfläche zeigt „Standard“, solange ein Projekt nichts Eigenes gesetzt hat. */
export const DEFAULT_ESCALATION: EscalationPolicy = { enabled: true, stageDays: [2, 5, 10], staleDays: 7, contactUserId: null, contactEmail: null, externalMode: 'proposal' };
export const DEFAULT_REMINDERS: ReminderPolicy = { enabled: false, daysBefore: [3, 0], overdueEveryDays: 3, includeInternal: false };
/** Zeitraum eines Berichtsblocks: seit dem letzten Bericht, letzte Woche/Monat/Quartal oder n Tage */
export type ReportPeriod = 'since_last' | 'week' | 'month' | 'quarter' | 'days';

/** Blocktypen des Berichts (untereinander angeordnet) */
export type ReportBlockType =
  | 'summary'      // Gesamtstand: Ampel, Fortschritt Soll/Ist, Kennzahlen
  | 'changes'      // Änderungen im Zeitraum: erledigt, neu, Termine verschoben, Statuswechsel
  | 'overdue'      // Überfällige Arbeitspakete
  | 'blocked'      // Blockiert und eskaliert
  | 'milestones'   // Nächste und erreichte Meilensteine
  | 'subprojects'  // Fortschritt je Teilprojekt
  | 'risks'        // RAID-Register (offene Risiken/Issues/Entscheidungen)
  | 'time'         // Gebuchte Zeit im Zeitraum (je Person / Teilprojekt)
  | 'decisions'    // Entscheidungen und Meldungen (Log) im Zeitraum
  | 'outlook'      // Ausblick: fällig in den nächsten n Tagen
  | 'ai_summary'   // Management-Summary als KI-Text (Fallback: Regeltext)
  | 'text';        // Freitext der PL

export interface ReportBlock {
  id: string;
  type: ReportBlockType;
  /** Überschrift; leer = Standardtitel des Typs */
  title?: string;
  /** Zeitraum (nur Blöcke mit Zeitbezug) */
  period?: ReportPeriod;
  /** Tage für period = 'days' bzw. Vorschau-Horizont bei 'outlook' */
  days?: number;
  /** Diagramm statt/zusätzlich zur Tabelle, wenn der Typ es unterstützt */
  chart?: boolean;
  /** Maximale Listenlänge */
  limit?: number;
  /** Freitext (type = 'text') als Markdown */
  text?: string;
}

export const REPORT_BLOCK_LABEL: Record<ReportBlockType, string> = {
  summary: 'Gesamtstand', changes: 'Änderungen im Zeitraum', overdue: 'Überfällig', blocked: 'Blockiert und eskaliert', milestones: 'Meilensteine',
  subprojects: 'Teilprojekte', risks: 'Risiken und Entscheidungen (RAID)', time: 'Gebuchte Zeit', decisions: 'Entscheidungen und Meldungen', outlook: 'Ausblick',
  ai_summary: 'Management-Summary (KI)', text: 'Freitext'
};

/** Standard „Management-Report“: Gesamtstand, Änderungen seit dem letzten Bericht, Risiken, Meilensteine, Ausblick */
export const DEFAULT_REPORT_BLOCKS: ReportBlock[] = [
  { id: 'b1', type: 'summary', chart: true },
  { id: 'b2', type: 'changes', period: 'since_last', chart: true, limit: 15 },
  { id: 'b3', type: 'overdue', limit: 10 },
  { id: 'b4', type: 'blocked', limit: 10 },
  { id: 'b5', type: 'milestones', limit: 5 },
  { id: 'b6', type: 'risks', limit: 10 },
  { id: 'b7', type: 'outlook', days: 14, limit: 10 }
];

export const DEFAULT_REPORTING: ReportingPolicy = { enabled: false, templateKey: 'statusbericht', interval: 'weekly', weekday: 5, dayOfMonth: 1, recipients: [], mode: 'proposal', parentPageId: null, lastRunOn: null, lastPageId: null, blocks: DEFAULT_REPORT_BLOCKS, textSource: 'rules', graphic: true };

export interface EscalationRow {
  taskId: string; title: string; projectId: string; level: number; targetLevel: number; overdueDays: number; staleDays: number; blocked: boolean; blockedReason: string | null;
  score: number; dueDate: string | null; responsible: string | null; chain: string[]; reason: string;
}

export interface OrgSettings {
  company?: string;
  accentColor?: string;
  footerText?: string;
  /** Zeiterfassung mandantenweit aus: blendet Zeiten, Aufwand und Buchungen überall aus */
  timeTracking?: boolean;
  /** Alle Benutzer dürfen ein persönliches Projekt (Assistent) anlegen */
  personalProjects?: boolean;
  /** Standard der Mail-Rückfrage für Projekte (Konzept 5) */
  mailInquiry?: MailInquiry;
  /** KI-Modul: Anbieter, Modell, lokale Adresse, Tagesbudget je Agent; der Schlüssel liegt getrennt und verlässt den Server nie. enabled = false ist der Notaus */
  /** Benachrichtigungen: Stunde des Tages-Digests (Europe/Berlin, Standard 7) */
  notify?: { digestHour?: number };
  ai?: { enabled?: boolean; /** Tagesbudget je Agent (Obergrenze; der Verwalter des LLM setzt je Agent weniger) */ agentDailyBudget?: number; /** Eigene LLMs der Projekte: aus, nur persönliche Projekte (Standard) oder alle */ ownLlm?: 'off' | 'personal' | 'all'; /** Außenprüfung für Agenten-Mails an Nicht-Interne: strict = neu formulieren und prüfen (Standard), check = nur prüfen */ externalGuard?: 'strict' | 'check'; /** Online-Recherche (Konzept 8): Suchdienst für lokale Profile, Grenzen, Domains */ web?: WebSearchSettings; /** Arbeitszeitfenster für Mails der Agenten nach außen (Standard Mo–Fr 07–19 Europe/Berlin) */ externalWindow?: ExternalWindow };
}

/**
 * Rechte eines KI-Agenten: Funktionskatalog. Im Projekt arbeiten nur Agenten; wer das LLM eines Agenten verwaltet, legt fest,
 * was er darf (users.agent_rights), die PL schränkt im Projekt nur weiter ein. who: Assistenz löst eine Person aus („KI nutzen“),
 * ausgeführt wird sie von einem Agenten; defaultDeny = beim Anlegen aus.
 */
export type AiFeatureCategory = 'assist' | 'mail' | 'agent' | 'action';
export const AI_CATEGORIES: { key: AiFeatureCategory; label: string; hint: string }[] = [
  { key: 'assist', label: 'Assistenz', hint: 'auf Knopfdruck einer Person mit „KI nutzen“' },
  { key: 'mail', label: 'Mail', hint: 'Mails im Projekt vorschlagen oder bearbeiten' },
  { key: 'agent', label: 'Arbeit', hint: 'Arbeitspakete, Chat, Aufträge, Recherche' },
  { key: 'action', label: 'Aktionen', hint: 'was er dabei verändern darf' }
];
export interface AiFeatureDef { key: string; category: AiFeatureCategory; label: string; who: 'person' | 'agent' | 'both'; defaultDeny?: boolean }
export const AI_FEATURES = [
  { key: 'assist.summarize', category: 'assist', label: 'Mail zusammenfassen', who: 'both' },
  { key: 'assist.essence', category: 'assist', label: 'Essenz in Arbeitspaket oder Seite', who: 'both' },
  { key: 'assist.report', category: 'assist', label: 'Statusbericht-Entwurf', who: 'both' },
  { key: 'assist.ask', category: 'assist', label: 'Frage ans Projekt', who: 'both' },
  { key: 'assist.final_reply', category: 'assist', label: 'Abschluss-Antwort formulieren', who: 'both' },
  { key: 'mail.triage', category: 'mail', label: 'Zu Mails vorschlagen (als Mitglied)', who: 'agent' },
  { key: 'agent.mail', category: 'mail', label: 'Mails direkt bearbeiten (als Projektagent)', who: 'agent' },
  { key: 'agent.run', category: 'agent', label: 'Arbeitspakete bearbeiten', who: 'agent' },
  { key: 'agent.chat', category: 'agent', label: 'Chat', who: 'both' },
  { key: 'agent.order', category: 'agent', label: 'Aufträge im Chat annehmen', who: 'both' },
  { key: 'agent.web', category: 'agent', label: 'Online-Recherche', who: 'agent', defaultDeny: true },
  { key: 'agent.finalize', category: 'action', label: 'Final setzen', who: 'agent' },
  { key: 'agent.distribute', category: 'action', label: 'PDF an Verteiler', who: 'agent' },
  { key: 'agent.send_external', category: 'action', label: 'Mails nach außen', who: 'agent' },
  { key: 'agent.close', category: 'action', label: 'Erledigt setzen', who: 'agent' },
  { key: 'agent.restructure', category: 'action', label: 'Umstrukturieren', who: 'agent' },
  { key: 'agent.plan', category: 'action', label: 'Planen', who: 'agent' },
  { key: 'agent.assign', category: 'action', label: 'Zuweisen', who: 'agent' },
  { key: 'agent.schedule', category: 'action', label: 'Termine ändern', who: 'agent' },
  { key: 'agent.foreign', category: 'action', label: 'Fremde Arbeitspakete', who: 'agent' },
  { key: 'agent.workflow', category: 'action', label: 'Workflow-Schritte übernehmen', who: 'agent' }
] as const satisfies readonly AiFeatureDef[];
export type AiFeature = (typeof AI_FEATURES)[number]['key'];
/** Rechte eines neuen Agenten (alles außer defaultDeny) */
export const DEFAULT_AGENT_RIGHTS: AiFeature[] = AI_FEATURES.filter((f) => !('defaultDeny' in f && f.defaultDeny)).map((f) => f.key);

/** Prüfstufen von aiAllowed: Notaus → Rechte des Agenten (Verwalter des LLM) → Ebene der PL → Profil → Budget. */
export type AiStage = 'killswitch' | 'policy' | 'project' | 'profile' | 'budget' | 'ok';
export interface AiTraceStep { stage: AiStage; ok: boolean; text: string }
export interface AiDecision {
  allowed: boolean;
  /** Begründung: bei Sperre die erste Sperre, sonst kurz, was gilt */
  reason: string;
  /**
   * Begründung für geteilte Orte (Projektkanal, Lauflisten, Fähigkeiten der Agenten): ohne Namen und Notiz, wenn eine Regel
   * für eine Person, eine Gruppe oder eine Ausnahme entschieden hat; sonst wie reason
   */
  publicReason: string;
  stage: AiStage;
  /** fehlende Einrichtung (keine Projekt-KI, kein Profil) statt Sperre */
  missing?: boolean;
  trace: AiTraceStep[];
}
export type AiCapability = Pick<AiDecision, 'allowed' | 'reason' | 'stage'>;
/**
 * Was die angemeldete Person im Projekt mit KI darf, je Assistenz-Funktion mit Begründung (Person und ausführender Agent);
 * dazu die Agenten des Projekts mit ihren Assistenz-Rechten und der Standard-Agent (Projektagent, sonst der einzige geeignete).
 */
export interface AiCapabilities {
  killswitch: boolean;
  features: Partial<Record<AiFeature, AiCapability>>;
  agents: { id: string; name: string; run: AiCapability; chat: AiCapability; assist: AiFeature[]; projectAgent: boolean }[];
  /** Agent, der Assistenz ohne Auswahl ausführt; null = mehrere geeignet, die Person wählt */
  assistAgentId: string | null;
}

/**
 * KI-Feedback: ausdrücklich (Daumen mit Kommentar) oder automatisch aus Entscheidungen und Prüfungen des Systems. Gesichert,
 * damit Prompt, KI-Sheet und Agenten laufend besser werden; lesen und exportieren nur die KI-Verwaltung.
 */
export const AI_FEEDBACK_KINDS = [
  { key: 'rating', label: 'Bewertung' },
  { key: 'proposal_rejected', label: 'Vorschlag abgelehnt' },
  { key: 'proposal_edited', label: 'Vorschlag bearbeitet übernommen' },
  { key: 'action_rejected', label: 'Angehaltene Aktion abgelehnt' },
  { key: 'mail_suggestion_rejected', label: 'Mail-Vorschlag verworfen' },
  { key: 'draft_rejected', label: 'Mail-Entwurf abgelehnt' },
  { key: 'draft_edited', label: 'Mail-Entwurf bearbeitet' },
  { key: 'claim_replaced', label: 'Behauptung ersetzt' },
  { key: 'command_failed', label: 'Befehl nicht ausgeführt' },
  { key: 'run_error', label: 'Lauf mit Fehler' }
] as const;
export type AiFeedbackKind = (typeof AI_FEEDBACK_KINDS)[number]['key'];
export interface AiFeedbackEntry {
  id: string; kind: AiFeedbackKind; rating: 1 | -1 | null; comment: string | null; sourceType: string; sourceId: string;
  agent: { id: string; name: string } | null; user: { id: string; name: string } | null; project: string | null;
  /** Ausschnitt: input (worauf der Agent reagierte), output (was er lieferte), before/after (Bearbeitung), reason, detail */
  context: Record<string, unknown>; createdAt: string; updatedAt: string;
}

export type AiProposalKind = 'task_update' | 'page_append' | 'agent_action';
export interface AiProposal {
  id: string;
  projectId: string;
  kind: AiProposalKind;
  mailId: string | null;
  taskId: string | null;
  pageId: string | null;
  /** task_update: summary, logEntry, columnName, dueDate, questions; page_append: section (Markdown) */
  payload: { summary?: string; logEntry?: string; columnName?: string | null; dueDate?: string | null; questions?: string[]; section?: string; /** agent_action: die angehaltene Aktion, ihr Kurztext und der Stand, auf den sie sich bezieht */ action?: Record<string, unknown>; label?: string; base?: Record<string, unknown> };
  status: 'pending' | 'approved' | 'rejected' | 'stale' | 'failed' | 'expired' | 'withdrawn';
  /** agent_action: Aktionsklasse, Reihenfolge, Frage approval, Lauf, Ergebnis */
  actionClass?: AgentActionClass | null; seq?: number; questionId?: string | null; agentRunId?: string | null; result?: string | null; agentName?: string | null;
  createdBy: string | null;
  createdByName: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  createdAt: string;
  taskTitle: string | null;
  pageTitle: string | null;
  mailSubject: string | null;
}

export interface TimeEntry {
  id: string;
  projectId: string;
  projectKey?: string;
  taskId: string | null;
  taskTitle: string | null;
  userId: string;
  userName: string | null;
  date: string;
  minutes: number;
  note: string | null;
  createdAt: string;
}

export interface BoardColumn {
  id: string;
  projectId: string;
  name: string;
  position: number;
  isDone: boolean;
  /** backlog = Geplant, active = in Bearbeitung, parked = Zurückgestellt, done = Erledigt */
  kind: 'backlog' | 'active' | 'review' | 'waiting' | 'parked' | 'done';
  wipLimit: number | null;
  /** Spaltengruppe: Spalten mit gleichem Namen erscheinen im Board als eine Spalte mit Abschnitten untereinander */
  group: string | null;
}

export interface Label {
  id: string;
  projectId: string;
  name: string;
  color: string;
  position: number;
}

export const LABEL_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'teal'] as const;

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly' | 'monthly_weekday';
  interval?: number;
  nth?: number;
  weekday?: number;
  mode: 'on_due' | 'after_done';
  leadDays?: number;
}

export interface Subproject {
  id: string;
  projectId: string;
  name: string;
  /** Ziel und Abgrenzung (auch Kontext für Agenten) */
  description?: string | null;
  responsibleUserId: string | null;
  responsible: ResponsibleInfo;
  startDate: string | null;
  endDate: string | null;
  position: number;
  /** Nur für PL, Verantwortliche und benannte Benutzer/Gruppen sichtbar */
  restricted: boolean;
  accessUserIds: string[];
  accessGroupIds: string[];
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  /** Gruppenname beim Identitätsanbieter (SSO): Mitgliedschaft wird bei jeder Anmeldung abgeglichen */
  idpName?: string | null;
  memberIds: string[];
  /** Gruppenverwalter: pflegen die Mitglieder dieser Gruppe (ohne Org-Recht „Gruppen verwalten“) */
  managerIds: string[];
}

/** Gruppe als Projektmitglied: Rolle Leser oder Mitglied plus Einzelrechte; PL und Stellvertretung bleiben einzelne Personen. */
export interface ProjectGroup {
  projectId: string;
  groupId: string;
  name: string;
  role: 'member' | 'reader';
  canEditPlan: boolean;
  canApprove: boolean;
  canFinalize: boolean;
  canUseAi: boolean;
  memberIds: string[];
}

/** Projekt in der Verwaltung (Org-Admin): nur Kennung, Name und verantwortliche PL, keine Inhalte. */
export interface AdminProject {
  id: string;
  key: string;
  name: string;
  status: 'active' | 'archived';
  lead: { userId: string; name: string; active: boolean } | null;
}

export interface Invitation {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  /** Einladung direkt in ein Projekt (durch den PL): Annahme macht die Person zum Mitglied mit dieser Rolle */
  projectId?: string | null;
  projectRole?: 'member' | 'reader' | null;
  /** Einladung ohne Projekt: persönliches Projekt bei Annahme anlegen und freigeben (Opt-out, Standard an) */
  personalProject?: boolean;
  createdAt: string;
  expiresAt: string;
  sentAt: string | null;
  sendError: string | null;
  acceptedAt: string | null;
  link: string;
}

export interface ResponsibleInfo {
  userId: string | null;
  email: string | null;
  name: string | null;
  inherited: boolean;
  inheritedFrom: 'task' | 'subproject' | 'project' | null;
}

export interface Task {
  id: string;
  projectId: string;
  /** Fortlaufende Nummer im Projekt; Kennung = Projektkürzel-Nummer (WEB-12) */
  number: number;
  subprojectId: string | null;
  columnId: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  startDate: string | null;
  dueDate: string | null;
  responsibleUserId: string | null;
  responsibleEmail: string | null;
  responsible: ResponsibleInfo;
  position: number;
  mailCode: string;
  done: boolean;
  conflicts: string[];
  labelIds: string[];
  archivedAt: string | null;
  /** Im Papierkorb seit; zählt nirgends mehr mit, bis es wiederhergestellt wird */
  deletedAt: string | null;
  /** Außenbeschreibung: was Externe zu diesem AP erfahren dürfen (Außenkontext der Agenten) */
  externalBrief?: string | null;
  /** KI-Agent an diesem Arbeitspaket pausiert (PL) */
  agentPaused?: boolean;
  /** Automatik je Element, null = Vorgabe des Projekts: am Arbeitspaket „erledigt, wenn alle Aufgaben erledigt“ (autoCompleteParent),
   *  an einer Aufgabe „erledigt, wenn alle Checklistenpunkte erledigt“ (autoDoneAufgabe) */
  autoComplete?: boolean | null;
  /** Von der Automatik erledigt (letzter Checklistenpunkt); ein wieder geöffneter Punkt holt die Aufgabe in die vorherige Spalte zurück */
  autoDoneAt?: string | null;
  /** Lauf des Agenten steht an oder läuft gerade */
  agentRunning?: boolean;
  /** Wartezustand des Agenten: worauf, seit wann, Nachfassen/Eskalation geplant */
  /** Spalte „Wartet“: worauf, bis wann (Frist ohne Lösung → Zurückgestellt), abgelaufen am */
  wait?: { reason: string; until: string | null; expiredAt: string | null } | null;
  agentWait?: { kind: 'reply' | 'date' | 'task' | 'info'; reason: string; since: string; remindAt?: string | null; escalateAt?: string | null; reminded?: boolean; escalated?: boolean } | null;
  agentNextCheckAt?: string | null;
  /** Selbstständigkeit für dieses AP und seine Aufgaben (null = erben) */
  agentPolicy?: AgentPolicy | null;
  /** Auftraggeber (Auftrag per Chat): steht an erster Stelle der Kette */
  requestedBy?: { userId: string; name: string | null } | null;
  recurrence: Recurrence | null;
  estimateMinutes: number | null;
  loggedMinutes: number;
  blocked: boolean;
  blockedReason: string | null;
  escalationLevel: number;
  escalatedAt: string | null;
  /** Arbeitspaket stammt aus einem Workflow-Lauf */
  workflowRunId?: string | null;
  hasDescription: boolean;
  commentCount: number;
  attachmentCount: number;
  mailCount: number;
  checklistDone: number;
  checklistTotal: number;
  checklist?: ChecklistItem[];
  /** Aufgabe: gehört zu diesem Arbeitspaket (eine Ebene tief); null = Arbeitspaket */
  parentId: string | null;
  parent: { id: string; number: number; title: string } | null;
  /** Aufgaben eines Arbeitspakets: erledigt / gesamt */
  subtaskDone: number;
  subtaskTotal: number;
  predecessorIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  projectId: string | null;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  /** Ereignisklasse (Benachrichtigungsregeln) */
  event?: NotifyEvent;
  /** Bezug: Frage, Chat-Kanal, Thread, Arbeitspaket, Seite oder Buchung (Gelesen- und Erledigt-Status, Deep-Link) */
  ref?: { type: NotifyRefType; id: string } | null;
  /** erledigt (z. B. Frage beantwortet); bis dahin „offen für mich“ */
  resolvedAt?: string | null;
  /** Mail-Modus, beim Erzeugen nach Regel N festgeschrieben */
  mail?: NotifyMail;
}

/**
 * Benachrichtigungsregeln (Regel N): jede Meldung gehört zu einer Ereignisklasse; die Regeln setzen je Klasse Empfänger
 * (Rollen), Kanäle (In-App immer, Chat, Mail, Log, Doku) und Fristen. Ebenen: Code → Org → Projekt → AP → Benutzer →
 * Benutzer im Projekt → Benutzer am AP; jede gesetzte Angabe überschreibt die vorige, Org und Projekt können Felder sperren.
 */
export type NotifyEvent = 'question' | 'decision' | 'approval' | 'synergy' | 'confirm' | 'order_request' | 'external_referral' | 'progress' | 'assigned' | 'blocked' | 'escalation' | 'review' | 'mail_in' | 'log' | 'due' | 'chat' | 'booking' | 'info';
export type NotifyRefType = 'question' | 'chat_channel' | 'chat_thread' | 'task' | 'page' | 'booking';

/** Offene Fragen (Konzept 5): ein Objekt für Chat-Stelle, Meldungen, Log, Warten und Antwort */
export type QuestionKind = 'question' | 'decision' | 'confirm' | 'approval' | 'synergy' | 'order_request' | 'external_referral';
export type QuestionStatus = 'open' | 'answered' | 'escalated' | 'cancelled';
export interface Question {
  id: string; projectId: string; taskId: string | null; meetingId: string | null; kind: QuestionKind; status: QuestionStatus; level: number; parentId: string | null;
  askedBy: string; askedByName: string | null; addresseeId: string | null; addresseeName: string | null; addresseeRole: string | null;
  body: string; options: { key: string; label: string }[] | null; channelId: string | null; messageId: string | null;
  remindAt: string | null; escalateAt: string | null; remindedAt: string | null;
  answeredBy: string | null; answeredByName: string | null; answeredAt: string | null; answerSource: 'chat' | 'task' | 'meeting' | 'mail' | 'system' | null; answerText: string | null; answerOption: string | null;
  cancelReason: string | null; createdAt: string; taskCode: string | null; taskTitle: string | null; projectKey: string | null;
  /** Thema und Bezug (z. B. mail_inquiry mit mailId und openPoints) */
  context?: Record<string, unknown> | null;
  /** approval: angehaltene Aktionen des Agenten an dieser Frage */
  proposals?: { id: string; status: string; class: AgentActionClass | null; label: string; seq: number }[] | null;
}
/** Mail-Rückfrage je Projekt: bei neuer Mail mit offenen Punkten die PL fragen, im Projekt fragen, beim Absender nachfragen oder nichts */
export type MailInquiryMode = 'ask_pl' | 'ask_project' | 'ask_sender' | 'off';
export interface MailInquiry { mode: MailInquiryMode; /** Frist in Stunden, nach der eine Rückfrage im Projekt weitergegeben wird */ waitHours: number; /** vom Mandanten geerbt (Projekt ohne eigene Einstellung) */ inherited?: boolean }
export type AgentMailMode = 'off' | 'triage' | 'process';
/** Online-Recherche: Anthropic-Profile nutzen das Server-Tool web_search; lokale Profile brauchen SearXNG oder Brave. Schlüssel nur schreibend. */
export interface WebSearchSettings { provider?: 'none' | 'searxng' | 'brave'; url?: string | null; hasKey?: boolean; maxPerRun?: number; dailyPerAgent?: number; allowedDomains?: string[]; blockedDomains?: string[] }
/** Arbeitszeitfenster für Mails nach außen: außerhalb wird der Versand auf den nächsten Fensterbeginn geplant */
export interface ExternalWindow { enabled: boolean; /** 1 = Montag … 7 = Sonntag */ days: number[]; from: string; to: string }
/** Beziehung zwischen zwei Arbeitspaketen (Synergie, Konzept 6.7) */
export interface TaskRelation { id: string; projectId: string; kind: 'related' | 'sync' | 'duplicate' | 'dependency'; status: 'suggested' | 'asked' | 'accepted' | 'rejected'; signals: { type: string; detail: string }[]; note: string | null; leadTaskId: string | null; questionId: string | null; foundByName: string | null; decidedByName: string | null; decidedAt: string | null; createdAt: string; other: { id: string; ref: string; title: string; done: boolean } }
/** Projektüberblick je Sichtbarkeit: Struktur aus Daten, Steckbrief vom Projektagenten */
export interface ProjectDigest { structure: string; brief: string | null; builtAt: string; briefRunId: string | null }
export interface WebSource { id: string; runId: string | null; taskId: string | null; pageId: string | null; query: string | null; url: string; title: string | null; citedText: string | null; retrievedAt: string }
/** Agenten-Policy (Konzept 6): Selbstständigkeit und Aktionsklassen, die bestätigt werden */
export type AgentMode = 'auto' | 'confirm_critical' | 'confirm_all';
export type AgentActionClass = 'finalize' | 'distribute' | 'send_external' | 'close' | 'restructure' | 'plan' | 'assign' | 'schedule' | 'foreign';
export const AGENT_MODES: { key: AgentMode; label: string }[] = [
  { key: 'auto', label: 'Selbstständig' },
  { key: 'confirm_critical', label: 'Rückfrage bei wichtigen Schritten' },
  { key: 'confirm_all', label: 'Rückfrage bei allem' }
];
export const AGENT_ACTION_CLASSES: { key: AgentActionClass; label: string; critical: boolean }[] = [
  { key: 'finalize', label: 'Final setzen oder aufheben', critical: true },
  { key: 'distribute', label: 'PDF an Verteiler', critical: true },
  { key: 'send_external', label: 'Mails nach außen', critical: true },
  { key: 'close', label: 'Erledigt setzen', critical: true },
  { key: 'restructure', label: 'Umstrukturieren', critical: true },
  { key: 'plan', label: 'Planen (Arbeitspakete, Teilprojekte, Meilensteine)', critical: false },
  { key: 'assign', label: 'Zuweisen an Dritte', critical: false },
  { key: 'schedule', label: 'Bestehende Termine ändern', critical: false },
  { key: 'foreign', label: 'Fremde Arbeitspakete ändern', critical: false }
];
/** Je Ebene gesetzte Felder; Grenzen (maxMode, lockedConfirm) gelten für tiefere Ebenen; workflows = Workflow-Schritte übernehmen */
/** Wer Agenten im Chat Aufträge geben darf (Konzept 7.1): PL und Stellvertretung immer; tp = dazu Teilprojekt-Verantwortung im eigenen TP; responsible = dazu Zuständige für Aufgaben unter dem eigenen AP; members = alle Mitglieder */
export type ChatOrdersLevel = 'pl' | 'tp' | 'responsible' | 'members';
/** Reichweite: zugewiesene Arbeitspakete oder das ganze Projekt (Projektdurchlauf); Synergien: aus, nachfragen oder nutzen */
export type AgentScope = 'task' | 'project';
export type SynergyMode = 'off' | 'ask' | 'use';
/** Denktiefe: schnell (eine Leserunde, knapper Kontext), Standard, gründlich (vier Leserunden, voller Kontext, kostet zwei Läufe) */
export type AgentDepth = 'quick' | 'standard' | 'deep';
export const AGENT_DEPTHS: { key: AgentDepth; label: string }[] = [{ key: 'quick', label: 'schnell' }, { key: 'standard', label: 'Standard' }, { key: 'deep', label: 'gründlich' }];
export interface AgentPolicy { /** nur Agent im Projekt: von der PL abgeschaltete Rechte */ deny?: AiFeature[]; mode?: AgentMode; confirm?: AgentActionClass[]; maxMode?: AgentMode; lockedConfirm?: AgentActionClass[]; workflows?: boolean; chatOrders?: ChatOrdersLevel; scope?: AgentScope; synergies?: SynergyMode; /** Uhrzeit des Projektdurchlaufs (Europe/Berlin, werktags) */ reviewAt?: string; depth?: AgentDepth; /** Grenze (Org, Projekt): höchste erlaubte Denktiefe */ maxDepth?: AgentDepth }
/** Wirksame Policy mit Herkunft je Feld */
export interface EffectiveAgentPolicy {
  mode: AgentMode; confirm: AgentActionClass[]; workflows: boolean; chatOrders: ChatOrdersLevel; scope: AgentScope; synergies: SynergyMode; reviewAt: string; depth: AgentDepth;
  origin: { mode: string; confirm: Partial<Record<AgentActionClass, string>>; workflows: string; chatOrders: string; scope: string; synergies: string; depth: string };
  /** über KI-Freigaben gesperrte Klassen mit Begründung */
  denied: Partial<Record<AgentActionClass, string>>;
}
/** Chat: aus, Systembeitrag im zugehörigen Thread (Frage, Auftrag, Direktnachricht des Agenten) oder im Projektkanal */
export type NotifyChat = 'off' | 'thread' | 'project';
export type NotifyMail = 'off' | 'now' | 'digest';
/** Zwischenstände: jeder Lauf mit Ergebnis, Meilensteine (Status, In Prüfung, Entscheidung), einmal am Tag, nur Abschluss */
export type NotifyEvery = 'each' | 'milestones' | 'daily' | 'done';
export interface NotifyFields {
  /** geordnete Rollenliste; „a|b“ = a, sonst b */
  recipients?: string[];
  chat?: NotifyChat;
  mail?: NotifyMail;
  log?: boolean;
  /** Seite „Entscheidungen und Meldungen“ (ID) oder aus */
  doc?: string | false;
  remindH?: number;
  escalateH?: number;
  expireH?: number;
  every?: NotifyEvery;
}
export type NotifyField = keyof NotifyFields;
export const NOTIFY_FIELDS: NotifyField[] = ['recipients', 'chat', 'mail', 'log', 'doc', 'remindH', 'escalateH', 'expireH', 'every'];
export const NOTIFY_TIMING: NotifyField[] = ['remindH', 'escalateH', 'expireH', 'every'];
/** Ebenen der Regel N; code = NOTIFY_DEFAULTS */
export type NotifyLevel = 'code' | 'org' | 'project' | 'task' | 'user' | 'user_project' | 'user_task';
export const NOTIFY_LEVEL_LABEL: Record<NotifyLevel, string> = { code: 'Standard', org: 'Org', project: 'Projekt', task: 'AP', user: 'Benutzer', user_project: 'Benutzer im Projekt', user_task: 'Benutzer am AP' };
/** Felder je Ebene: Empfänger, Log, Doku und Fristen nur Org/Projekt/AP (Doku nur Projekt); Benutzer nur Chat und Mail, am AP dazu every (Berichtswunsch). */
export const NOTIFY_LEVEL_FIELDS: Record<Exclude<NotifyLevel, 'code'>, NotifyField[]> = {
  org: ['recipients', 'chat', 'mail', 'log', 'remindH', 'escalateH', 'expireH', 'every'],
  project: ['recipients', 'chat', 'mail', 'log', 'doc', 'remindH', 'escalateH', 'expireH', 'every'],
  task: ['recipients', 'chat', 'mail', 'log', 'remindH', 'escalateH', 'expireH', 'every'],
  user: ['chat', 'mail'],
  user_project: ['chat', 'mail'],
  user_task: ['chat', 'mail', 'every']
};
export interface NotifyEventDef {
  key: NotifyEvent;
  label: string;
  /** welche Meldungen dazugehören */
  types: string;
  /** Standard-Empfänger in Worten (bei „von der Aufrufstelle“ ergänzen Regeln weitere Rollen) */
  recipientsText: string;
  /** Fragearten: der Chat ist die Frage selbst (Thread, nicht abschaltbar) */
  fixedChat?: boolean;
  /** Chat-Meldungen: kein eigener Chat-Kanal */
  noChat?: boolean;
  /** Fristen einstellbar (Erinnern, Weitergeben, Ablauf, Zwischenstände) */
  timing?: boolean;
}
export const NOTIFY_EVENTS: NotifyEventDef[] = [
  { key: 'question', label: 'Frage', types: 'offene Fragen', recipientsText: 'Kette ab Stufe 0 (von der Aufrufstelle)', fixedChat: true, timing: true },
  { key: 'decision', label: 'Entscheidung', types: 'Entscheidung, Agent „an die PL“', recipientsText: 'verantwortliche PL', fixedChat: true, timing: true },
  { key: 'approval', label: 'Bestätigung', types: 'angehaltene Agentenaktionen', recipientsText: 'Freigabeberechtigte', fixedChat: true, timing: true },
  { key: 'synergy', label: 'Überschneidung', types: 'Überschneidungen zwischen APs', recipientsText: 'beide Zuständige, sonst PL (von der Aufrufstelle)', fixedChat: true, timing: true },
  { key: 'confirm', label: 'Vorläufiger Termin', types: 'vorläufige Termine und Buchungen', recipientsText: 'Zuständige(r)', fixedChat: true, timing: true },
  { key: 'order_request', label: 'Auftragsvorschlag', types: 'Auftragsvorschläge von Mitgliedern', recipientsText: 'verantwortliche PL', timing: true },
  { key: 'external_referral', label: 'Rückfrage von extern', types: 'Rückfragen Externer außerhalb ihrer Aufgabe', recipientsText: 'Kette ab Auftraggeber (von der Aufrufstelle)', timing: true },
  { key: 'progress', label: 'Zwischenstand', types: 'Zwischenstände der Agenten', recipientsText: 'Auftraggeber und Berichtswünsche', timing: true },
  { key: 'assigned', label: 'Zuweisung', types: 'zugewiesen, Termin verschoben', recipientsText: 'Zuständige(r)' },
  { key: 'blocked', label: 'Blockiert', types: 'blockiert gemeldet (Person oder Agent)', recipientsText: 'TP-Verantwortung, sonst PL' },
  { key: 'escalation', label: 'Eskalation', types: 'Eskalation (Worker, von Hand), Eskalationsmail', recipientsText: 'Stufen aus den Eskalationsregeln' },
  { key: 'review', label: 'Prüfung und Freigabe', types: 'Seite/Bericht zur Prüfung, KI-Vorschlag, Workflow, Mail-Freigabe, Außenprüfung', recipientsText: 'Freigabeberechtigte je Vorgang (von der Aufrufstelle)' },
  { key: 'mail_in', label: 'Mail am AP', types: 'Mail einem AP zugeordnet', recipientsText: 'niemand (nur Log)' },
  { key: 'log', label: 'Log und Erwähnung', types: 'Kommentar, Erwähnung', recipientsText: 'Beteiligte, Erwähnte' },
  { key: 'due', label: 'Fälligkeit', types: 'bald fällig, überfällig', recipientsText: 'Zuständige(r)' },
  { key: 'chat', label: 'Chat', types: 'Direktnachricht, Erwähnung, Antwort', recipientsText: 'Empfänger der Nachricht', noChat: true },
  { key: 'booking', label: 'Buchung', types: 'Ressourcen und Personen', recipientsText: 'je Buchung (von der Aufrufstelle)' },
  { key: 'info', label: 'Information', types: 'Bericht versendet, extern bearbeitet, Mail-KI, PL bestimmt', recipientsText: 'wie die Aufrufstelle bestimmt' }
];
/** Ebene „Code“ (L0): Standard je Klasse; „–“ beim Doku-Kanal heißt aus, bis die PL die Seite einschaltet. */
export const NOTIFY_DEFAULTS: Record<NotifyEvent, { recipients: string[]; chat: NotifyChat; mail: NotifyMail; log: boolean; doc: string | false; remindH?: number; escalateH?: number; expireH?: number; every?: NotifyEvery }> = {
  question: { recipients: [], chat: 'thread', mail: 'digest', log: true, doc: false, remindH: 48, escalateH: 120 },
  decision: { recipients: ['pl'], chat: 'thread', mail: 'digest', log: true, doc: false, remindH: 24, escalateH: 48 },
  approval: { recipients: ['flag:can_approve'], chat: 'thread', mail: 'digest', log: true, doc: false, remindH: 24, escalateH: 72, expireH: 336 },
  synergy: { recipients: [], chat: 'thread', mail: 'digest', log: true, doc: false, remindH: 72 },
  confirm: { recipients: ['responsible'], chat: 'thread', mail: 'digest', log: true, doc: false, remindH: 24, escalateH: 72 },
  order_request: { recipients: ['pl'], chat: 'thread', mail: 'digest', log: false, doc: false, remindH: 48 },
  external_referral: { recipients: [], chat: 'thread', mail: 'digest', log: true, doc: false, remindH: 24, escalateH: 72 },
  progress: { recipients: ['requester'], chat: 'thread', mail: 'off', log: false, doc: false, every: 'milestones' },
  assigned: { recipients: ['responsible'], chat: 'off', mail: 'digest', log: false, doc: false },
  blocked: { recipients: ['subproject_lead|pl'], chat: 'off', mail: 'digest', log: true, doc: false },
  escalation: { recipients: ['escalation_contact'], chat: 'off', mail: 'digest', log: false, doc: false },
  review: { recipients: [], chat: 'off', mail: 'digest', log: false, doc: false },
  mail_in: { recipients: [], chat: 'off', mail: 'off', log: true, doc: false },
  log: { recipients: ['participants', 'mentioned'], chat: 'off', mail: 'digest', log: false, doc: false },
  due: { recipients: ['responsible'], chat: 'off', mail: 'digest', log: false, doc: false },
  chat: { recipients: [], chat: 'off', mail: 'digest', log: false, doc: false },
  booking: { recipients: [], chat: 'off', mail: 'digest', log: true, doc: false },
  info: { recipients: [], chat: 'off', mail: 'digest', log: false, doc: false }
};
/** Jeder notifications.type gehört zu genau einer Klasse; unbekannte Typen sind „info“. Aufrufstellen können die Klasse ausdrücklich setzen (z. B. blockiert). */
export const EVENT_OF_TYPE: Record<string, NotifyEvent> = {
  'task.assigned': 'assigned', 'plan.shifted': 'assigned', escalation: 'escalation',
  'page.review': 'review', 'report.review': 'review', 'ai.proposal': 'review', 'workflow.approval': 'review', 'mail.approval': 'review', 'draft.review': 'review', 'outbound.review': 'review',
  'task.comment': 'log', mention: 'log', 'task.due_soon': 'due', 'task.overdue': 'due', 'chat.dm': 'chat', 'chat.mention': 'chat', 'chat.reply': 'chat',
  'external.referral': 'external_referral', 'task.progress': 'progress', 'mail.in': 'mail_in',
  'report.sent': 'info', 'report.failed': 'info', 'page.external_edit': 'info', 'mail.ai': 'info', 'project.lead': 'info',
  'booking.conflict': 'booking', 'booking.request': 'booking', 'booking.assigned': 'booking', 'booking.confirmed': 'booking', 'booking.declined': 'booking', 'booking.unconfirmed': 'booking'
};
export const eventOfType = (type: string): NotifyEvent => EVENT_OF_TYPE[type] ?? 'info';
/** Empfängerrollen (dazu group:<id> und user:<id>); Agenten, Inaktive, der Auslöser und Personen ohne Sicht auf das AP fallen immer heraus. */
export const NOTIFY_ROLES: { key: string; label: string }[] = [
  { key: 'responsible', label: 'Zuständige(r)' },
  { key: 'parent_responsible', label: 'Zuständige(r) des Über-AP' },
  { key: 'subproject_lead', label: 'TP-Verantwortung' },
  { key: 'pl', label: 'verantwortliche PL' },
  { key: 'deputy_pl', label: 'Stellvertretung' },
  { key: 'requester', label: 'Auftraggeber' },
  { key: 'flag:can_approve', label: 'Freigeben' },
  { key: 'flag:can_finalize', label: 'Final setzen' },
  { key: 'flag:can_edit_plan', label: 'Projektplan ändern' },
  { key: 'participants', label: 'Beteiligte' },
  { key: 'mentioned', label: 'Erwähnte' },
  { key: 'escalation_contact', label: 'Eskalationsperson (Stufe 3)' },
  { key: 'project_channel', label: 'Projektkanal' }
];
/** Regelzeile einer Ebene: nur gesetzte Angaben zählen, der Rest erbt. */
export interface NotificationRule {
  id: string;
  projectId: string | null;
  taskId: string | null;
  userId: string | null;
  event: NotifyEvent | '*';
  recipients: string[] | null;
  channels: Pick<NotifyFields, 'chat' | 'mail' | 'log' | 'doc'>;
  timing: Pick<NotifyFields, 'remindH' | 'escalateH' | 'expireH' | 'every'>;
  locked: NotifyField[];
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string;
}
/** Aufgelöste Regel einer Klasse mit Herkunft je Feld und gesperrten Feldern (Ebene der Sperre). */
export interface EffectiveNotifyRule {
  event: NotifyEvent;
  value: NotifyFields & { recipients: string[]; chat: NotifyChat; mail: NotifyMail; log: boolean; doc: string | false };
  origin: Partial<Record<NotifyField, NotifyLevel>>;
  locked: Partial<Record<NotifyField, 'org' | 'project'>>;
}

export interface DocShare {
  id: string;
  pageId: string;
  pageTitle?: string;
  email: string;
  mode: 'read' | 'write';
  includeChildren: boolean;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastAccessAt: string | null;
  accessCount: number;
  url: string;
}

export interface ChecklistItem {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  responsibleUserId: string | null;
  responsibleEmail?: string | null;
  position: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  userId: string;
  userName: string;
  body: string;
  source?: 'user' | 'mail' | 'system' | 'ai' | 'chat';
  mailId?: string | null;
  mentions?: string[];
  /** external: für Externe sichtbar (Teil des Außenkontexts der Aufgabe) */
  visibility?: 'internal' | 'external';
  createdAt: string;
}

export interface MailAction {
  key: string;
  target: 'task' | 'doc' | 'mail';
  label: string;
  enabled: boolean;
  mode?: 'proposal' | 'direct';
  reason?: string;
}

export type MailAccountUse = 'org' | 'project' | 'personal';
/** Verwalter eines Kontos: Person, Projekt (PL) oder Org-Admin */
export type MailAccountManager = { kind: 'org' } | { kind: 'user'; userId: string } | { kind: 'project'; projectId: string };
/** Bindung eines Kontos: Org-Postfach, Projektkonto (Standard je Projekt) oder „Meine Konten“ einer Person */
export interface MailAccountUseRow { id: string; use: MailAccountUse; projectId: string | null; projectLabel: string | null; userId: string | null; isDefault: boolean }
/** Art eines Postfachs, abgeleitet aus Verwalter und Bindungen: Org-Postfach (Systemmails), zentral (Organisation, mehrere Projekte), Projektpostfach (PL), persönlich */
export type MailAccountKind = 'org' | 'central' | 'project' | 'personal';
export interface MailAccount {
  id: string;
  /** Spiegel des Verwalters (eine Version lang); maßgeblich sind managedBy und uses */
  type: MailAccountType;
  name: string;
  address: string;
  provider: MailProviderKind;
  ownerUserId: string | null;
  projectId: string | null;
  managedBy?: MailAccountManager;
  uses?: MailAccountUseRow[];
  kind?: MailAccountKind;
  /** zentrales Postfach: jede PL darf es in ihr (normales) Projekt holen */
  offeredToAll?: boolean;
  /** nur in GET /projects/:id/mail/accounts */
  isDefault?: boolean;
  /** vom Org-Admin angeboten (Verwalter ist nicht dieses Projekt) */
  offered?: boolean;
  imapHost: string | null;
  imapPort?: number | null;
  imapUser?: string | null;
  imapSecure?: boolean | null;
  smtpHost: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpSecure?: boolean | null;
  hasImapPassword?: boolean;
  hasSmtpPassword?: boolean;
  /** OAuth2-Anbieter (Microsoft 365 oder Google), sonst null */
  oauthProvider?: 'microsoft' | 'google' | null;
  viewCount?: number;
  lastSyncAt: string | null;
  syncError: string | null;
}

export interface MailViewFilter {
  folders?: string[];
  from?: string[];
  to?: string[];
  subject?: string[];
  keyword?: string[];
  since?: string | null;
}

export interface MailViewRights {
  canRead: boolean;
  canDraft: boolean;
  canSend: boolean;
  canAi: boolean;
  canCreateTask: boolean;
}

export interface MailView {
  id: string;
  projectKey?: string;
  canManage?: boolean;
  accountId: string;
  accountName: string;
  accountAddress: string;
  /** Bindung, über die die Ansicht besteht (accountType bleibt eine Version als Alias) */
  use?: MailAccountUse;
  accountType: MailAccountType;
  projectId: string;
  name: string;
  filter: MailViewFilter;
  myRights: MailViewRights;
  /** Ordner-Ansicht („KI Bearbeiten“): neue Mails bearbeitet der Agent sofort (als stellvertretende PL direkt, als Mitglied Vorschläge) */
  aiProcess?: boolean;
  /** Agent, der die Ansicht betreut und Vorschläge macht */
  agentUserId?: string | null;
  agentName?: string | null;
}

/** Lauf eines Agenten an einer Mail: ausgeführt (als stellvertretende PL) oder Vorschläge (als Mitglied) */
export interface MailAiRun {
  id: string;
  mode: 'process' | 'triage';
  /** Vorschläge auf Anfrage einer Person (Antwort per Chat) */
  requestedBy?: string | null;
  status: 'queued' | 'running' | 'ok' | 'error' | 'skipped';
  summary: string | null;
  error: string | null;
  agentName: string | null;
  actorName: string | null;
  createdAt: string;
  mail?: { id: string; subject: string; fromAddr: string; fromName: string | null; date: string };
  actions: { type: string; title?: string; text?: string; ref?: string; responsible?: string; dueDate?: string; startsAt?: string; location?: string; folder?: string; reason?: string; status: 'done' | 'error' | 'pending' | 'approved' | 'rejected'; result?: { ref?: string; taskId?: string; meetingId?: string; draftId?: string; folder?: string; error?: string; /** Fundstellen der Außenprüfung am Antwortentwurf (Hinweis) */ hints?: number; /** Antwort vom Agenten selbst gesendet (Policy Selbstständig, Senderecht, Außenprüfung bestanden) */ sent?: boolean; /** Versand im Arbeitszeitfenster geplant (Zeitpunkt) */ scheduled?: string } }[];
  /** Offene Punkte aus der Mail (Mail-Rückfrage) */
  openPoints?: string[];
}

export interface MailSummary {
  id: string;
  accountId: string;
  /** für die abrufende Person noch nicht geöffnet (nur in Listen) */
  unread?: boolean;
  folder: string;
  messageId: string | null;
  fromAddr: string;
  fromName: string | null;
  toJson: string[];
  subject: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
  linkedTaskIds: string[];
  /** gesendet über das Tool oder aus dem Ordner „Gesendet“ */
  outgoing?: boolean;
}

export interface MailFolder {
  path: string;
  name: string;
  specialUse: 'inbox' | 'sent' | 'trash' | 'archive' | 'drafts' | 'junk' | null;
}

export interface InboxMail extends MailSummary {
  projectId: string;
  projectKey: string;
  /** alle Projekte mit lesbarer Ansicht auf diese Mail */
  projectKeys: string[];
  viewId: string;
  viewName: string;
  accountName: string;
}

export interface MailDetail extends MailSummary {
  ccJson: string[];
  textBody: string | null;
  htmlBody: string | null;
  inReplyTo: string | null;
}

export interface MailDraft {
  id: string;
  /** Projekt des Entwurfs (Liste „Zur Freigabe“ über alle Projekte) */
  projectId?: string | null;
  projectKey?: string | null;
  /** von einem KI-Agenten verfasst */
  byAgent?: boolean;
  accountId: string;
  viewId: string | null;
  taskId: string | null;
  userId: string;
  userName: string;
  toAddrs: string[];
  ccAddrs: string[];
  subject: string;
  body: string;
  status: DraftStatus;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
  /** Angehaltener PDF-Versand: PDF dieser Seite wird beim Senden angehängt */
  pageId?: string | null;
  /** Letzte Außenprüfung des Entwurfs (Fundstellen als Hinweis bzw. Grund des Anhaltens) */
  outbound?: { checkId: string; channel: OutboundChannel; audience: AudienceClass; result: OutboundResult; findings: OutboundFinding[]; withheld: string[]; decided: boolean } | null;
}

/**
 * Informationsgrenze für Externe (Regel E): internal = Projektmitglied mit Sicht auf das Teilprojekt, outside = Org-Benutzer
 * ohne Projektzugriff oder ohne Sicht auf das Teilprojekt, task_external = Adresse mit Bezug zum AP, unknown_external = alle
 * übrigen (erster Kontakt immer als Entwurf). Für eine Nachricht gilt die strengste Klasse unter ihren Empfängern.
 */
export type AudienceClass = 'internal' | 'outside' | 'task_external' | 'unknown_external';
export const AUDIENCE_LABEL: Record<AudienceClass, string> = { internal: 'intern', outside: 'Org-Benutzer ohne Zugriff', task_external: 'Extern mit Aufgabenbezug', unknown_external: 'Extern ohne Bezug (erster Kontakt)' };
export type OutboundChannel = 'mail' | 'reply_origin' | 'pdf' | 'draft' | 'chat';
/** pass = wird gesendet, held = Entwurf zur Freigabe mit Fundstellen, blocked = nicht gesendet (Anhang nicht final oder nicht freigegeben) */
export type OutboundResult = 'pass' | 'held' | 'blocked';
/** Fundstelle der Außenprüfung (checkOutbound); compose = Neuformulierung fehlgeschlagen */
export interface OutboundFinding { kind: 'ref' | 'task' | 'subproject' | 'page' | 'project' | 'address' | 'link' | 'attachment' | 'compose'; match: string; text: string; pageId?: string }
/** Prüfung nach außen mit dem angehaltenen Entwurf (Mail › Freigaben „Außenprüfung angehalten“). */
export interface OutboundCheck {
  id: string;
  projectId: string;
  taskId: string | null;
  taskRef: string | null;
  taskTitle: string | null;
  channel: OutboundChannel;
  recipients: { email: string; audience: AudienceClass }[];
  audience: AudienceClass;
  result: OutboundResult;
  findings: OutboundFinding[];
  withheld: string[];
  mailDraftId: string | null;
  draft: { subject: string; body: string; toAddrs: string[]; ccAddrs: string[]; userName: string; status: DraftStatus; pageId: string | null; pageTitle: string | null } | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}
/** Externes Profil eines Projekts: Name nach außen, Adresse, Zufahrt, Ansprechpartner für Externe. */
/** Externes Profil (Informationsgrenze); contacts kommt aus den Projektkontakten mit Kennzeichen „nach außen“ (nur lesend geliefert) */
export interface ExternalProfile { name?: string; address?: string; access?: string; contacts?: { name: string; email: string; role?: string }[] }

export interface DocFolder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  position: number;
  distributionList: string[];
  /** Zugriff der KI-Agenten: schreiben (Standard), nur lesen, kein Zugriff; vererbt an Unterordner, die strengste Angabe gilt */
  agentAccess?: 'write' | 'read' | 'none';
  /** Seite des Ordners (Beschreibung); wird beim ersten Öffnen angelegt */
  pageId: string | null;
}

export interface DocPage {
  id: string;
  projectId: string;
  folderId: string | null;
  parentPageId: string | null;
  title: string;
  contentMd: string;
  contentHtml: string;
  settings: DocPageSettings;
  childCount?: number;
  /** Seite eines Ordners: erscheint nicht als Seite im Baum, sondern über den Ordnernamen */
  isFolderPage?: boolean;
  /** Im Papierkorb seit */
  deletedAt?: string | null;
  status: DocStatus;
  version: number;
  templateKey: string | null;
  createdBy: string;
  updatedBy: string;
  updatedByName?: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
}

export interface DocPageSettings {
  /** Vorlage für neue Unterseiten (vererbt an tiefere Ebenen) */
  childTemplateKey?: string | null;
  /** Art der Oberseite: Besprechungsreihe, Teilprojekt, Bericht, frei */
  kind?: 'series' | 'subproject' | 'report' | 'custom' | 'folder' | null;
  /** Unterseiten-Index unter dem Inhalt anzeigen */
  showChildren?: boolean;
  /** Empfängerkreis für den PDF-Versand dieser Seite (Vorrang hat der Ordner-Verteiler) */
  recipients?: string[];
  /** Vom Reporting erzeugt */
  report?: { generatedOn: string; mode: 'proposal' | 'direct' } | null;
  /** PDF-Layout für diese Seite und Unterseiten */
  pdf?: { accentColor?: string; headerText?: string; footerText?: string; showMeta?: boolean } | null;
}

export interface DocPageVersion {
  id: string;
  pageId: string;
  version: number;
  title: string;
  contentMd: string;
  contentHtml?: string;
  status: DocStatus;
  savedBy: string;
  savedByName: string;
  savedAt: string;
}

export interface DocTemplate {
  id: string;
  key: string;
  name: string;
  contentMd: string;
  contentHtml: string;
}

/** Projektampel: manuell gesetzter Status der Projektleitung mit Begründung */
export interface ProjectHealth {
  color: 'green' | 'yellow' | 'red' | null;
  note: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Projektvorlage: Struktur, die ein neues Projekt vorbelegt; Termine relativ zum Projektstart */
export interface ProjectTemplateSpec {
  columns?: { name: string; kind: 'backlog' | 'active' | 'waiting' | 'parked' | 'done'; wipLimit: number | null; /** Spaltengruppe (siehe BoardColumn.group) */ group?: string | null }[];
  labels?: { name: string; color: string }[];
  subprojects?: { name: string; startOffsetDays: number | null; endOffsetDays: number | null }[];
  folders?: string[];
  milestones?: { name: string; offsetDays: number }[];
  escalation?: Partial<EscalationPolicy>;
  reminders?: Partial<ReminderPolicy>;
  timeTrackingEnabled?: boolean;
}
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string | null;
  spec: ProjectTemplateSpec;
  createdAt: string;
}

/** RAID: Risiken, Annahmen, Issues, Entscheidungen je Projekt */
export type RaidKind = 'risk' | 'assumption' | 'issue' | 'decision';
export interface RaidItem {
  id: string;
  projectId: string;
  number: number;
  kind: RaidKind;
  title: string;
  description: string | null;
  /** 1 (gering) bis 5 (hoch); Score = Wahrscheinlichkeit × Auswirkung */
  probability: number | null;
  impact: number | null;
  score: number | null;
  status: 'open' | 'mitigated' | 'closed';
  ownerUserId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  /** Maßnahme bzw. Begründung der Entscheidung */
  mitigation: string | null;
  decidedOn: string | null;
  taskId: string | null;
  pageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectContact {
  id: string;
  projectId: string;
  email: string;
  name: string | null;
  role: string | null;
  organization: string | null;
  phone: string | null;
  notes: string | null;
  /** Ansprechpartner für Externe: darf in Mails nach außen genannt werden, an ihn verweist der Agent Fragen außerhalb der Aufgabe */
  external: boolean;
}

export interface AuditEntry {
  id: string;
  projectId: string | null;
  userId: string | null;
  userName: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export const ROLE_RANK: Record<ProjectRole, number> = { reader: 1, member: 2, pl: 3 };

export interface MeetingAttendee { userId?: string | null; email: string; name?: string | null }

// Ressourcen und Personen im Kalender (Konzept 10)
export type ResourceKind = 'room' | 'equipment' | 'scaffold' | 'vehicle' | 'person' | 'other';
export const RESOURCE_KINDS: { key: ResourceKind; label: string }[] = [
  { key: 'room', label: 'Raum' }, { key: 'equipment', label: 'Gerät' }, { key: 'scaffold', label: 'Gerüst' }, { key: 'vehicle', label: 'Fahrzeug' }, { key: 'person', label: 'Person (extern)' }, { key: 'other', label: 'Sonstiges' }
];
export interface Resource { id: string; projectId: string | null; projectKey?: string | null; kind: ResourceKind; name: string; description: string | null; location: string | null; email: string | null; phone: string | null; organization: string | null; trade: string | null; approvalGroupId: string | null; approvalGroupName?: string | null; active: boolean; createdBy: string | null; createdAt: string; /** künftige Belegungen (für Deaktivieren statt Löschen) */ futureBookings?: number }
export type BookingKind = 'booking' | 'absence' | 'block';
export interface ResourceBooking {
  id: string; kind: BookingKind; projectId: string | null; projectKey?: string | null; resourceId: string | null; resourceName?: string | null; resourceKind?: ResourceKind | null; userId: string | null; userName?: string | null;
  meetingId: string | null; taskId: string | null; taskRef?: string | null; taskTitle?: string | null; followTask: boolean; title: string | null; note: string | null; startsAt: string; endsAt: string; allDay: boolean; tentative: boolean;
  confirmedAt: string | null; createdBy: string | null; createdByName?: string | null; createdAt: string;
  /** Titel, Projekt und AP nur für Personen mit Sicht auf das Projekt; sonst nur „belegt“ bzw. „abwesend“ */ masked: boolean;
  /** überschneidet sich mit einer anderen Belegung derselben Ressource bzw. Person (beim Lesen berechnet) */ conflict?: boolean;
  /** Frage confirm zur Buchung (Agent oder Freigabegruppe) */ questionId?: string | null;
}
export interface Availability { status: 'free' | 'tentative' | 'busy'; conflicts: ResourceBooking[] }
export interface Meeting {
  id: string;
  projectId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  description: string | null;
  seriesPageId: string | null;
  seriesPageTitle?: string | null;
  pageId: string | null;
  pageTitle?: string | null;
  attendees: MeetingAttendee[];
  /** gebuchte Ressourcen (Räume, Geräte, externe Personen) */
  resourceIds?: string[];
  resources?: { id: string; name: string; kind: ResourceKind }[];
  inviteSentAt: string | null;
  createdBy: string | null;
  tasks: { id: string; title: string; done: boolean; number?: number | null }[];
  createdAt: string;
  /** Von KI eingetragen, verbindlich erst nach Bestätigung durch eine Person */
  tentative?: boolean;
  confirmedAt?: string | null;
}

export interface CalendarTarget { key: 'microsoft' | 'google' | 'caldav'; label: string; accountId: string | null }

export interface AiProfile { id: string; name: string; provider: 'anthropic' | 'local'; model: string; baseUrl: string | null; hasKey: boolean; active: boolean; /** Denkmodus des lokalen Modells aus (enable_thinking: false) */ thinkingOff: boolean; /** Kontextfenster des Modells in Token (leer = 32k); die Eingabe belegt höchstens 45 % */ contextTokens?: number | null; /** Zeitlimit je Anfrage in Sekunden (lokal, leer = 600) */ timeoutS?: number | null; /** Online-Recherche mit diesem Profil erlaubt (Konzept 8; dazu KI-Freigabe agent.web) */ webSearch?: boolean; /** Freigabe für Projekte: alle, ausgewählte (projectIds) oder keine (nur Agenten der Org) */ projectScope?: 'all' | 'selected' | 'none'; projectIds?: string[]; /** Freigabe für persönliche Projekte: none (Standard), all, users (personalUserIds); personalScope = (personalUse === 'all') bleibt lesend für ältere Oberflächen */ personalUse?: PersonalUse; personalUserIds?: string[]; personalScope?: boolean; /** Verbrauch (Token) und letzte Nutzung */ tokensIn?: number; tokensOut?: number; lastUsedAt?: string | null }
export interface AgentUser { id: string; name: string; email: string; active: boolean; aiProfileId: string | null; /** Name seines LLM */ profileName?: string | null; /** LLM gehört einem Projekt (eigenes LLM): dessen PL verwaltet den Agenten */ profileProjectId?: string | null; /** Agent am eigenen LLM eines Projekts: nur dort */ projectBound?: { id: string; label: string } | null; /** Rechte vom Verwalter des LLM */ rights?: AiFeature[]; /** Obergrenze des Verwalters (maxMode, lockedConfirm, maxDepth, mode, workflows) */ policy?: AgentPolicy; /** die angemeldete Person verwaltet ihn (verwaltet sein LLM) */ canManage?: boolean; /** Einsatz (Konzept LLM/Agenten 2.2): alle Projekte, ausgewählte (projectIds) oder nur das eigene Projekt */ scope?: 'all' | 'selected' | 'project'; projectIds?: string[]; dailyBudget?: number | null; /** Schreibstil als eine Zeile Freitext */ persona: string | null; /** Unterschrift für Mails, frei; null = Standard */ signature: string | null; /** Denkmodus: null = wie KI-Profil */ thinkingMode: 'off' | 'on' | null; createdAt: string; projects: { id: string; key: string; name: string; /** läuft dort (Einsatz, LLM verfügbar) oder Grund */ usable?: boolean; reason?: string | null }[]; runs: number; lastRunAt: string | null }
/** Aktionen eines Laufs; Chat-Läufe: chat_reply (Antwort), chat_note (Log-Eintrag am Arbeitspaket taskId), claim_check (ersetzte Behauptungen, replaced = Anzahl) */
export interface AgentRun { id: string; agentId: string; /** eigene Bewertung (Daumen hoch 1, Daumen runter -1) */ myRating?: 1 | -1 | null; agentName: string; taskId: string | null; taskTitle: string | null; taskNumber: number | null; trigger: string; status: 'ok' | 'error' | 'skipped'; reasoning: string | null; /** Kosten im Tagesbudget (gründlich = 2) */ cost?: number; depth?: AgentDepth | null; actions: { type: string; text?: string; column?: string; itemId?: string; to?: string[]; subject?: string; reason?: string; taskId?: string; replaced?: number }[]; proposed?: unknown[] | null; inputTokens: number; outputTokens: number; /** Online-Suchen in diesem Lauf */ webSearches?: number; /** Reichweite des Laufs */ scope?: 'task' | 'project' | 'chat' | 'mail'; /** Kontextgröße: Grenze, vorher, nachher, gekürzte Abschnitte */ contextStats?: { limit: number; before: number; after: number; trimmed: Record<string, { from: number; to: number }> } | null; error: string | null; createdAt: string }

/** Dateiquelle (Nextcloud-Freigabelink oder WebDAV-Konto, nur lesend); Geheimnis nie, nur hasSecret. */
export type FileSourceKind = 'nextcloud_share' | 'webdav';
export interface FileSourceBindingRef { id: string; projectId: string; project: string; subPath: string | null; label: string }
export interface FileSource {
  id: string; name: string; kind: FileSourceKind;
  /** eingegebene Adresse (Freigabelink bzw. WebDAV-Adresse) und abgeleitete WebDAV-Wurzel */
  url: string; davUrl: string; username: string | null; hasSecret: boolean;
  /** Startordner innerhalb der WebDAV-Wurzel ('/' = alles) */
  rootPath: string;
  /** org: Org-Admin, Freigabe für Projekte; project: Quelle eines Projekts (ownerProjectId) */
  scope: 'org' | 'project'; ownerProjectId: string | null;
  projectScope: 'all' | 'selected' | 'none'; projectIds: string[];
  personalUse: PersonalUse; personalUserIds: string[];
  active: boolean; lastSyncAt: string | null; lastError: string | null;
  lastStats: FileSyncStats | null; files: number; bindings: FileSourceBindingRef[]; createdAt: string;
}
export interface FileSyncStats { files: number; added: number; changed: number; deleted: number; extracted: number; /** Dateien mit Texterkennung (OCR) in diesem Lauf */ ocr?: number; truncated: boolean; error?: string | null }
/** Org-Quelle aus Sicht der PL (ohne Adresse und Zugangsdaten) */
export interface FileSourceAvailable { id: string; name: string; kind: FileSourceKind; scope: 'org' | 'project'; rootPath: string; lastSyncAt: string | null; lastError: string | null; /** nicht gelöschte Dateien der Quelle */ files: number }
export interface FileSourceBinding { id: string; sourceId: string; sourceName: string; scope: 'org' | 'project'; kind: FileSourceKind; subPath: string | null; label: string; lastSyncAt: string | null; lastError: string | null; /** Einbindung gilt (Quelle aktiv und freigegeben) */ active: boolean; /** nicht gelöschte Dateien unter dem Unterordner der Einbindung */ files: number; /** Schalter „für KI-Agenten“ (Quellen für den Agenten) */ agentEnabled: boolean }
export interface FileRoot { bindingId: string; sourceId: string; label: string; sourceName: string; kind: FileSourceKind; scope: 'org' | 'project'; subPath: string | null; lastSyncAt: string | null; lastError: string | null }
export type FileEntry =
  | { type: 'folder'; name: string; path: string; bindingId: string; /** Dateien darunter (rekursiv) */ files?: number }
  | { type: 'file'; id: string; name: string; path: string; mime: string | null; size: number | null; modifiedAt: string | null; textStatus: 'ok' | 'skipped' | 'error' | null; /** Grund zum Textstatus (z. B. „Dateityp ohne Textauszug“) */ textNote: string | null; bindingId: string };
/** GET /projects/:id/files?binding=&path= */
export interface FileListing { binding: FileRoot | null; path: string; parent: string | null; roots: FileRoot[]; entries: FileEntry[] }
/** GET /files/:id/text */
export interface FileText { id: string; name: string; path: string; projectId: string; bindingId: string; displayPath: string; mime: string | null; size: number | null; modifiedAt: string | null; textStatus: 'ok' | 'skipped' | 'error' | null; textNote: string | null; text: string | null }
/** Projekt › Einstellungen › KI › Quellen für den Agenten: was KI-Agenten durchsuchen und lesen dürfen (Menschen sehen alles). */
/** Zugriff der KI-Agenten auf einen Doku-Ordner (eine Quelle der Wahrheit: Doku › Ordner und Einstellungen › KI › Quellen für den Agenten) */
export type AgentFolderAccess = 'write' | 'read' | 'none';
export const AGENT_FOLDER_ACCESS: { key: AgentFolderAccess; label: string }[] = [
  { key: 'write', label: 'schreiben (Seiten anlegen, ändern, verschieben)' },
  { key: 'read', label: 'nur lesen' },
  { key: 'none', label: 'kein Zugriff (auch nicht im Kontext der Agenten)' }
];
export interface AgentSourceFolder { id: string; name: string; parentId: string | null; depth: number; pages: number; /** Agent-Zugriff des Ordners (derselbe Wert wie in der Doku) */ agentAccess: AgentFolderAccess; /** durch einen übergeordneten Ordner mit „kein Zugriff“ ausgeschlossen */ inheritedOff: boolean }
export interface AgentSourceBinding { id: string; label: string; sourceName: string; subPath: string | null; active: boolean; files: number; agentEnabled: boolean }
export interface AgentSources { canEdit: boolean; folders: AgentSourceFolder[]; bindings: AgentSourceBinding[]; mails: { enabled: boolean; views: number } }
export interface AgentSourcesPatch { folders?: { id: string; agentAccess: AgentFolderAccess }[]; bindings?: { id: string; agentEnabled: boolean }[]; mails?: boolean }

/* ---- Meilensteine mit Status und Bezug zu Arbeitspaketen; benannte Prüfung; CSV-Import ---- */

/** Meilenstein: offen oder erreicht (wann, durch wen); verknüpfte Arbeitspakete (n:m) */
export interface Milestone {
  id: string;
  projectId: string;
  subprojectId: string | null;
  name: string;
  date: string;
  /** erreicht am (ISO-Zeitpunkt); null = offen */
  reachedAt?: string | null;
  reachedBy?: { userId: string; name: string | null } | null;
  /** alle verknüpften Arbeitspakete erledigt, PL wurde gefragt (noch nicht bestätigt) */
  reachSuggestedAt?: string | null;
  taskIds?: string[];
  /** verknüpfte Arbeitspakete: erledigt / gesamt */
  tasksDone?: number;
  tasksTotal?: number;
}
export type MilestoneStatus = 'open' | 'reached';
/** Status eines Meilensteins: erreicht, überfällig (Datum vorbei, nicht erreicht), bereit (alle APs erledigt), offen */
export function milestoneState(m: Pick<Milestone, 'reachedAt' | 'date' | 'tasksDone' | 'tasksTotal'>, today: string): 'reached' | 'ready' | 'overdue' | 'open' {
  if (m.reachedAt) return 'reached';
  if ((m.tasksTotal ?? 0) > 0 && m.tasksDone === m.tasksTotal) return 'ready';
  if (m.date < today) return 'overdue';
  return 'open';
}

export interface Task {
  /** Meilensteine, zu denen das Arbeitspaket gehört */
  milestoneIds?: string[];
  /** Benannte prüfende Person (Spalte der Art „In Prüfung“) */
  reviewer?: { userId: string; name: string | null } | null;
}
export interface DocPage {
  /** Benannte prüfende Person, solange die Seite „In Prüfung“ ist */
  reviewer?: { userId: string; name: string | null } | null;
}
export interface Project {
  /** Meilenstein automatisch erreichen, wenn alle verknüpften Arbeitspakete erledigt sind (sonst Vorschlag an die PL) */
  milestoneAutoReach?: boolean;
  /** Prüfer beim Wechsel in „In Prüfung“ Pflicht (Arbeitspakete und Doku-Seiten) */
  reviewRequired?: boolean;
}

/** CSV-Import von Arbeitspaketen, Aufgaben und Checklistenpunkten (Projekt › Einstellungen › Daten) */
export type ImportField = 'kind' | 'key' | 'title' | 'description' | 'subproject' | 'responsible' | 'start' | 'due' | 'priority' | 'labels' | 'parent' | 'level' | 'status' | 'ignore';
export const IMPORT_FIELDS: { key: ImportField; label: string; hint: string; aliases: string[] }[] = [
  { key: 'kind', label: 'Art', hint: 'Arbeitspaket, Aufgabe oder Checklistenpunkt (leer: aus Ebene bzw. Übergeordnet)', aliases: ['art', 'typ', 'type', 'kind'] },
  { key: 'key', label: 'Kennung', hint: 'eigene Kennung der Zeile, z. B. WEB-12 oder 1.2; auf sie verweist „Übergeordnet“', aliases: ['kennung', 'id', 'nr', 'nummer', 'key'] },
  { key: 'title', label: 'Titel', hint: 'Pflicht', aliases: ['titel', 'title', 'name', 'bezeichnung', 'arbeitspaket', 'aufgabe'] },
  { key: 'description', label: 'Beschreibung', hint: 'Text', aliases: ['beschreibung', 'description', 'details', 'text'] },
  { key: 'subproject', label: 'Teilprojekt', hint: 'Name; fehlt es, wird es angelegt', aliases: ['teilprojekt', 'subproject', 'phase'] },
  { key: 'responsible', label: 'Zuständig', hint: 'E-Mail oder Name eines Mitglieds; sonst E-Mail als externe Zuständigkeit', aliases: ['zuständig', 'zustaendig', 'verantwortlich', 'responsible', 'assignee', 'owner'] },
  { key: 'start', label: 'Start', hint: 'TT.MM.JJJJ oder JJJJ-MM-TT', aliases: ['start', 'beginn', 'startdatum', 'start date'] },
  { key: 'due', label: 'Deadline', hint: 'TT.MM.JJJJ oder JJJJ-MM-TT', aliases: ['deadline', 'fällig', 'faellig', 'ende', 'due', 'enddatum', 'due date', 'frist'] },
  { key: 'priority', label: 'Priorität', hint: 'niedrig, normal, hoch, kritisch', aliases: ['priorität', 'prioritaet', 'priority', 'prio'] },
  { key: 'labels', label: 'Labels', hint: 'durch Komma getrennt; fehlende werden angelegt', aliases: ['labels', 'label', 'tags', 'schlagworte'] },
  { key: 'parent', label: 'Übergeordnet', hint: 'Kennung der übergeordneten Zeile (oder eines bestehenden Arbeitspakets, z. B. WEB-12)', aliases: ['übergeordnet', 'uebergeordnet', 'eltern', 'parent', 'eltern-kennung', 'arbeitspaket-kennung'] },
  { key: 'level', label: 'Ebene', hint: '1 = Arbeitspaket, 2 = Aufgabe, 3 = Checklistenpunkt (gehört zur Zeile darüber)', aliases: ['ebene', 'level', 'stufe', 'gliederung'] },
  { key: 'status', label: 'Status', hint: 'Name einer Spalte; „ja“ in „Erledigt“ setzt erledigt', aliases: ['status', 'spalte', 'erledigt'] },
  { key: 'ignore', label: '– nicht übernehmen –', hint: '', aliases: [] }
];
export interface ImportRowResult {
  /** Zeilennummer in der Datei (1 = erste Datenzeile) */
  line: number;
  /** subproject = Zeile „Teilprojekt“ (Plan-Export: gilt für die folgenden Zeilen), skip = wird nicht übernommen (z. B. Meilenstein) */
  kind: 'ap' | 'aufgabe' | 'item' | 'subproject' | 'skip';
  title: string;
  parentLine: number | null;
  errors: string[];
  warnings: string[];
}
export interface ImportResult {
  dryRun: boolean;
  rows: ImportRowResult[];
  counts: { ap: number; aufgabe: number; item: number; errors: number; subprojects: number; labels: number };
  /** angelegte Arbeitspakete und Aufgaben (nur ohne Trockenlauf) */
  created?: { ap: number; aufgabe: number; item: number };
}

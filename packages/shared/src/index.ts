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
}

export interface UserSettings {
  language?: 'de' | 'en';
  theme?: 'light' | 'dark' | 'system';
  /** Meldungen per Mail über das Org-Postfach: aus, sofort (gesammelt je Worker-Lauf) oder täglich als Digest (Standard) */
  mailNotifications?: 'off' | 'immediate' | 'daily';
  /** In der Seitenleiste angeheftete Projekte (höchstens 5, in dieser Reihenfolge) */
  pinnedProjects?: string[];
}

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
}

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
  /** workflow = Mini-Projekt eines isolierten Workflow-Laufs (nicht in Projektlisten) */
  kind?: 'project' | 'workflow';
  timeTrackingEnabled: boolean;
  budgetHours: number | null;
  escalation?: EscalationPolicy;
  reporting?: ReportingPolicy;
  reminders?: ReminderPolicy;
  health?: ProjectHealth;
  /** KI-Profil für die Projekt-KI (Zusammenfassen, Essenz, Fragen, Statusbericht); null = aus */
  aiProfileId?: string | null;
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
}

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
  /** KI-Modul: Anbieter, Modell, lokale Adresse, Tagesbudget je Agent; der Schlüssel liegt getrennt und verlässt den Server nie. enabled = false ist der Notaus */
  ai?: { enabled?: boolean; defaultProfileId?: string | null; agentDailyBudget?: number; assistDailyBudget?: number; plAgents?: { enabled?: boolean; profileIds?: string[]; maxBudget?: number } };
}

/**
 * KI-Freigaben: Funktionskatalog. Eine Regel gilt für eine Funktion, eine Kategorie oder „*“. who sagt, wer geprüft wird
 * (Person, Agent oder beide); defaultDeny = ohne Regel gesperrt; later = noch ohne Prüfstelle im Code, in der Matrix ausgeblendet
 * (Kategorie- und „*“-Regeln gelten trotzdem).
 */
export type AiFeatureCategory = 'assist' | 'mail' | 'agent' | 'pl';
export const AI_CATEGORIES: { key: AiFeatureCategory; label: string }[] = [
  { key: 'assist', label: 'KI-Assistenz' },
  { key: 'mail', label: 'Mail-KI' },
  { key: 'agent', label: 'Agenten' },
  { key: 'pl', label: 'PL-Funktionen' }
];
export interface AiFeatureDef { key: string; category: AiFeatureCategory; label: string; who: 'person' | 'agent' | 'both'; defaultDeny?: boolean; later?: boolean }
export const AI_FEATURES = [
  { key: 'assist.summarize', category: 'assist', label: 'Mail zusammenfassen', who: 'person' },
  { key: 'assist.essence', category: 'assist', label: 'Essenz in Arbeitspaket oder Seite', who: 'person' },
  { key: 'assist.report', category: 'assist', label: 'Statusbericht-Entwurf', who: 'person' },
  { key: 'assist.ask', category: 'assist', label: 'Frage ans Projekt', who: 'person' },
  { key: 'assist.final_reply', category: 'assist', label: 'Abschluss-Antwort mit KI', who: 'person' },
  { key: 'mail.process', category: 'mail', label: 'Ordner „KI Bearbeiten“', who: 'person' },
  { key: 'mail.triage', category: 'mail', label: 'Agent betreut Mail-Ansicht', who: 'agent' },
  { key: 'agent.run', category: 'agent', label: 'Agentenläufe', who: 'agent' },
  { key: 'agent.chat', category: 'agent', label: 'Chat mit Agenten', who: 'both' },
  { key: 'agent.order', category: 'agent', label: 'Aufträge im Chat', who: 'both', later: true },
  { key: 'agent.web', category: 'agent', label: 'Online-Recherche', who: 'agent', defaultDeny: true, later: true },
  { key: 'agent.finalize', category: 'agent', label: 'Final setzen', who: 'agent', later: true },
  { key: 'agent.distribute', category: 'agent', label: 'PDF an Verteiler', who: 'agent', later: true },
  { key: 'agent.send_external', category: 'agent', label: 'Mails nach außen', who: 'agent', later: true },
  { key: 'agent.close', category: 'agent', label: 'Erledigt setzen', who: 'agent', later: true },
  { key: 'agent.restructure', category: 'agent', label: 'Umstrukturieren', who: 'agent', later: true },
  { key: 'agent.plan', category: 'agent', label: 'Planen', who: 'agent', later: true },
  { key: 'agent.assign', category: 'agent', label: 'Zuweisen', who: 'agent', later: true },
  { key: 'agent.schedule', category: 'agent', label: 'Termine ändern', who: 'agent', later: true },
  { key: 'agent.foreign', category: 'agent', label: 'Fremde Arbeitspakete', who: 'agent', later: true },
  { key: 'pl.agents', category: 'pl', label: 'Eigene Agenten der PL', who: 'person', defaultDeny: true },
  { key: 'pl.own_llm', category: 'pl', label: 'Eigenes LLM im Projekt', who: 'person' }
] as const satisfies readonly AiFeatureDef[];
export type AiFeature = (typeof AI_FEATURES)[number]['key'];

/** Regel der KI-Freigaben: Ort (Projekt oder alle) × Wer (Person/Agent, Gruppe oder alle) × Funktion × Wirkung. */
export interface AiPolicyRule {
  id: string;
  projectId: string | null;
  userId: string | null;
  groupId: string | null;
  feature: string;
  effect: 'allow' | 'deny';
  note: string | null;
  setBy: string | null;
  setByName: string | null;
  updatedAt: string;
  projectLabel: string | null;
  userName: string | null;
  userKind: 'person' | 'agent' | null;
  groupName: string | null;
}

/** Prüfstufen von aiAllowed: Notaus → Regeln des Org-Admins → Ebene der PL → Profil → Budget. */
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
  /** Regel, die in Stufe 1 entschieden hat */
  rule?: { id: string; effect: 'allow' | 'deny' } | null;
  /** fehlende Einrichtung (keine Projekt-KI, kein Profil) statt Sperre */
  missing?: boolean;
  trace: AiTraceStep[];
}
export type AiCapability = Pick<AiDecision, 'allowed' | 'reason' | 'stage'>;
/** Was die angemeldete Person im Projekt mit KI darf, je Funktion mit Begründung; dazu die Agenten des Projekts. */
export interface AiCapabilities {
  killswitch: boolean;
  features: Partial<Record<AiFeature, AiCapability>>;
  agents: { id: string; name: string; run: AiCapability; chat: AiCapability }[];
}

export type AiProposalKind = 'task_update' | 'page_append';
export interface AiProposal {
  id: string;
  projectId: string;
  kind: AiProposalKind;
  mailId: string | null;
  taskId: string | null;
  pageId: string | null;
  /** task_update: summary, logEntry, columnName, dueDate, questions; page_append: section (Markdown) */
  payload: { summary?: string; logEntry?: string; columnName?: string | null; dueDate?: string | null; questions?: string[]; section?: string };
  status: 'pending' | 'approved' | 'rejected';
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
  kind: 'backlog' | 'active' | 'parked' | 'done';
  wipLimit: number | null;
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
}

export interface Invitation {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  /** Einladung direkt in ein Projekt (durch den PL): Annahme macht die Person zum Mitglied mit dieser Rolle */
  projectId?: string | null;
  projectRole?: 'member' | 'reader' | null;
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
  /** KI-Agent an diesem Arbeitspaket pausiert (PL) */
  agentPaused?: boolean;
  /** Wartezustand des Agenten: worauf, seit wann, Nachfassen/Eskalation geplant */
  agentWait?: { kind: 'reply' | 'date' | 'task' | 'info'; reason: string; since: string; remindAt?: string | null; escalateAt?: string | null; reminded?: boolean; escalated?: boolean } | null;
  agentNextCheckAt?: string | null;
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

export interface MailAccount {
  id: string;
  type: MailAccountType;
  name: string;
  address: string;
  provider: MailProviderKind;
  ownerUserId: string | null;
  projectId: string | null;
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
  accountType: MailAccountType;
  projectId: string;
  name: string;
  filter: MailViewFilter;
  myRights: MailViewRights;
  /** Projekt-KI bearbeitet neue Mails dieser Ansicht direkt (Ordner „KI Bearbeiten“) */
  aiProcess?: boolean;
  /** Agent, der die Ansicht betreut und Vorschläge macht */
  agentUserId?: string | null;
  agentName?: string | null;
}

/** Lauf der Mail-KI an einer Mail: Projekt-KI (ausgeführt) oder Agent (Vorschläge) */
export interface MailAiRun {
  id: string;
  mode: 'process' | 'triage';
  status: 'queued' | 'running' | 'ok' | 'error' | 'skipped';
  summary: string | null;
  error: string | null;
  agentName: string | null;
  actorName: string | null;
  createdAt: string;
  mail?: { id: string; subject: string; fromAddr: string; fromName: string | null; date: string };
  actions: { type: string; title?: string; text?: string; ref?: string; responsible?: string; dueDate?: string; startsAt?: string; location?: string; folder?: string; reason?: string; status: 'done' | 'error' | 'pending' | 'approved' | 'rejected'; result?: { ref?: string; taskId?: string; meetingId?: string; draftId?: string; folder?: string; error?: string } }[];
}

export interface MailSummary {
  id: string;
  accountId: string;
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
  viewId: string;
  viewName: string;
}

export interface MailDetail extends MailSummary {
  ccJson: string[];
  textBody: string | null;
  htmlBody: string | null;
  inReplyTo: string | null;
}

export interface MailDraft {
  id: string;
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
}

export interface DocFolder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  position: number;
  distributionList: string[];
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
  columns?: { name: string; kind: 'backlog' | 'active' | 'parked' | 'done'; wipLimit: number | null }[];
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
  inviteSentAt: string | null;
  createdBy: string | null;
  tasks: { id: string; title: string; done: boolean; number?: number | null }[];
  createdAt: string;
  /** Von KI eingetragen, verbindlich erst nach Bestätigung durch eine Person */
  tentative?: boolean;
  confirmedAt?: string | null;
}

export interface CalendarTarget { key: 'microsoft' | 'google' | 'caldav'; label: string; accountId: string | null }

export interface AiProfile { id: string; name: string; provider: 'anthropic' | 'local'; model: string; baseUrl: string | null; hasKey: boolean; active: boolean; /** Denkmodus des lokalen Modells aus (enable_thinking: false) */ thinkingOff: boolean }
export interface AgentUser { id: string; name: string; email: string; active: boolean; aiProfileId: string | null; /** von der PL für ihr Projekt angelegt */ projectBound?: { id: string; label: string } | null; dailyBudget?: number | null; /** Schreibstil als eine Zeile Freitext */ persona: string | null; /** Unterschrift für Mails, frei; null = Standard */ signature: string | null; /** Denkmodus: null = wie KI-Profil */ thinkingMode: 'off' | 'on' | null; createdAt: string; projects: { id: string; key: string; name: string }[]; runs: number; lastRunAt: string | null }
export interface AgentRun { id: string; agentId: string; agentName: string; taskId: string | null; taskTitle: string | null; taskNumber: number | null; trigger: string; status: 'ok' | 'error' | 'skipped'; reasoning: string | null; actions: { type: string; text?: string; column?: string; itemId?: string; to?: string[]; subject?: string; reason?: string }[]; proposed?: unknown[] | null; inputTokens: number; outputTokens: number; error: string | null; createdAt: string }

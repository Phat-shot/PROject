// Gemeinsame Typen für API und Web-Client.

export type GlobalRole = 'org_admin' | 'project_creator' | 'user';
export type ProjectRole = 'pl' | 'member' | 'reader';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';
export type DocStatus = 'draft' | 'review' | 'final';
export type MailAccountType = 'personal' | 'project' | 'org';
export type MailProviderKind = 'imap' | 'dev';
export type DraftStatus = 'draft' | 'pending_approval' | 'sent' | 'failed';

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  active: boolean;
  settings?: UserSettings;
}

export interface UserSettings {
  language?: 'de' | 'en';
  theme?: 'light' | 'dark' | 'system';
  /** Meldungen per Mail über das Org-Postfach: aus, sofort (gesammelt je Worker-Lauf) oder täglich als Digest (Standard) */
  mailNotifications?: 'off' | 'immediate' | 'daily';
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
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  mailAddress: string | null;
  visibility: 'members' | 'org';
  timeTrackingEnabled: boolean;
  budgetHours: number | null;
  escalation?: EscalationPolicy;
  reporting?: ReportingPolicy;
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
  recurrence: Recurrence | null;
  estimateMinutes: number | null;
  loggedMinutes: number;
  blocked: boolean;
  blockedReason: string | null;
  escalationLevel: number;
  escalatedAt: string | null;
  hasDescription: boolean;
  commentCount: number;
  attachmentCount: number;
  mailCount: number;
  checklistDone: number;
  checklistTotal: number;
  checklist?: ChecklistItem[];
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
  source?: 'user' | 'mail' | 'system';
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

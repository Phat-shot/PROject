import type { OwnLlmMode } from './ai/client.js';

/**
 * Persönliches Projekt bleibt ein Projekt (Konzept 18): dieselbe Basis, neun Abweichungen, jede genau hier.
 * Alle anderen Stellen fragen nur diese Entscheidungen (oder die SQL-Fragmente unten) ab und kennen das Flag nicht.
 */
export interface ProjectPolicy {
  personal: boolean;
  /** 9: Beschriftung in Org-Sichten und Begründungen */
  label: 'Projekt' | 'persönliches Projekt';
  /** 2: Mitglieder nur Eigentümer und Agenten; keine Gruppen, keine Einladungen */
  members: { onlyOwnerAndAgents: boolean; groups: boolean; invitations: boolean };
  /** 3: Sichtbarkeit „org“ wählbar? */
  visibility: { org: boolean };
  /** 4: Org-Admin: Inhalte, Konten/Ansichten/Entwürfe verwalten, Details im Audit, in Verwaltungslisten, PL neu bestimmen */
  adminAccess: { content: boolean; accounts: boolean; auditDetails: boolean; listed: boolean; lead: boolean };
  /** 5: Postfächer nur aus eigenen Bindungen; Rückfall auf das Org-Postfach beim Senden */
  mail: { ownOnly: boolean; orgFallback: boolean };
  /** 6: eigenes LLM je Mandantenschalter; Org-Profile nur mit Freigabe für persönliche Projekte; personalGate: KI nur mit Freigabe des Eigentümers (G) */
  ai: { ownLlm: (mode: OwnLlmMode) => boolean; orgProfilesNeedRelease: boolean; personalGate: boolean };
  /** 11: persönlicher Assistent (Agent mit agent_role assistant) nur hier; der Eigentümer legt ihn an */
  assistant: boolean;
  /** 7: Systembeiträge der Meldungen im Projektkanal */
  channelPosts: boolean;
  /** 8: Standardordner und Vorlage beim Anlegen; schlank = zwei Spalten, Ordner „Notizen“, Planungstiefe Checkliste, Eskalation und Reporting aus */
  scaffold: { defaultFolders: boolean; template: boolean; slim: boolean };
  /**
   * 10: schlanke Oberfläche: das Web blendet Plan, Risiken, Zeiten und Auswertung aus (umschaltbar je Projekt mit showAllTabs);
   * Datenmodell und Routen bleiben vollständig (Teilprojekte, Arbeitspakete, Aufgaben, Checklisten)
   */
  slim: boolean;
}

export function projectPolicy(p: { personal?: boolean | null; show_all_tabs?: boolean | null }): ProjectPolicy {
  const personal = Boolean(p.personal);
  return {
    slim: personal && !p.show_all_tabs,
    personal,
    label: personal ? 'persönliches Projekt' : 'Projekt',
    members: { onlyOwnerAndAgents: personal, groups: !personal, invitations: !personal },
    visibility: { org: !personal },
    adminAccess: { content: !personal, accounts: !personal, auditDetails: !personal, listed: !personal, lead: !personal },
    mail: { ownOnly: personal, orgFallback: !personal },
    ai: { ownLlm: (mode) => mode === 'all' || (mode === 'personal' && personal), orgProfilesNeedRelease: personal, personalGate: personal },
    assistant: personal,
    channelPosts: !personal,
    scaffold: { defaultFolders: !personal, template: !personal, slim: personal },
  };
}

/**
 * Darf die Person ein persönliches Projekt haben (und dort KI nutzen)? Freigabe je Person (users.personal_project_allowed) geht
 * vor: true = ja, false = gesperrt; null = Mandantenschalter „Persönliche Projekte“ (alle dürfen sich selbst eins anlegen).
 */
export function personalAllowed(user: { personalProjectAllowed?: boolean | null; globalRole?: string }, orgAllowsPersonal: boolean): boolean {
  return user.personalProjectAllowed ?? (orgAllowsPersonal || ['org_admin', 'project_creator'].includes(user.globalRole ?? ''));
}

/** 1: Anlegen. Projektersteller und Org-Admin immer; persönlich jede Person mit Freigabe (je Person, sonst Mandant bzw. Rolle); Agenten nie. null = erlaubt. */
export function createProjectReason(user: { kind?: string; globalRole: string; personalProjectAllowed?: boolean | null }, personal: boolean, orgAllowsPersonal: boolean): string | null {
  if (user.kind === 'agent') return 'KI-Agenten legen keine Projekte an';
  if (personal) return personalAllowed(user, orgAllowsPersonal) ? null : user.personalProjectAllowed === false ? TEXT.personalBlocked : TEXT.createDenied;
  return ['org_admin', 'project_creator'].includes(user.globalRole) ? null : 'Nur Projektersteller dürfen Projekte anlegen';
}

/** Schlankes persönliches Projekt: Spalten und Ordner beim Anlegen (F). */
export const PERSONAL_COLUMNS: [string, 'active' | 'done'][] = [['Offen', 'active'], ['Erledigt', 'done']];
export const PERSONAL_FOLDERS = ['Notizen'];
export const PERSONAL_PLANNING_DEPTH = 'checkliste';

/** Begründungen, einmal formuliert (API-Fehler und Tests). */
export const TEXT = {
  createDenied: 'Persönliche Projekte sind im Mandanten nicht freigegeben (Verwaltung)',
  personalBlocked: 'Persönliche KI für diese Person gesperrt (Verwaltung)',
  assistantBound: 'Ein Assistent arbeitet nur im persönlichen Projekt seiner Person und wird in kein anderes Projekt eingeladen',
  assistantOwnerOnly: 'Den Assistenten legt nur der Eigentümer des persönlichen Projekts an',
  assistantExists: 'In diesem persönlichen Projekt gibt es schon einen Assistenten',
  assistantNoProfile: 'Kein LLM für dein persönliches Projekt freigegeben (Verwaltung › KI: Freigabe für persönliche Projekte, oder eigenes LLM unter Einstellungen › KI)',
  assistantProfileNotReleased: 'Dieses LLM ist für dein persönliches Projekt nicht freigegeben',
  membersOnlyOwnerAndAgents: 'Persönliches Projekt: nur der Ersteller und KI-Agenten',
  noGroups: 'Persönliche Projekte nehmen keine Gruppen auf',
  noInvitations: 'In persönliche Projekte lädt man niemanden ein',
  noOrgVisibility: 'Persönliche Projekte sind nur für Mitglieder sichtbar',
  noTemplate: 'Persönliche Projekte starten leer (keine Vorlage)',
  adminNoLead: 'Persönliche Projekte gehören ihrem Ersteller',
  mailOwnOnly: 'Persönliche Projekte nehmen nur Mails aus eigenen Postfächern auf (persönliche Konten des Eigentümers, Projektkonto des Projekts)',
  noOrgFallback: 'Kein Projektkonto für den Mail-Schritt',
} as const;

/** SQL-Fragmente für Klauseln (Alias der Tabelle projects angeben). */
export const SQL = {
  isPersonal: (p = 'p') => `${p}.personal`,
  notPersonal: (p = 'p') => `not ${p}.personal`,
  /**
   * 6 (Dateiquellen wie LLM-Profile): Org-Quelle s im Projekt p freigegeben? Persönliche Projekte nur mit personal_use (all oder
   * users mit dem Eigentümer), alle anderen nach project_scope (all, selected mit Freigabeliste).
   */
  orgFileSourceReleased: (s = 's', p = 'p') => `case when ${p}.personal
        then (${s}.personal_use = 'all' or (${s}.personal_use = 'users' and exists (select 1 from file_source_personal_users pu where pu.source_id = ${s}.id and pu.user_id = ${p}.created_by)))
        else (${s}.project_scope = 'all' or (${s}.project_scope = 'selected' and exists (select 1 from file_source_release_projects rp where rp.source_id = ${s}.id and rp.project_id = ${p}.id))) end`,
};

/** Projektname für Org-Admin und Begründungen (Aliase p = projects, ow = Ersteller); persönliche Projekte nur als „persönlich (Eigentümer)“. */
export const projectLabelSql = (p = 'p', ow = 'ow') => `case when ${p}.personal then 'persönlich (' || coalesce(${ow}.name, '?') || ')' else ${p}.key || ' ' || ${p}.name end`;
export const PROJECT_LABEL_SQL = projectLabelSql();

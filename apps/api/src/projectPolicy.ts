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
  /** 6: eigenes LLM je Mandantenschalter; Org-Profile nur mit Freigabe für persönliche Projekte */
  ai: { ownLlm: (mode: OwnLlmMode) => boolean; orgProfilesNeedRelease: boolean };
  /** 7: Systembeiträge der Meldungen im Projektkanal */
  channelPosts: boolean;
  /** 8: Standardordner und Vorlage beim Anlegen */
  scaffold: { defaultFolders: boolean; template: boolean };
}

export function projectPolicy(p: { personal: boolean | null | undefined }): ProjectPolicy {
  const personal = Boolean(p.personal);
  return {
    personal,
    label: personal ? 'persönliches Projekt' : 'Projekt',
    members: { onlyOwnerAndAgents: personal, groups: !personal, invitations: !personal },
    visibility: { org: !personal },
    adminAccess: { content: !personal, accounts: !personal, auditDetails: !personal, listed: !personal, lead: !personal },
    mail: { ownOnly: personal, orgFallback: !personal },
    ai: { ownLlm: (mode) => mode === 'all' || (mode === 'personal' && personal), orgProfilesNeedRelease: personal },
    channelPosts: !personal,
    scaffold: { defaultFolders: !personal, template: !personal },
  };
}

/** 1: Anlegen. Projektersteller und Org-Admin immer; persönlich auch jede Person, wenn der Mandant es erlaubt; Agenten nie. null = erlaubt. */
export function createProjectReason(user: { kind?: string; globalRole: string }, personal: boolean, orgAllowsPersonal: boolean): string | null {
  if (['org_admin', 'project_creator'].includes(user.globalRole)) return null;
  if (personal && user.kind !== 'agent' && orgAllowsPersonal) return null;
  return personal ? TEXT.createDenied : 'Nur Projektersteller dürfen Projekte anlegen';
}

/** Begründungen, einmal formuliert (API-Fehler und Tests). */
export const TEXT = {
  createDenied: 'Persönliche Projekte sind im Mandanten nicht freigegeben (Verwaltung)',
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
};

/** Projektname für Org-Admin und Begründungen (Aliase p = projects, ow = Ersteller); persönliche Projekte nur als „persönlich (Eigentümer)“. */
export const projectLabelSql = (p = 'p', ow = 'ow') => `case when ${p}.personal then 'persönlich (' || coalesce(${ow}.name, '?') || ')' else ${p}.key || ' ' || ${p}.name end`;
export const PROJECT_LABEL_SQL = projectLabelSql();

/**
 * Persönliches Projekt bleibt ein Projekt (Konzept 18): dieselbe Basis, wenige Abweichungen, jede genau hier.
 * Spiegel von apps/api/src/projectPolicy.ts für die Oberfläche; andere Komponenten fragen nur diese Entscheidungen und Texte ab.
 */
export interface ProjectPolicyUi {
  personal: boolean;
  /** Kennzeichen in Listen und Kopfzeile */
  badge: { text: string; title: string } | null;
  /** Mitglieder: nur Eigentümer und Agenten; Gruppen; Einladungen */
  members: { onlyOwnerAndAgents: boolean; groups: boolean; invitations: boolean; notice: string | null };
  /** Sichtbarkeit „org“ wählbar */
  visibility: { org: boolean };
  /** Anlegen: Vorlage und Projektstart wählbar; Hinweistext */
  scaffold: { template: boolean; hint: string | null; title: string };
}

export const PERSONAL_BADGE_TITLE = 'Nur du und KI-Agenten';

export function projectPolicy(p: { personal?: boolean | null }): ProjectPolicyUi {
  const personal = Boolean(p.personal);
  return {
    personal,
    badge: personal ? { text: 'persönlich', title: PERSONAL_BADGE_TITLE } : null,
    members: {
      onlyOwnerAndAgents: personal, groups: !personal, invitations: !personal,
      notice: personal ? 'Persönliches Projekt: nur du und KI-Agenten. Weitere Personen, Gruppen und Einladungen sind gesperrt.' : null,
    },
    visibility: { org: !personal },
    scaffold: {
      template: !personal,
      title: personal ? 'Persönliches Projekt' : 'Neues Projekt',
      hint: personal ? 'Startet leer. Weitere Personen und Einladungen sind gesperrt, sichtbar nur für dich; der Org-Admin sieht im Audit keine Inhalte und verwaltet die Konten nicht. Agenten nimmst du unter Einstellungen › Mitglieder auf oder legst eigene an (wenn freigegeben). Mit einem Ordner „KI Bearbeiten“ im Postfach legt die Projekt-KI aus Mails direkt Aufgaben und Termine an.' : null,
    },
  };
}

/** Für Komponenten mit Projektkontext; reine Ableitung, kein Zustand. */
export const useProjectPolicy = projectPolicy;

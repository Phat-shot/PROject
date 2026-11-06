import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useProject } from '../../ProjectPage';
import { ContactsCard } from '../ContactsCard';
import { ReadOnlyNote, SettingsCard, SettingsRoutes } from '../../../components/settings/Settings';
import { Term } from '../../../components/ui';
import { MembersCard } from './People';
import { GeneralTab } from './General';
import { MailTab } from './Mail';
import { NotifyTab } from './Notify';
import { AiTab } from './Ai';
import { DeadlinesTab } from './Deadlines';
import { PlanningTab } from './Planning';
import { DataTab } from './Data';
import { FilesTab } from './Files';
import { AiView } from '../AiView';
import { projectPolicy } from '../../../lib/useProjectPolicy';

/**
 * Projekt › Einstellungen (Konzept Einstellungen 4.2): Reiter Allgemein, Personen, Mail, Benachrichtigungen, KI, Fristen und Berichte,
 * Planung und Board, Dateien, Daten. Alle Mitglieder lesen, die PL ändert; Reiter sind Routen unter /projekte/:id/einstellungen.
 */
export const PROJECT_SETTINGS_TABS: { key: string; label: string }[] = [
  { key: 'allgemein', label: 'Allgemein' }, { key: 'personen', label: 'Personen' }, { key: 'mail', label: 'Mail' }, { key: 'benachrichtigungen', label: 'Benachrichtigungen' },
  { key: 'ki', label: 'KI' }, { key: 'fristen', label: 'Fristen und Berichte' }, { key: 'planung', label: 'Planung und Board' }, { key: 'dateien', label: 'Dateien' }, { key: 'daten', label: 'Daten' }
];

/** Einleitender Satz je Reiter mit Link ins Handbuch (das Handbuch kennt keine Anker, daher die Kapitelnummer im Linktext). */
const INTRO: Record<string, { text: ReactNode; chapter: string }> = {
  allgemein: { text: 'Name, Kürzel, Beschreibung, Status und Zeiterfassung des Projekts; Aktionen wie Archivieren oder Übergeben.', chapter: 'Kapitel 13' },
  personen: { text: <>Wer im Projekt ist und was die Person darf: Mitglieder mit Rolle und Einzelrechten, Gruppen (<Term k="regelm">Regel M</Term>), Einladungen, Kontakte und Stakeholder.</>, chapter: 'Kapitel 13' },
  mail: { text: <>Postfächer und Ansichten des Projekts, die Antwortadresse (<Term k="pluscode">Plus-Code</Term>) und die <Term k="aussenpruefung">Außenprüfung</Term> für Mails an Externe.</>, chapter: 'Kapitel 6' },
  benachrichtigungen: { text: 'Welche Ereignisse wen auf welchem Weg erreichen (Chat, Mail, Log, Doku); geerbte Werte stehen grau, Änderungen werden sofort gespeichert.', chapter: 'Kapitel 13' },
  ki: { text: <>KI-Agenten im Projekt: einladen, einschränken, Projektagent, <Term k="policy">Policy</Term> und eigenes LLM. Die <Term k="grundmenge">Grundmenge</Term> bleibt immer frei; der <Term k="notaus">Notaus</Term> der Verwaltung geht vor.</>, chapter: 'Kapitel 11' },
  fristen: { text: <>Wann Verzug, <Term k="stillstand">Stillstand</Term> und Blockaden eskalieren und wie der Statusbericht aussieht.</>, chapter: 'Kapitel 10' },
  planung: { text: 'Teilprojekte, Meilensteine, Spalten des Boards und Ressourcen des Projekts.', chapter: 'Kapitel 4' },
  dateien: { text: 'Ordner aus Nextcloud oder einem WebDAV-Speicher, die in der Doku unter „Dateien“ erscheinen und durchsucht werden; das Tool liest nur.', chapter: 'Kapitel 7' },
  daten: { text: 'Papierkorb, Audit-Log und Export der Projektdaten.', chapter: 'Kapitel 13' },
  'ki-laeufe': { text: <>Offene KI-Vorschläge zur Freigabe (<Term k="essenz">Essenz</Term> aus Mails, Agenten-Aktionen), Fragen ans Projekt, Agenten-Läufe und der Statusbericht-Entwurf.</>, chapter: 'Kapitel 11' }
};

/** Persönliches Projekt: eigene Einleitung, wo der Reiter dort anders wirkt */
const INTRO_PERSONAL: Record<string, { text: ReactNode; chapter: string }> = {
  ki: { text: <>Dein Assistent: anlegen, LLM wählen, Selbstständigkeit und eigenes LLM. Die <Term k="grundmenge">Grundmenge</Term> bleibt immer frei; der <Term k="notaus">Notaus</Term> der Verwaltung geht vor.</>, chapter: 'Kapitel 14' }
};

function SettingsIntro({ tab }: { tab: string }) {
  const { detail } = useProject();
  const i = (projectPolicy(detail.project).assistant ? INTRO_PERSONAL[tab] : undefined) ?? INTRO[tab];
  if (!i) return null;
  return <p className="settings-intro"><span>{i.text}</span><Link className="help-link" to="/hilfe/handbuch" title={`Handbuch, ${i.chapter}`}>Hilfe: Handbuch {i.chapter} ↗</Link></p>;
}

export function ProjectSettingsPage() {
  const elements: Record<string, ReactNode> = { allgemein: <GeneralTab />, personen: <PeopleTab />, mail: <MailTab />, benachrichtigungen: <NotifyTab />, ki: <AiTab />, fristen: <DeadlinesTab />, planung: <PlanningTab />, dateien: <FilesTab />, daten: <DataTab /> };
  // KI-Läufe und offene KI-Vorschläge (früher eigener Reiter): Route immer, der Unterreiter nur bei aktiver KI (Kopfzeile)
  const tabs = [...PROJECT_SETTINGS_TABS.map((t) => ({ ...t, element: <><SettingsIntro tab={t.key} />{elements[t.key]}</> })), { key: 'ki-laeufe', label: 'KI-Läufe', element: <><SettingsIntro tab="ki-laeufe" /><AiView /></> }];
  return <SettingsRoutes tabs={tabs} />;
}

/** Personen: Mitglieder (Personen, Gruppen, Agenten) mit Einladung, dazu Kontakte und Stakeholder. */
function PeopleTab() {
  const { detail } = useProject();
  return (
    <>
      <MembersCard />
      <SettingsCard title="Kontakte und Stakeholder">{detail.project.myMembership.role === 'reader' && <ReadOnlyNote who="Mitglieder" />}<ContactsCard /></SettingsCard>
    </>
  );
}

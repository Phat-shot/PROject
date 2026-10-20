import type { ReactNode } from 'react';
import { useProject } from '../../ProjectPage';
import { ContactsCard } from '../ContactsCard';
import { ReadOnlyNote, SettingsCard, SettingsRoutes } from '../../../components/settings/Settings';
import { MembersCard } from './People';
import { GeneralTab } from './General';
import { MailTab } from './Mail';
import { NotifyTab } from './Notify';
import { AiTab } from './Ai';
import { DeadlinesTab } from './Deadlines';
import { PlanningTab } from './Planning';
import { DataTab } from './Data';

/**
 * Projekt › Einstellungen (Konzept Einstellungen 4.2): Reiter Allgemein, Personen, Mail, Benachrichtigungen, KI, Fristen und Berichte,
 * Planung und Board, Daten. Alle Mitglieder lesen, die PL ändert; Reiter sind Routen unter /projekte/:id/einstellungen.
 */
export const PROJECT_SETTINGS_TABS: { key: string; label: string }[] = [
  { key: 'allgemein', label: 'Allgemein' }, { key: 'personen', label: 'Personen' }, { key: 'mail', label: 'Mail' }, { key: 'benachrichtigungen', label: 'Benachrichtigungen' },
  { key: 'ki', label: 'KI' }, { key: 'fristen', label: 'Fristen und Berichte' }, { key: 'planung', label: 'Planung und Board' }, { key: 'daten', label: 'Daten' }
];

export function ProjectSettingsPage() {
  const elements: Record<string, ReactNode> = { allgemein: <GeneralTab />, personen: <PeopleTab />, mail: <MailTab />, benachrichtigungen: <NotifyTab />, ki: <AiTab />, fristen: <DeadlinesTab />, planung: <PlanningTab />, daten: <DataTab /> };
  return <SettingsRoutes tabs={PROJECT_SETTINGS_TABS.map((t) => ({ ...t, element: elements[t.key] }))} />;
}

/** Personen: Mitglieder (Personen, Gruppen, Agenten) mit Einladung, dazu Kontakte und Stakeholder. */
function PeopleTab() {
  const { detail } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  return (
    <>
      <MembersCard />
      <SettingsCard title="Kontakte und Stakeholder">{detail.project.myMembership.role === 'reader' && <ReadOnlyNote who="Mitglieder" />}{!isPl && null}<ContactsCard /></SettingsCard>
    </>
  );
}

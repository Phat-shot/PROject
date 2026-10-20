import { useProject } from '../../ProjectPage';
import { ProjectNotifyCard } from '../../../components/NotifyRules';
import { SettingsCard, ReadOnlyNote } from '../../../components/settings/Settings';

/** Projekt › Einstellungen › Benachrichtigungen: Regeln des Projekts (erben von der Org), Doku-Seite, Vorschau „Wer bekommt was?“. */
export function NotifyTab() {
  const { detail } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  return <SettingsCard title="Benachrichtigungsregeln">{!isPl && <ReadOnlyNote who="PL" />}<ProjectNotifyCard projectId={detail.project.id} members={detail.members} /></SettingsCard>;
}

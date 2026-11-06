import { TrashCard } from '../TrashCard';
import { AuditView } from '../AuditView';
import { SettingsCard } from '../../../components/settings/Settings';
import { ImportCard } from './ImportCard';

/** Projekt › Einstellungen › Daten: CSV-Import, Papierkorb und Audit-Log. */
export function DataTab() {
  return (
    <>
      <SettingsCard title="Import (CSV)"><ImportCard /></SettingsCard>
      <SettingsCard title="Papierkorb"><TrashCard /></SettingsCard>
      <AuditView embedded />
    </>
  );
}

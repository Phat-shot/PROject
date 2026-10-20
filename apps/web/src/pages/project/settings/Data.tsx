import { TrashCard } from '../TrashCard';
import { AuditView } from '../AuditView';
import { SettingsCard } from '../../../components/settings/Settings';

/** Projekt › Einstellungen › Daten: Papierkorb und Audit-Log. */
export function DataTab() {
  return (
    <>
      <SettingsCard title="Papierkorb"><TrashCard /></SettingsCard>
      <AuditView embedded />
    </>
  );
}

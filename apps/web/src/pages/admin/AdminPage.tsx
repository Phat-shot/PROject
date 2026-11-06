import type { User } from '@projekttool/shared';
import { Link } from 'react-router-dom';
import { useData } from '../../lib/useData';
import { TopBar } from '../../components/Layout';
import { useAuth } from '../../lib/auth';
import { OrgNotifyCard } from '../../components/NotifyRules';
import { AccountsCard } from '../../components/mail/Accounts';
import { SettingsRoutes, settingsTabLinks, type SettingsTab } from '../../components/settings/Settings';
import { GroupsCard, InvitationsCard, ProjectLeadsCard, UsersCard } from './People';
import { OrgGeneralCard } from './OrgGeneral';
import { MailDefaultsCard } from './OrgMail';
import { AiSection } from './Ai';
import { PoolResourcesCard, ProjectTemplatesCard, TemplatesCard } from './Templates';
import { SsoCard } from './Security';
import { AuditCard } from './Data';
import { TelephonySection } from './Telephony';
import { FileSourcesSection } from './FileSources';

const BASE = '/verwaltung';

/**
 * Verwaltung (Konzept Einstellungen 4.2): Reiter Allgemein, Personen, Mail, Benachrichtigungen, KI, Dateiquellen, Planung und Board, Telefonie, Sicherheit, Daten.
 * Der Org-Admin sieht alles; die KI-Verwaltung (ai_admin) nur KI, die Gruppenverwaltung (groups_admin) und Verwalter einer Gruppe nur
 * die Gruppen unter Personen, die Ressourcenverwaltung (resources_admin) nur den Pool unter Planung und Board.
 * Ohne eines dieser Rechte (Direktaufruf der Adresse) ein Hinweis mit Weg zurück; der Menüpunkt ist dann ausgeblendet.
 */
export function AdminPage() {
  const { user } = useAuth();
  const isAdmin = user?.globalRole === 'org_admin';
  const aiAdmin = isAdmin || Boolean(user?.orgRights?.includes('ai_admin'));
  const groupsAdmin = isAdmin || Boolean(user?.orgRights?.includes('groups_admin'));
  const resourcesAdmin = isAdmin || Boolean(user?.orgRights?.includes('resources_admin'));
  const users = useData<{ users: User[] }>(isAdmin ? '/users?all=1' : '/users');
  const list = users.data?.users ?? [];
  const tabs: SettingsTab[] = [];
  if (isAdmin) tabs.push({ key: 'allgemein', label: 'Allgemein', element: <OrgGeneralCard /> });
  if (isAdmin || groupsAdmin || user?.managesGroups) tabs.push({ key: 'personen', label: 'Personen', element: <>
    {isAdmin && <UsersCard users={list} reload={users.reload} />}
    {isAdmin && <InvitationsCard onAccepted={() => void users.reload()} />}
    <GroupsCard users={list} canAdmin={groupsAdmin} />
    {isAdmin && <ProjectLeadsCard users={list} />}
  </> });
  if (isAdmin) tabs.push({ key: 'mail', label: 'Mail', element: <><AccountsCard scope="org" /><MailDefaultsCard /><AccountsCard scope="all" /></> });
  if (isAdmin) tabs.push({ key: 'benachrichtigungen', label: 'Benachrichtigungen', element: <OrgNotifyCard /> });
  if (aiAdmin) tabs.push({ key: 'ki', label: 'KI', element: <AiSection /> });
  if (isAdmin) tabs.push({ key: 'dateiquellen', label: 'Dateiquellen', element: <FileSourcesSection /> });
  if (isAdmin || resourcesAdmin) tabs.push({ key: 'planung', label: 'Planung und Board', element: <><PoolResourcesCard />{isAdmin && <ProjectTemplatesCard />}{isAdmin && <TemplatesCard />}</> });
  if (isAdmin) tabs.push({ key: 'telefonie', label: 'Telefonie', element: <TelephonySection /> });
  if (isAdmin) tabs.push({ key: 'sicherheit', label: 'Sicherheit', element: <SsoCard /> });
  if (isAdmin) tabs.push({ key: 'daten', label: 'Daten', element: <AuditCard /> });
  const noRights = (
    <div className="card">
      <h2>Keine Verwaltungsrechte</h2>
      <p className="muted">Die Verwaltung sieht der Org-Admin; mit den Org-Rechten KI, Gruppen oder Ressourcen oder als Verwalter einer Gruppe nur die passenden Reiter. Deine eigenen Einstellungen findest du unter „Meine Einstellungen“.</p>
      <div className="row"><Link className="btn primary" to="/dashboard">Zum Dashboard</Link><Link className="btn" to="/einstellungen">Meine Einstellungen</Link></div>
    </div>
  );
  return (
    <>
      <TopBar title={isAdmin ? 'Verwaltung' : tabs.length === 1 ? `Verwaltung › ${tabs[0].label}` : 'Verwaltung'} tabs={settingsTabLinks(BASE, tabs)} />
      <SettingsRoutes tabs={tabs} fallback={noRights} />
    </>
  );
}

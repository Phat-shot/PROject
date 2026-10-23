import type { User } from '@projekttool/shared';
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

const BASE = '/verwaltung';

/**
 * Verwaltung (Konzept Einstellungen 4.2): Reiter Allgemein, Personen, Mail, Benachrichtigungen, KI, Planung und Board, Telefonie, Sicherheit, Daten.
 * Der Org-Admin sieht alles; die KI-Verwaltung (ai_admin) nur KI, die Gruppenverwaltung (groups_admin) und Verwalter einer Gruppe nur
 * die Gruppen unter Personen, die Ressourcenverwaltung (resources_admin) nur den Pool unter Planung und Board.
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
  if (isAdmin || resourcesAdmin) tabs.push({ key: 'planung', label: 'Planung und Board', element: <><PoolResourcesCard />{isAdmin && <ProjectTemplatesCard />}{isAdmin && <TemplatesCard />}</> });
  if (isAdmin) tabs.push({ key: 'telefonie', label: 'Telefonie', element: <TelephonySection /> });
  if (isAdmin) tabs.push({ key: 'sicherheit', label: 'Sicherheit', element: <SsoCard /> });
  if (isAdmin) tabs.push({ key: 'daten', label: 'Daten', element: <AuditCard /> });
  return (
    <>
      <TopBar title={isAdmin ? 'Verwaltung' : tabs.length === 1 ? `Verwaltung › ${tabs[0].label}` : 'Verwaltung'} tabs={settingsTabLinks(BASE, tabs)} />
      <SettingsRoutes tabs={tabs} />
    </>
  );
}

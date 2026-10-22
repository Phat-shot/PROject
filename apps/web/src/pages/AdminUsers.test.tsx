import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { User } from '@projekttool/shared';

const get = vi.fn();
const patch = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), del: vi.fn() }, downloadCsv: vi.fn(), fmtDateTime: (d: string) => d }));
vi.mock('../lib/useAi', () => ({ invalidateAi: vi.fn(async () => undefined), useAiStatus: () => null }));
let me = 'u0';
let extra: Partial<User> = {};
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: me, globalRole: me === 'u0' ? 'org_admin' : 'user', ...extra } }) }));
vi.mock('../components/RichEditor', () => ({ RichEditor: () => null }));
vi.mock('../components/Layout', () => ({ TopBar: () => null }));
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdminPage } from './admin/AdminPage';
import { GroupsCard, ProjectLeadsCard, UsersCard } from './admin/People';

const person = (id: string, name: string, extra: Partial<User> = {}): User => ({ id, orgId: 'o1', email: `${id}@demo.local`, name, globalRole: 'user', orgRights: [], active: true, kind: 'person', ...extra });
const users: User[] = [
  person('u0', 'Alex Admin', { globalRole: 'org_admin' }),
  person('u1', 'Max Keller'),
  person('u2', 'Lea Reuter'),
  person('u3', 'Gina Ruhend', { active: false }),
  person('a1', 'Morton', { kind: 'agent' })
];

describe('Verwaltung: Benutzer', () => {
  const reload = vi.fn(async () => undefined);
  beforeEach(() => { me = 'u0'; extra = {}; patch.mockReset(); patch.mockResolvedValue({}); post.mockReset(); reload.mockClear(); });

  it('ändert Rolle und Org-Rechte, reaktiviert Deaktivierte; den eigenen Zugang deaktiviert man nicht', async () => {
    render(<UsersCard users={users} reload={reload} />);
    fireEvent.change(screen.getByLabelText('Globale Rolle Max Keller'), { target: { value: 'project_creator' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/users/u1', { globalRole: 'project_creator' }));
    const lea = screen.getByText('Lea Reuter').closest('tr')!;
    fireEvent.click(within(lea).getByLabelText('Gruppen verwalten'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/users/u2', { orgRights: ['groups_admin'] }));
    const gina = screen.getByText('Gina Ruhend').closest('tr')!;
    expect(within(gina).getByText('deaktiviert')).toBeInTheDocument();
    expect(within(gina).queryByRole('button', { name: 'Deaktivieren' })).not.toBeInTheDocument();
    fireEvent.click(within(gina).getByRole('button', { name: 'Reaktivieren' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/users/u3', { active: true }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const own = screen.getByText('Alex Admin').closest('tr')!;
    expect(within(own).queryByRole('button', { name: 'Deaktivieren' })).not.toBeInTheDocument();
    expect(within(lea).getByRole('button', { name: 'Deaktivieren' })).toBeInTheDocument();
    expect(within(screen.getByText('Morton').closest('tr')!).queryByRole('combobox')).not.toBeInTheDocument();
  });
});

describe('Verwaltung: Gruppen mit Verwaltern', () => {
  const groups = [
    { id: 'g1', name: 'Bau', description: null, memberIds: ['u1', 'u2'], managerIds: ['u1'] },
    { id: 'g2', name: 'Fremd', description: null, memberIds: ['u2'], managerIds: [] }
  ];
  beforeEach(() => {
    extra = {};
    patch.mockReset(); patch.mockResolvedValue({}); post.mockReset(); post.mockResolvedValue({});
    get.mockReset(); get.mockResolvedValue({ groups });
  });

  it('Verwalter sieht nur seine Gruppe und pflegt nur die Mitglieder', async () => {
    me = 'u1';
    render(<GroupsCard users={users} canAdmin={false} />);
    expect(await screen.findByText('Bau')).toBeInTheDocument();
    expect(screen.queryByText('Fremd')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Gruppe' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '✕' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Verwalter Max Keller')).not.toBeInTheDocument();
    const modal = screen.getByText('Mitglieder', { selector: 'span' }).parentElement!;
    expect(within(modal).getByLabelText('Max Keller')).toBeDisabled();
    expect(within(modal).queryByLabelText('Morton')).not.toBeInTheDocument();
    expect(within(modal).queryByLabelText('Gina Ruhend')).not.toBeInTheDocument();
    fireEvent.click(within(modal).getByLabelText('Alex Admin'));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/groups/g1', { memberIds: ['u1', 'u2', 'u0'] }));
  });

  it('Gruppenverwaltung setzt Verwalter (werden Mitglied)', async () => {
    me = 'u0';
    render(<GroupsCard users={users} canAdmin />);
    expect(await screen.findByText('Fremd')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Bearbeiten' })[1]);
    fireEvent.click(screen.getByLabelText('Verwalter Max Keller'));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/groups/g2', { name: 'Fremd', description: '', idpName: '', memberIds: ['u2', 'u1'], managerIds: ['u1'] }));
  });
});

describe('Verwaltung: verantwortliche PL neu bestimmen', () => {
  beforeEach(() => {
    me = 'u0'; extra = {};
    get.mockReset(); get.mockResolvedValue({ projects: [{ id: 'p1', key: 'WEB', name: 'Website', status: 'active', lead: { userId: 'u1', name: 'Max Keller', active: true } }] });
    put.mockReset(); put.mockResolvedValue({ ok: true, transferred: 0 });
  });

  it('wählt eine andere aktive Person (nicht sich selbst, nicht die bisherige PL, keine Agenten) und überträgt auf Wunsch die Arbeitspakete', async () => {
    render(<ProjectLeadsCard users={users} />);
    const row = (await screen.findByText('WEB')).closest('tr')!;
    expect(within(row).getByText('Max Keller')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'PL neu bestimmen' }));
    const select = screen.getByLabelText('Neue verantwortliche PL');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Lea Reuter (u2@demo.local)']);
    fireEvent.click(screen.getByLabelText(/direkt zugewiesene Arbeitspakete/));
    fireEvent.click(screen.getByRole('button', { name: 'Bestimmen' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/projects/p1/lead', { userId: 'u2', transferTasks: true }));
  });
});

describe('Verwaltung ohne Org-Admin: nur die passenden Karten', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(async (url: string) => (url === '/groups' ? { groups: [{ id: 'g1', name: 'Bau', description: null, memberIds: ['u1', 'u2'], managerIds: ['u2'] }] } : { users }));
  });

  it('Gruppenverwaltung (Org-Recht) sieht alle Gruppen, keine Benutzer, keine KI', async () => {
    me = 'u1'; extra = { orgRights: ['groups_admin'] };
    render(<MemoryRouter initialEntries={['/verwaltung']}><Routes><Route path="/verwaltung/*" element={<AdminPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('Berechtigungsgruppen')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '+ Gruppe' })).toBeInTheDocument();
    expect(screen.queryByText('Benutzer')).not.toBeInTheDocument();
    expect(screen.queryByText('Projekte: verantwortliche PL')).not.toBeInTheDocument();
  });

  it('Verwalter einer Gruppe sieht nur seine Gruppe', async () => {
    me = 'u2'; extra = { managesGroups: true };
    render(<MemoryRouter initialEntries={['/verwaltung']}><Routes><Route path="/verwaltung/*" element={<AdminPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('Bau')).toBeInTheDocument();
    expect(screen.getByText('Berechtigungsgruppen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Gruppe' })).not.toBeInTheDocument();
  });

  it('ohne Org-Recht und ohne Gruppe: keine Karte', () => {
    me = 'u1'; extra = { managesGroups: false };
    render(<MemoryRouter initialEntries={['/verwaltung']}><Routes><Route path="/verwaltung/*" element={<AdminPage />} /></Routes></MemoryRouter>);
    expect(screen.queryByText('Berechtigungsgruppen')).not.toBeInTheDocument();
  });
});

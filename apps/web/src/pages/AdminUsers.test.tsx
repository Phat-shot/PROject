import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { User } from '@projekttool/shared';

const get = vi.fn();
const patch = vi.fn();
const post = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), put: vi.fn(), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), del: vi.fn() }, downloadCsv: vi.fn(), fmtDateTime: (d: string) => d }));
vi.mock('../lib/useAi', () => ({ invalidateAi: vi.fn(async () => undefined), useAiStatus: () => null }));
let me = 'u0';
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: me, globalRole: me === 'u0' ? 'org_admin' : 'user' } }) }));
vi.mock('../components/RichEditor', () => ({ RichEditor: () => null }));
vi.mock('../components/Layout', () => ({ TopBar: () => null }));
import { GroupsCard, UsersCard } from './AdminPage';

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
  beforeEach(() => { me = 'u0'; patch.mockReset(); patch.mockResolvedValue({}); post.mockReset(); reload.mockClear(); });

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

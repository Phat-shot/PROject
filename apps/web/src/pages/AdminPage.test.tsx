import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const get = vi.fn();
const put = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a), post: vi.fn(), patch: vi.fn(), del: vi.fn() }, downloadCsv: vi.fn(), fmtDateTime: (d: string) => d }));
vi.mock('../lib/useAi', () => ({ invalidateAi: vi.fn(async () => undefined), useAiStatus: () => null }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u0', globalRole: 'org_admin' } }) }));
vi.mock('../components/RichEditor', () => ({ RichEditor: () => null }));
vi.mock('../components/Layout', () => ({ TopBar: () => null }));
import { AiPolicyCard } from './AdminPage';

describe('KI-Freigaben: Matrix', () => {
  const listing = { rules: [] as unknown[], killswitch: false, stoppedAgents: [] };
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
    get.mockImplementation(async (url: string) => url === '/ai/policies' ? listing
      : { projects: [{ id: 'p1', label: 'BAU Neubau' }], users: [{ id: 'u1', name: 'Max Keller', email: 'max@demo.local' }], agents: [{ id: 'a1', name: 'Morton' }], groups: [{ id: 'g1', name: 'Elektro' }] });
    put.mockImplementation(async (_url: string, body: Record<string, unknown>) => ({ ...listing, rules: [{ id: 'r1', setBy: null, setByName: null, updatedAt: '', projectLabel: 'BAU Neubau', userName: 'Morton', userKind: 'agent', groupName: null, ...body }] }));
  });

  it('legt eine Ausnahme „Agent in Projekt“ an (Morton nur in BAU)', async () => {
    render(<AiPolicyCard />);
    fireEvent.change(await screen.findByLabelText('Zeilenart'), { target: { value: 'exception' } });
    fireEvent.change(screen.getByLabelText('Projekt'), { target: { value: 'p1' } });
    const who = screen.getByLabelText('Wer');
    expect(within(who).getByRole('group', { name: 'Agenten' })).toHaveTextContent('Morton');
    expect(within(who).getByRole('group', { name: 'Personen' })).toHaveTextContent('Max Keller');
    fireEvent.change(who, { target: { value: 'a1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    const row = screen.getByText('Morton in BAU Neubau').closest('tr')!;
    fireEvent.click(within(row).getAllByRole('button')[0]);
    fireEvent.click(screen.getByLabelText('sperren'));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/ai/policies', { projectId: 'p1', userId: 'a1', groupId: null, feature: '*', effect: 'deny', note: null }));
    expect(await screen.findByText('Morton in BAU Neubau')).toBeInTheDocument();
  });
});

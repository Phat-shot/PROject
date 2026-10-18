import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const put = vi.fn();
const del = vi.fn();
const reload = vi.fn(async () => undefined);
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), put: (...a: unknown[]) => put(...a), patch: vi.fn(), del: (...a: unknown[]) => del(...a) }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-10-18' }));
const member = (userId: string, name: string, role: string, origin: 'direct' | 'group', extra: Record<string, unknown> = {}) => ({ projectId: 'p1', userId, name, email: `${userId}@demo.local`, role, origin, isDeputy: false, canEditPlan: false, canApprove: false, canFinalize: false, canUseAi: role !== 'reader', kind: 'person', ...extra });
let personal = false;
let myMembership: Record<string, unknown> = { role: 'pl', isDeputy: false };
let ai: unknown = null;
const detail = () => ({
  project: { id: 'p1', personal, myMembership },
  members: [
    member('u1', 'Petra Lenz', 'pl', 'direct'),
    member('u2', 'Max Keller', 'member', 'group', { canApprove: true }),
    member('u3', 'Lea Reuter', 'reader', 'direct')
  ],
  groups: [{ projectId: 'p1', groupId: 'g1', name: 'Elektro-Team', role: 'member', canEditPlan: false, canApprove: true, canFinalize: false, canUseAi: true, memberIds: ['u2', 'u3'] }],
  subprojects: []
});
const candidates = [{ id: 'u9', name: 'Nora Neu', email: 'nora@demo.local', kind: 'person', globalRole: 'user', active: true }];
vi.mock('../ProjectPage', () => ({ useProject: () => ({ detail: detail(), users: candidates, reload, tasks: [], reloadTasks: vi.fn(), ai }), useProjectOptional: () => null }));
vi.mock('../../lib/useAi', () => ({ useAiStatus: () => null, invalidateAi: vi.fn(), aiBlocked: () => undefined }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ timeTracking: false, user: { id: 'u1' } }) }));
vi.mock('../../components/RichEditor', () => ({ RichEditor: () => null }));
vi.mock('./MailAi', () => ({ MailAiBox: () => null, AiFolderDialog: () => null }));
vi.mock('./InviteCard', () => ({ InviteCard: () => null }));
import { MembersCard } from './MembersView';

const renderCard = () => render(<MemoryRouter><MembersCard /></MemoryRouter>);

describe('Projekteinstellungen: Mitglieder mit Herkunft und Gruppen (Regel M)', () => {
  beforeEach(() => {
    personal = false; myMembership = { role: 'pl', isDeputy: false }; ai = null;
    get.mockReset(); put.mockReset(); del.mockReset(); reload.mockClear();
    get.mockResolvedValue({ groups: [{ id: 'g1', name: 'Elektro-Team', memberIds: ['u2', 'u3'], managerIds: [] }, { id: 'g2', name: 'Lenkungskreis', memberIds: ['u1'], managerIds: [] }] });
    put.mockResolvedValue({}); del.mockResolvedValue({ ok: true });
  });

  it('zeigt die Herkunft: über Gruppe bzw. direkt mit „überschreibt …“; Gruppenrechte übernehmen löscht den Direkteintrag', async () => {
    renderCard();
    const max = screen.getByText('Max Keller').closest('tr')!;
    expect(within(max).getByText('über Elektro-Team')).toBeInTheDocument();
    expect(within(max).getByText('Freigeben, KI nutzen')).toBeInTheDocument();
    expect(within(max).queryByRole('button', { name: 'Entfernen' })).not.toBeInTheDocument();
    expect(within(max).getByRole('button', { name: 'Rolle' })).toBeInTheDocument();
    const lea = screen.getByText('Lea Reuter').closest('tr')!;
    expect(within(lea).getByText(/überschreibt Elektro-Team \(Mitglied\)/)).toBeInTheDocument();
    expect(within(screen.getByText('Petra Lenz').closest('tr')!).queryByText(/überschreibt/)).not.toBeInTheDocument();
    fireEvent.click(within(lea).getByRole('button', { name: 'Gruppenrechte übernehmen' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/projects/p1/members/u3'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const groups = screen.getByText('Gruppen im Projekt').nextElementSibling!;
    expect(within(groups as HTMLElement).getByText('Elektro-Team')).toBeInTheDocument();
    expect(within(groups as HTMLElement).getByText('2 Personen')).toBeInTheDocument();
  });

  it('Gruppe hinzufügen: Leser ohne „KI nutzen“ vorbelegt, Einzelrechte nur für Mitglieder', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Gruppe hinzufügen' }));
    const select = await screen.findByLabelText('Gruppe');
    await waitFor(() => expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Lenkungskreis (1)']));
    expect(screen.getByLabelText('KI nutzen')).toBeChecked();
    fireEvent.change(screen.getByLabelText('Rolle der Gruppe'), { target: { value: 'reader' } });
    expect(screen.queryByLabelText(/Projektplan/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('KI nutzen (nur Fragen)')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/projects/p1/groups/g2', { role: 'reader', canEditPlan: false, canApprove: false, canFinalize: false, canUseAi: false }));
  });

  it('Person hinzufügen: „KI nutzen“ folgt der Rolle (Mitglied an, Leser aus) und wird so gespeichert', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    expect(screen.getByLabelText('KI nutzen')).toBeChecked();
    fireEvent.change(screen.getByLabelText('Projektrolle'), { target: { value: 'reader' } });
    expect(screen.getByLabelText('KI nutzen (nur Fragen)')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/projects/p1/members/u9', expect.objectContaining({ role: 'reader', canUseAi: false })));
  });

  it('„Rolle“ bei einem Mitglied über eine Gruppe legt einen Direkteintrag an', async () => {
    renderCard();
    fireEvent.click(within(screen.getByText('Max Keller').closest('tr')!).getByRole('button', { name: 'Rolle' }));
    expect(screen.getByText('Direkteintrag: Max Keller')).toBeInTheDocument();
    expect(screen.getByText(/Mitglied über Elektro-Team\. Speichern legt einen Direkteintrag an/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/projects/p1/members/u2', expect.objectContaining({ role: 'member', canApprove: true, canUseAi: true })));
  });

  it('Deine Rechte: Rolle, Einzelrechte und je KI-Funktion erlaubt oder die Begründung', () => {
    myMembership = { role: 'member', isDeputy: false, canEditPlan: true, canApprove: false, canFinalize: false, canUseAi: true };
    ai = { killswitch: false, agents: [], features: {
      'assist.ask': { allowed: true, reason: 'Mitglied mit „KI nutzen“', stage: 'project' },
      'assist.summarize': { allowed: false, reason: 'Im Projekt gesperrt (Regel des Org-Admins)', stage: 'org' },
      'pl.agents': { allowed: false, reason: 'Nur PL', stage: 'project' }
    } };
    renderCard();
    expect(screen.getByText('Deine Rechte')).toBeInTheDocument();
    expect(screen.getByText('Mitglied · Einzelrechte: Projektplan ändern, KI nutzen')).toBeInTheDocument();
    expect(within(screen.getByText('Frage ans Projekt').closest('tr')!).getByText('erlaubt')).toBeInTheDocument();
    expect(within(screen.getByText('Mail zusammenfassen').closest('tr')!).getByText('gesperrt: Im Projekt gesperrt (Regel des Org-Admins)')).toBeInTheDocument();
    expect(screen.queryByText('Eigene Agenten der PL')).not.toBeInTheDocument();
  });

  it('Deine Rechte als Leser: nur die Auskunftsfunktionen', () => {
    myMembership = { role: 'reader', isDeputy: false, canEditPlan: false, canApprove: false, canFinalize: false, canUseAi: true };
    ai = { killswitch: false, agents: [], features: { 'assist.ask': { allowed: true, reason: 'Leser mit „KI nutzen“', stage: 'project' }, 'assist.summarize': { allowed: false, reason: 'Leser stellen nur Fragen ans Projekt', stage: 'project' } } };
    renderCard();
    expect(screen.getByText('Frage ans Projekt')).toBeInTheDocument();
    expect(screen.getByText('Chat mit Agenten')).toBeInTheDocument();
    expect(screen.queryByText('Mail zusammenfassen')).not.toBeInTheDocument();
  });

  it('persönliches Projekt: keine Gruppen', () => {
    personal = true;
    renderCard();
    expect(screen.queryByRole('button', { name: 'Gruppe hinzufügen' })).not.toBeInTheDocument();
    expect(screen.queryByText('Gruppen im Projekt')).not.toBeInTheDocument();
  });
});

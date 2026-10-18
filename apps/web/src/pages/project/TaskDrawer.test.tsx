import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-10-18' }));
let membership = { role: 'pl', canEditPlan: true, userId: 'u1' };
vi.mock('../ProjectPage', () => ({
  useProject: () => ({
    detail: { project: { id: 'p1', key: 'WEB', myMembership: membership, mailAddress: null, timeTrackingEnabled: false }, columns: [{ id: 'c1', name: 'Offen', kind: 'active', isDone: false }], subprojects: [], members: [{ userId: 'u1', name: 'Petra Lenz' }, { userId: 'u2', name: 'Max Keller' }], labels: [] },
    users: [], tasks: [], reloadTasks: vi.fn(async () => undefined), openTask: vi.fn(), ai: null
  }),
  useProjectOptional: () => null
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ timeTracking: false }) }));
vi.mock('../../lib/useData', () => ({ useData: () => ({ data: null, error: null, loading: false, reload: async () => undefined }) }));
vi.mock('../../lib/useContacts', () => ({ useContacts: () => ({ contacts: [] }), contactLabel: (c: { email: string }) => c.email }));
vi.mock('../../lib/useAi', () => ({ aiBlocked: () => undefined }));
vi.mock('./BoardView', () => ({ LabelPicker: () => null }));
vi.mock('./CopyMove', () => ({ CopyMoveDialog: () => null }));
vi.mock('./TimeView', () => ({ fmtH: (m: number) => String(m) }));
vi.mock('../../components/QuickMail', () => ({ QuickMail: () => null }));
import { TaskDrawer } from './TaskDrawer';

const task = {
  id: 't1', number: 9, title: 'Fliesen koordinieren', done: false, parentId: null, parent: null, archivedAt: null, deletedAt: null, responsibleUserId: null, responsibleEmail: null,
  responsible: { userId: null, name: 'Petra Lenz', email: null, inherited: true, inheritedFrom: 'pl' }, blocked: false, blockedReason: null, escalationLevel: 0, conflicts: [], columnId: 'c1', subprojectId: null,
  priority: 'normal', labelIds: [], startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, mailCode: 'abc', description: 'Intern: Budget 8.000 EUR', externalBrief: 'Lieferung und Verlegung im Bad',
  recurrence: null, checklistTotal: 0, checklistDone: 0, checklist: [], subtaskTotal: 0, subtaskDone: 0, agentPaused: false, agentWait: null, agentNextCheckAt: null
};
const comments = [
  { id: 'k1', userId: 'u2', userName: 'Max Keller', body: 'Abnahme am 30.10. vor Ort.', source: 'user', visibility: 'external', createdAt: '2026-10-18', mailId: null },
  { id: 'k2', userId: 'u2', userName: 'Max Keller', body: 'Intern: Budget knapp.', source: 'user', visibility: 'internal', createdAt: '2026-10-18', mailId: null }
];
const renderDrawer = () => render(<MemoryRouter><TaskDrawer taskId="t1" onClose={() => undefined} /></MemoryRouter>);

describe('TaskDrawer: Informationsgrenze für Externe', () => {
  beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset();
    get.mockResolvedValue({ task, subtasks: [], comments, mails: [], attachments: [] });
    post.mockResolvedValue({ comment: {} });
    patch.mockResolvedValue({});
    membership = { role: 'pl', canEditPlan: true, userId: 'u1' };
  });

  it('Badge „für Externe sichtbar“ nur an freigegebenen Log-Einträgen; Umschalter sendet die Sichtbarkeit', async () => {
    renderDrawer();
    const ext = await screen.findByText('Abnahme am 30.10. vor Ort.');
    expect(ext.closest('.comment')).toHaveTextContent('für Externe sichtbar');
    expect(screen.getByText('Intern: Budget knapp.').closest('.comment')).not.toHaveTextContent('für Externe sichtbar');
    fireEvent.click(screen.getByRole('button', { name: 'für Externe freigeben' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t1/comments/k2', { visibility: 'external' }));
    fireEvent.click(screen.getByRole('button', { name: 'nur intern' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t1/comments/k1', { visibility: 'internal' }));
  });

  it('Kommentieren mit Häkchen „für Externe sichtbar“ schickt visibility external', async () => {
    renderDrawer();
    fireEvent.change(await screen.findByPlaceholderText(/Kommentar …/), { target: { value: 'Lieferfenster KW 47' } });
    fireEvent.click(screen.getByLabelText('für Externe sichtbar'));
    fireEvent.click(screen.getByRole('button', { name: 'Kommentieren' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t1/comments', { body: 'Lieferfenster KW 47', visibility: 'external' }));
  });

  it('Außenbeschreibung: mit „Projektplan ändern“ bearbeitbar, sonst nur lesend', async () => {
    renderDrawer();
    const view = (await screen.findByText('Lieferung und Verlegung im Bad')).closest('.desc-view')!;
    expect(view).toHaveTextContent('Außenbeschreibung (für Externe) · klicken zum Bearbeiten');
    fireEvent.click(view);
    const area = screen.getByLabelText(/Außenbeschreibung \(für Externe\)/);
    fireEvent.change(area, { target: { value: 'Lieferung im Bad, Termin nach Absprache' } });
    fireEvent.blur(area);
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t1', { externalBrief: 'Lieferung im Bad, Termin nach Absprache' }));
  });

  it('ohne Planrecht: Außenbeschreibung nicht bearbeitbar, fremde Einträge nicht umschaltbar', async () => {
    membership = { role: 'member', canEditPlan: false, userId: 'u3' };
    renderDrawer();
    const view = (await screen.findByText('Lieferung und Verlegung im Bad')).closest('.desc-view')!;
    expect(view).not.toHaveTextContent('klicken zum Bearbeiten');
    fireEvent.click(view);
    expect(screen.queryByLabelText(/Außenbeschreibung \(für Externe\)/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'für Externe freigeben' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('für Externe sichtbar')).toBeInTheDocument();
  });
});

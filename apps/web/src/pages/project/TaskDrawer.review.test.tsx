import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-10-18' }));
let membership = { role: 'pl', canEditPlan: true, userId: 'u1' };
const openSubproject = vi.fn();
vi.mock('../ProjectPage', () => ({
  useProject: () => ({
    detail: { project: { id: 'p1', key: 'WEB', myMembership: membership, mailAddress: null, timeTrackingEnabled: false }, columns: [{ id: 'c1', name: 'Offen', kind: 'active', isDone: false }, { id: 'c4', name: 'In Prüfung', kind: 'review', isDone: false }], subprojects: [{ id: 's1', name: 'Bad', responsible: {} }], members: [{ userId: 'u1', name: 'Petra Lenz', role: 'pl' }, { userId: 'u2', name: 'Max Keller', role: 'member' }], labels: [], milestones: [{ id: 'm1', name: 'Rohbau fertig', date: '2026-11-30', reachedAt: null }, { id: 'm2', name: 'Übergabe', date: '2026-12-20', reachedAt: '2026-12-19T10:00:00Z' }] },
    users: [], tasks: [], reloadTasks: vi.fn(async () => undefined), openTask: vi.fn(), openSubproject, ai: null
  }),
  useProjectOptional: () => null
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ timeTracking: false }) }));
vi.mock('../../lib/useData', () => ({ useData: () => ({ data: null, error: null, loading: false, reload: async () => undefined }) }));
vi.mock('../../lib/useContacts', () => ({ useContacts: () => ({ contacts: [] }), contactLabel: (c: { email: string }) => c.email }));
vi.mock('../../lib/useAi', () => ({ aiBlocked: () => undefined, assistChoice: () => ({ fit: [], def: null }) }));
vi.mock('./BoardView', () => ({ LabelPicker: () => null }));
vi.mock('./CopyMove', () => ({ CopyMoveDialog: () => null }));
vi.mock('./TimeView', () => ({ fmtH: (m: number) => String(m) }));
vi.mock('../../components/QuickMail', () => ({ QuickMail: () => null }));
import { TaskDrawer } from './TaskDrawer';

const task = {
  id: 't1', number: 9, title: 'Fliesen koordinieren', done: false, parentId: null, parent: null, archivedAt: null, deletedAt: null, responsibleUserId: null, responsibleEmail: null,
  responsible: { userId: null, name: 'Petra Lenz', email: null, inherited: true, inheritedFrom: 'pl' }, blocked: false, blockedReason: null, escalationLevel: 0, conflicts: [], columnId: 'c4', subprojectId: 's1', reviewer: { userId: 'u2', name: 'Max Keller' }, milestoneIds: ['m1'],
  priority: 'normal', labelIds: [], startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, mailCode: 'abc', description: 'Intern: Budget 8.000 EUR', externalBrief: 'Lieferung und Verlegung im Bad',
  recurrence: null, checklistTotal: 0, checklistDone: 0, checklist: [], subtaskTotal: 0, subtaskDone: 0, agentPaused: false, agentWait: null, agentNextCheckAt: null
};
const renderDrawer = () => render(<MemoryRouter><TaskDrawer taskId="t1" onClose={() => undefined} /></MemoryRouter>);

describe('TaskDrawer: Brotkrumen, Prüfung und Meilensteine', () => {
  beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); openSubproject.mockReset();
    get.mockResolvedValue({ task, subtasks: [], comments: [], mails: [], attachments: [] });
    post.mockResolvedValue({}); patch.mockResolvedValue({});
    membership = { role: 'pl', canEditPlan: true, userId: 'u1' };
  });

  it('Kopf: Projekt › Teilprojekt › Arbeitspaket, klickbar', async () => {
    renderDrawer();
    const nav = await screen.findByRole('navigation', { name: 'Brotkrumen' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Bad' }));
    expect(openSubproject).toHaveBeenCalledWith('s1');
    expect(within(nav).getByText('WEB-9 Fliesen koordinieren')).toHaveAttribute('aria-current', 'page');
  });

  it('In Prüfung: Prüfer sichtbar und änderbar, Freigeben und Zurückweisen mit Kommentar', async () => {
    renderDrawer();
    const box = await screen.findByRole('region', { name: 'Prüfung' });
    expect(box).toHaveTextContent('In Prüfung bei Max Keller');
    fireEvent.change(within(box).getByLabelText('Prüfende Person'), { target: { value: 'u1' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t1', { reviewerUserId: 'u1' }));
    fireEvent.click(within(box).getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t1/review', { decision: 'approve', comment: undefined }));
    fireEvent.click(within(box).getByRole('button', { name: 'Zurückweisen …' }));
    const dlg = await screen.findByRole('dialog', { name: 'Prüfung zurückweisen' });
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: 'Fugen fehlen' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Zurückweisen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t1/review', { decision: 'reject', comment: 'Fugen fehlen' }));
  });

  it('Mitglied, das nicht prüft: keine Entscheidungsknöpfe', async () => {
    membership = { role: 'member', canEditPlan: false, userId: 'u9' };
    renderDrawer();
    const box = await screen.findByRole('region', { name: 'Prüfung' });
    expect(within(box).queryByRole('button', { name: 'Freigeben' })).toBeNull();
  });

  it('Einstellungen: Feld „Meilenstein“ (Mehrfach) sendet milestoneIds', async () => {
    renderDrawer();
    const box = await screen.findByLabelText(/Übergabe/);
    expect(screen.getByLabelText(/Rohbau fertig/)).toBeChecked();
    expect(box.closest('label')).toHaveTextContent('erreicht');
    fireEvent.click(box);
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t1', { milestoneIds: ['m1', 'm2'] }));
  });
});

import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: (...a: unknown[]) => del(...a) }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-11-06' }));
const base = { done: false, parentId: null, parent: null, archivedAt: null, deletedAt: null, responsibleUserId: null, responsibleEmail: null, responsible: { userId: null, name: 'Petra Lenz', email: null, inherited: true, inheritedFrom: 'pl' }, blocked: false, blockedReason: null, escalationLevel: 0, conflicts: [], columnId: 'c1', subprojectId: null, priority: 'normal', labelIds: [], startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, mailCode: 'abc', description: '', externalBrief: null, recurrence: null, checklistTotal: 0, checklistDone: 0, checklist: [], subtaskTotal: 0, subtaskDone: 0, agentPaused: false, agentWait: null, agentNextCheckAt: null, position: 0, autoComplete: null, autoDoneAt: null };
const item = (id: string, taskId: string, title: string, done = false) => ({ id, taskId, title, done, responsibleUserId: null, responsibleEmail: null, position: 0 });
const legacy = { ...base, id: 't1', number: 9, title: 'Fliesen koordinieren', checklistTotal: 2, checklistDone: 1, checklist: [item('i1', 't1', 'Maße prüfen', true), item('i2', 't1', 'Fliesen bestellen')] };
const ap = { ...base, id: 't1', number: 9, title: 'Fliesen koordinieren', subtaskTotal: 2 };
const parent = { id: 't1', number: 9, title: 'Fliesen koordinieren' };
const aufgabe = { ...base, id: 't3', number: 13, title: 'Fugen', parentId: 't1', parent, checklistTotal: 2, checklistDone: 1, checklist: [item('j1', 't3', 'Fugenmasse kaufen', true), item('j2', 't3', 'Verfugen')] };
const aufgabeDone = { ...aufgabe, done: true, columnId: 'c9', checklistDone: 2, checklist: [item('j1', 't3', 'Fugenmasse kaufen', true), item('j2', 't3', 'Verfugen', true)], autoDoneAt: '2026-11-06T10:00:00Z' };
const silikon = { ...base, id: 't5', number: 15, title: 'Silikon', parentId: 't1', parent };
let tasks: unknown[] = [];
const reloadTasks = vi.fn(async () => undefined);
const openTask = vi.fn();
vi.mock('../ProjectPage', () => ({
  useProject: () => ({
    detail: { project: { id: 'p1', key: 'WEB', myMembership: { role: 'pl', canEditPlan: true, userId: 'u1' }, mailAddress: null, timeTrackingEnabled: false, autoCompleteParent: true, autoDoneAufgabe: true }, columns: [{ id: 'c1', name: 'Offen', kind: 'active', isDone: false }, { id: 'c9', name: 'Erledigt', kind: 'done', isDone: true }], subprojects: [], members: [{ userId: 'u1', name: 'Petra Lenz' }], labels: [] },
    users: [], tasks, reloadTasks, openTask, ai: null
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
import { DialogProvider, ToastProvider } from '../../components/ui';

const renderDrawer = (id = 't1') => render(<MemoryRouter><ToastProvider><DialogProvider><TaskDrawer taskId={id} onClose={() => undefined} /></DialogProvider></ToastProvider></MemoryRouter>);
const detailOf = (task: unknown, subtasks: unknown[] = []) => ({ task, subtasks, comments: [], mails: [], attachments: [] });

describe('Aufgabe und Checklistenpunkt: unterscheidbar, Punkte überall bedienbar', () => {
  beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); reloadTasks.mockClear(); openTask.mockReset();
    tasks = [ap, aufgabe];
    get.mockImplementation(async (url: string) => (url === '/tasks/t3' ? detailOf(aufgabe) : detailOf(ap, [aufgabe])));
  });

  const expand = async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Fugen', expanded: false }));
    return screen.findByLabelText('Titel des Checklistenpunkts „Verfugen“');
  };

  it('Aufgaben-Zeile: Kennung und runder Status-Knopf; Checklistenpunkt: eckige Checkbox ohne Kennung', async () => {
    await expand();
    const row = document.querySelector('ul.subtasks > li .st-row') as HTMLElement;
    expect(within(row).getByText('WEB-13')).toHaveClass('task-key');
    const status = within(row).getByRole('button', { name: '„Fugen“ als erledigt markieren' });
    expect(status).toHaveClass('task-status-btn');
    expect(within(row).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Aufgaben/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Checkliste/ })).toHaveTextContent('1/2');
    const li = screen.getByLabelText('„Verfugen“ erledigt').closest('li') as HTMLElement;
    expect(within(li).getByRole('checkbox')).toHaveClass('cl-check');
    expect(within(li).queryByText(/WEB-/)).not.toBeInTheDocument();
    expect(li.querySelector('.task-status-btn')).toBeNull();
  });

  it('Klick auf den runden Knopf setzt die Aufgabe auf Erledigt', async () => {
    post.mockResolvedValue({});
    await expand();
    fireEvent.click(screen.getByRole('button', { name: '„Fugen“ als erledigt markieren' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t3/move', expect.objectContaining({ columnId: 'c9' })));
  });

  it('Aufgeklappte Aufgabe: Checklistenpunkt umbenennen sendet PATCH title', async () => {
    patch.mockResolvedValue({ task: aufgabe });
    const input = await expand();
    fireEvent.change(input, { target: { value: 'Verfugen und säubern' } });
    fireEvent.blur(input);
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t3/checklist/j2', { title: 'Verfugen und säubern' }));
    await waitFor(() => expect(reloadTasks).toHaveBeenCalled());
  });

  it('Aufgeklappte Aufgabe: Checklistenpunkt über das Menü löschen (Rückfrage → DELETE)', async () => {
    del.mockResolvedValue({ task: aufgabe });
    await expand();
    fireEvent.click(screen.getByRole('button', { name: 'Menü zu „Verfugen“' }));
    expect(screen.getByRole('menuitem', { name: 'In Aufgabe umwandeln …' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'In andere Aufgabe verschieben …' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Löschen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Checklistenpunkt löschen' });
    expect(dlg).toHaveTextContent('„Verfugen“ löschen?');
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Löschen' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/tasks/t3/checklist/j2'));
  });

  it('Rücktaste im geleerten Titel fragt nach dem Löschen; Abbrechen löscht nichts', async () => {
    const input = await expand();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    const dlg = await screen.findByRole('dialog', { name: 'Checklistenpunkt löschen' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Checklistenpunkt löschen' })).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});

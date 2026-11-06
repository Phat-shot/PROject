import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-11-06' }));
const base = { done: false, parentId: null, parent: null, archivedAt: null, deletedAt: null, responsibleUserId: null, responsibleEmail: null, responsible: { userId: null, name: 'Petra Lenz', email: null, inherited: true, inheritedFrom: 'pl' }, blocked: false, blockedReason: null, escalationLevel: 0, conflicts: [], columnId: 'c1', subprojectId: null, priority: 'normal', labelIds: [], startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, mailCode: 'abc', description: '', externalBrief: null, recurrence: null, checklistTotal: 0, checklistDone: 0, checklist: [], subtaskTotal: 0, subtaskDone: 0, agentPaused: false, agentWait: null, agentNextCheckAt: null, position: 0 };
const ap = { ...base, id: 't1', number: 9, title: 'Fliesen koordinieren', checklistTotal: 1, checklist: [{ id: 'i1', taskId: 't1', title: 'Maße prüfen', done: false, responsibleUserId: null, responsibleEmail: null, position: 0 }] };
const other = { ...base, id: 't2', number: 12, title: 'Bad fertigstellen', subprojectId: 's1' };
const sub = { ...base, id: 't3', number: 13, title: 'Fugen', parentId: 't1', parent: { id: 't1', number: 9, title: 'Fliesen koordinieren' } };
const reloadTasks = vi.fn(async () => undefined);
vi.mock('../ProjectPage', () => ({
  useProject: () => ({
    detail: { project: { id: 'p1', key: 'WEB', myMembership: { role: 'pl', canEditPlan: true, userId: 'u1' }, mailAddress: null, timeTrackingEnabled: false }, columns: [{ id: 'c1', name: 'Offen', kind: 'active', isDone: false }], subprojects: [{ id: 's1', name: 'Sanitär', restricted: false }], members: [{ userId: 'u1', name: 'Petra Lenz' }], labels: [] },
    users: [], tasks: [ap, other, sub], reloadTasks, openTask: vi.fn(), ai: null
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

const renderDrawer = () => render(<MemoryRouter><TaskDrawer taskId="t1" onClose={() => undefined} /></MemoryRouter>);

describe('TaskDrawer: Verschieben und Umwandeln', () => {
  beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset();
    get.mockResolvedValue({ task: ap, subtasks: [sub], comments: [], mails: [], attachments: [] });
    post.mockResolvedValue({ task: ap });
  });

  it('Arbeitspaket: „Verschieben …“ bietet Teilprojekt ändern; der Dialog sendet reparent mit Teilprojekt', async () => {
    renderDrawer();
    await screen.findByText('Fliesen koordinieren');
    fireEvent.click(screen.getByRole('button', { name: 'Verschieben …' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Teilprojekt ändern …' }));
    const select = await screen.findByLabelText('Ziel-Teilprojekt');
    fireEvent.change(select, { target: { value: 's1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zuordnen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t1/reparent', { parentId: null, subprojectId: 's1' }));
    await waitFor(() => expect(reloadTasks).toHaveBeenCalled());
  });

  it('Checklistenpunkt: Menü mit Umwandeln, Verschieben und Löschen; Verschieben sucht das Ziel per Kennung', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Menü zu „Maße prüfen“' }));
    expect(screen.getByRole('menuitem', { name: 'In Aufgabe umwandeln …' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Löschen' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Verschieben nach …' }));
    const search = await screen.findByLabelText('Ziel (Arbeitspaket oder Aufgabe) suchen');
    fireEvent.change(search, { target: { value: 'web-12' } });
    expect(document.querySelectorAll('.picker-list label')).toHaveLength(1);
    expect(document.querySelector('.picker-list label')).toHaveTextContent('Bad fertigstellen');
    fireEvent.click(document.querySelector('.picker-list input')!);
    fireEvent.click(screen.getByRole('button', { name: 'Verschieben' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t1/checklist/i1/move', { toTaskId: 't2' }));
  });

  it('Checklistenpunkt in Aufgabe umwandeln: Titel, Termin, Zuständigkeit gehen an promote', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Menü zu „Maße prüfen“' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'In Aufgabe umwandeln …' }));
    fireEvent.change(await screen.findByLabelText('Deadline der Aufgabe'), { target: { value: '2026-11-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aufgabe anlegen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t1/checklist/i1/promote', { title: 'Maße prüfen', dueDate: '2026-11-20', responsibleUserId: null }));
  });

  it('Aufgaben im Arbeitspaket sind ziehbar und tragen ihre Kennung im Drag-Datensatz', async () => {
    renderDrawer();
    await screen.findByText('Fliesen koordinieren');
    const row = document.querySelector('ul.subtasks li')!;
    expect(row).toHaveAttribute('draggable', 'true');
    const data: Record<string, string> = {};
    fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: '' } });
    expect(data['application/x-projekttool-subtask']).toBe('t3');
  });
});

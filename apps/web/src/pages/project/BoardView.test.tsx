import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const openTask = vi.fn();
const reloadTasks = vi.fn(async () => undefined);
const task = {
  id: 't1', number: 7, title: 'Angebot prüfen', done: false, parentId: null, columnId: 'c1', subprojectId: null, position: 1, priority: 'normal', labelIds: [],
  responsible: { userId: 'u1', name: 'Petra Lenz', email: null, inherited: false }, blocked: false, escalationLevel: 0, conflicts: [], dueDate: null, startDate: null,
  checklistTotal: 0, checklistDone: 0, subtaskTotal: 0, subtaskDone: 0, commentCount: 0, wait: null, recurrence: null, archivedAt: null, deletedAt: null
};
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(async () => ({ tasks: [] })), post: vi.fn(), patch: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, downloadCsv: vi.fn(), fmtDate: (d: string) => d, today: () => '2026-11-06' }));
vi.mock('../ProjectPage', () => ({
  useProject: () => ({
    detail: { project: { id: 'p1', key: 'WEB', myMembership: { role: 'pl', canEditPlan: true, userId: 'u1' } }, columns: [{ id: 'c1', name: 'Offen', kind: 'active', isDone: false }, { id: 'c2', name: 'Erledigt', kind: 'done', isDone: true }], subprojects: [], members: [{ userId: 'u1', name: 'Petra Lenz' }], labels: [] },
    tasks: [task], reloadTasks, openTask, openSubproject: vi.fn(), users: [], reload: vi.fn(), ai: null
  })
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('../../lib/useMedia', () => ({ useIsMobile: () => false }));
vi.mock('../../lib/useData', () => ({ useData: () => ({ data: null, error: null, loading: false, reload: async () => undefined }) }));
vi.mock('./create', () => ({ useCreate: () => ({ task: vi.fn(), subproject: vi.fn(), milestone: vi.fn() }) }));
vi.mock('./WorkflowsView', () => ({ StartRunDialog: () => null }));
import { BoardView } from './BoardView';

describe('Board: Karten per Tastatur', () => {
  beforeEach(() => { openTask.mockReset(); });

  it('Karte ist fokussierbar (role=button) und öffnet mit Enter und Leertaste', () => {
    render(<MemoryRouter><BoardView /></MemoryRouter>);
    const card = screen.getByRole('button', { name: 'WEB-7 Angebot prüfen öffnen' });
    expect(card).toHaveAttribute('tabindex', '0');
    card.focus();
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(openTask).toHaveBeenCalledWith('t1');
    fireEvent.keyDown(card, { key: ' ' });
    expect(openTask).toHaveBeenCalledTimes(2);
  });

  it('Kürzel q greift nicht, wenn der Fokus in einem Eingabefeld liegt', () => {
    render(<MemoryRouter><BoardView /></MemoryRouter>);
    const input = screen.getByLabelText('Filtern (Taste f)');
    input.focus();
    fireEvent.keyDown(input, { key: 'q' });
    expect(screen.getByRole('button', { name: /Nur meine/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(document.body, { key: 'q' });
    expect(screen.getByRole('button', { name: /Nur meine/ })).toHaveAttribute('aria-pressed', 'true');
  });
});

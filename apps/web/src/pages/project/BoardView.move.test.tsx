import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const post = vi.fn();
const reloadTasks = vi.fn(async () => undefined);
const base = { done: false, parentId: null, columnId: 'c1', subprojectId: null, position: 1, priority: 'normal', labelIds: [], responsible: { userId: 'u1', name: 'Petra Lenz', email: null, inherited: false }, blocked: false, escalationLevel: 0, conflicts: [], dueDate: null, startDate: null, checklistTotal: 0, checklistDone: 0, subtaskTotal: 0, subtaskDone: 0, commentCount: 0, wait: null, recurrence: null, archivedAt: null, deletedAt: null };
const ap1 = { ...base, id: 't1', number: 7, title: 'Angebot prüfen', subtaskTotal: 1 };
const ap2 = { ...base, id: 't2', number: 8, title: 'Vertrag vorbereiten', position: 2 };
const sub = { ...base, id: 't3', number: 9, title: 'Preise vergleichen', parentId: 't1' };
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(async () => ({ tasks: [] })), post: (...a: unknown[]) => post(...a), patch: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, downloadCsv: vi.fn(), fmtDate: (d: string) => d, today: () => '2026-11-06' }));
vi.mock('../ProjectPage', () => ({
  useProject: () => ({
    detail: { project: { id: 'p1', key: 'WEB', myMembership: { role: 'pl', canEditPlan: true, userId: 'u1' } }, columns: [{ id: 'c1', name: 'Offen', kind: 'active', isDone: false }, { id: 'c2', name: 'Erledigt', kind: 'done', isDone: true }], subprojects: [], members: [{ userId: 'u1', name: 'Petra Lenz' }], labels: [] },
    tasks: [ap1, ap2, sub], reloadTasks, openTask: vi.fn(), openSubproject: vi.fn(), users: [], reload: vi.fn(), ai: null
  })
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('../../lib/useMedia', () => ({ useIsMobile: () => false }));
vi.mock('../../lib/useData', () => ({ useData: () => ({ data: null, error: null, loading: false, reload: async () => undefined }) }));
vi.mock('./create', () => ({ useCreate: () => ({ task: vi.fn(), subproject: vi.fn(), milestone: vi.fn() }) }));
vi.mock('./WorkflowsView', () => ({ StartRunDialog: () => null }));
import { BoardView } from './BoardView';
import { SUBTASK_DRAG } from './MoveDialog';

const dt = (id: string) => ({ types: [SUBTASK_DRAG], getData: (k: string) => (k === SUBTASK_DRAG ? id : ''), setData: vi.fn(), dropEffect: '', effectAllowed: '' });

describe('Board: Aufgabe auf ein anderes Arbeitspaket ziehen', () => {
  beforeEach(() => { post.mockReset(); post.mockResolvedValue({ task: sub }); reloadTasks.mockClear(); });

  it('Drop einer Aufgabe auf eine AP-Karte hängt sie um (reparent) und lädt das Board neu', async () => {
    render(<MemoryRouter><BoardView /></MemoryRouter>);
    const target = screen.getByRole('button', { name: 'WEB-8 Vertrag vorbereiten öffnen' });
    fireEvent.dragOver(target, { dataTransfer: dt('t3') });
    expect(target).toHaveClass('drop-sub');
    fireEvent.drop(target, { dataTransfer: dt('t3') });
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t3/reparent', { parentId: 't2' }));
    await waitFor(() => expect(reloadTasks).toHaveBeenCalled());
  });

  it('Drop auf das eigene Arbeitspaket tut nichts; Zeile der Aufgabe in der Karte ist ziehbar', () => {
    render(<MemoryRouter><BoardView /></MemoryRouter>);
    const own = screen.getByRole('button', { name: 'WEB-7 Angebot prüfen öffnen' });
    fireEvent.drop(own, { dataTransfer: dt('t3') });
    expect(post).not.toHaveBeenCalled();
    const row = screen.getByText('Preise vergleichen').closest('li')!;
    expect(row).toHaveAttribute('draggable', 'true');
  });
});

import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const post = vi.fn();
const reloadTasks = vi.fn(async () => undefined);
const base = { done: false, parentId: null, columnId: 'c1', subprojectId: null, position: 1, priority: 'normal', labelIds: [], responsible: { userId: 'u1', name: 'Petra Lenz', email: null, inherited: false }, blocked: false, escalationLevel: 0, conflicts: [], dueDate: null, startDate: null, checklistTotal: 0, checklistDone: 0, subtaskTotal: 0, subtaskDone: 0, commentCount: 0, wait: null, recurrence: null, archivedAt: null, deletedAt: null };
const geplant = { ...base, id: 't1', number: 7, title: 'Angebot prüfen', columnId: 'c1' };
const offen = { ...base, id: 't2', number: 8, title: 'Vertrag vorbereiten', columnId: 'c2' };
const ruht = { ...base, id: 't3', number: 9, title: 'Logo abstimmen', columnId: 'c4' };
// Geplant (backlog), Wartet (waiting) und Zurückgestellt (parked) in der Gruppe „Nicht in Arbeit“; Wartet steht hinter den aktiven Spalten
const columns = [
  { id: 'c1', name: 'Geplant', kind: 'backlog', isDone: false, position: 0, wipLimit: null, group: 'Nicht in Arbeit' },
  { id: 'c2', name: 'In Arbeit', kind: 'active', isDone: false, position: 1, wipLimit: null, group: null },
  { id: 'c3', name: 'Wartet', kind: 'waiting', isDone: false, position: 2, wipLimit: null, group: 'Nicht in Arbeit' },
  { id: 'c4', name: 'Zurückgestellt', kind: 'parked', isDone: false, position: 3, wipLimit: null, group: 'Nicht in Arbeit' },
  { id: 'c5', name: 'Erledigt', kind: 'done', isDone: true, position: 4, wipLimit: null, group: null }
];
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(async () => ({ tasks: [] })), post: (...a: unknown[]) => post(...a), patch: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, downloadCsv: vi.fn(), fmtDate: (d: string) => d, today: () => '2026-11-06' }));
vi.mock('../ProjectPage', () => ({
  useProject: () => ({
    detail: { project: { id: 'p1', key: 'WEB', myMembership: { role: 'pl', canEditPlan: true, userId: 'u1' } }, columns, subprojects: [], members: [{ userId: 'u1', name: 'Petra Lenz' }], labels: [] },
    tasks: [geplant, offen, ruht], reloadTasks, openTask: vi.fn(), openSubproject: vi.fn(), users: [], reload: vi.fn(), ai: null
  })
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('../../lib/useMedia', () => ({ useIsMobile: () => false }));
vi.mock('../../lib/useData', () => ({ useData: () => ({ data: null, error: null, loading: false, reload: async () => undefined }) }));
vi.mock('./create', () => ({ useCreate: () => ({ task: vi.fn(), subproject: vi.fn(), milestone: vi.fn() }) }));
vi.mock('./WorkflowsView', () => ({ StartRunDialog: () => null }));
import { BoardView } from './BoardView';

const dt = () => ({ types: ['text/plain'], getData: () => '', setData: vi.fn(), dropEffect: '', effectAllowed: '' });

describe('Board: Spaltengruppen', () => {
  beforeEach(() => { post.mockReset(); post.mockResolvedValue({ task: geplant }); reloadTasks.mockClear(); localStorage.clear(); });

  it('Gruppe „Nicht in Arbeit“ ist eine Board-Spalte mit drei Abschnitten an der Position der vordersten Spalte; Gesamtzahl im Kopf, leerer Abschnitt zeigt „–“', () => {
    render(<MemoryRouter><BoardView /></MemoryRouter>);
    const group = screen.getByRole('group', { name: 'Spaltengruppe Nicht in Arbeit' });
    expect(group).toHaveClass('column', 'group');
    const sections = within(group).getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['Abschnitt Geplant', 'Abschnitt Wartet', 'Abschnitt Zurückgestellt']);
    expect(within(group).getByText('Angebot prüfen')).toBeInTheDocument();
    expect(within(group).getByText('Logo abstimmen')).toBeInTheDocument();
    expect(within(sections[1]).getByLabelText('leer')).toHaveTextContent('–');
    // Gruppe steht vor „In Arbeit“; insgesamt drei Board-Spalten
    const board = group.parentElement!;
    const cols = Array.from(board.children).map((c) => c.getAttribute('aria-label') ?? c.querySelector('h3 > span')?.textContent);
    expect(cols).toEqual(['Spaltengruppe Nicht in Arbeit', 'In Arbeit', 'Erledigt']);
    // Kopf zählt alle Arbeitspakete der Gruppe (2 von 3 insgesamt)
    expect(within(group).getByTitle('2 in dieser Zeile, 2 gesamt')).toHaveTextContent('2');
    // Schnellanlage je Abschnitt außer Wartet
    expect(within(sections[0]).getByRole('button', { name: '+ Arbeitspaket' })).toBeInTheDocument();
    expect(within(sections[1]).queryByRole('button', { name: '+ Arbeitspaket' })).toBeNull();
    expect(within(sections[2]).getByRole('button', { name: '+ Arbeitspaket' })).toBeInTheDocument();
  });

  it('Drop auf einen Abschnitt verschiebt in die Spalte dieses Abschnitts (Zurückgestellt), nicht in die erste der Gruppe', async () => {
    render(<MemoryRouter><BoardView /></MemoryRouter>);
    const card = screen.getByRole('button', { name: 'WEB-8 Vertrag vorbereiten öffnen' });
    fireEvent.dragStart(card, { dataTransfer: dt() });
    const target = screen.getByRole('region', { name: 'Abschnitt Zurückgestellt' });
    fireEvent.dragOver(target, { dataTransfer: dt() });
    expect(target).toHaveClass('over');
    expect(screen.getByRole('group', { name: 'Spaltengruppe Nicht in Arbeit' })).not.toHaveClass('over');
    fireEvent.drop(target, { dataTransfer: dt() });
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t2/move', { columnId: 'c4', index: 1 }));
    await waitFor(() => expect(reloadTasks).toHaveBeenCalled());
  });

  it('Abschnitt einklappen (Tastatur-Button, Zustand je Spalte gemerkt) und ganze Gruppe einklappen zeigt nur die Gesamtzahl', () => {
    const { unmount } = render(<MemoryRouter><BoardView /></MemoryRouter>);
    const toggle = screen.getByRole('button', { name: 'Abschnitt Geplant einklappen (1)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(screen.queryByText('Angebot prüfen')).toBeNull();
    expect(screen.getByRole('button', { name: 'Abschnitt Geplant ausklappen (1)' })).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(localStorage.getItem('pt_cols_p1')!)).toEqual(['c1']);
    unmount();
    render(<MemoryRouter><BoardView /></MemoryRouter>);
    expect(screen.queryByText('Angebot prüfen')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Gruppe Nicht in Arbeit einklappen' }));
    const group = screen.getByRole('group', { name: 'Spaltengruppe Nicht in Arbeit' });
    expect(group).toHaveClass('collapsed');
    expect(within(group).queryAllByRole('region')).toHaveLength(0);
    expect(within(group).getByRole('button', { name: 'Gruppe Nicht in Arbeit ausklappen (2)' })).toHaveTextContent('2');
    fireEvent.click(within(group).getByRole('button', { name: 'Gruppe Nicht in Arbeit ausklappen (2)' }));
    expect(screen.getByText('Logo abstimmen')).toBeInTheDocument();
  });
});

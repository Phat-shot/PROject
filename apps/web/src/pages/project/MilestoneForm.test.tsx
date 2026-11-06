import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Milestone, Task } from '@projekttool/shared';

const patch = vi.fn(async () => ({}));
const reload = vi.fn(async () => undefined);
const task = (id: string, number: number, title: string, done = false): Partial<Task> => ({ id, number, title, done, parentId: null, deletedAt: null, archivedAt: null, dueDate: null });
let milestones: Milestone[] = [];
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: (...a: unknown[]) => (patch as any)(...a), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d }));
vi.mock('../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', key: 'WEB', myMembership: { role: 'pl', canEditPlan: true }, milestoneAutoReach: false }, columns: [], labels: [], members: [], subprojects: [], milestones }, users: [], reload, tasks: [task('t1', 1, 'Design abnehmen', true), task('t2', 2, 'Texte liefern'), task('t3', 3, 'Hosting')], reloadTasks: vi.fn(async () => undefined), openSubproject: vi.fn(), ai: null }), useProjectOptional: () => null }));
vi.mock('./TaskDrawer', () => ({ InlineText: ({ value }: { value: string }) => <span>{value}</span> }));
vi.mock('./BoardView', () => ({ InlineCreate: () => null }));
import { MilestoneForm, MilestoneList } from './planForms';
import { DialogProvider } from '../../components/ui';

const ms = (o: Partial<Milestone> = {}): Milestone => ({ id: 'm1', projectId: 'p1', subprojectId: null, name: 'Go-Live', date: '2026-12-01', reachedAt: null, reachedBy: null, reachSuggestedAt: null, taskIds: ['t1'], tasksDone: 1, tasksTotal: 1, ...o });
const wrap = (el: JSX.Element) => render(<MemoryRouter><DialogProvider>{el}</DialogProvider></MemoryRouter>);

describe('Meilensteine: Status und Arbeitspakete', () => {
  beforeEach(() => { patch.mockClear(); reload.mockClear(); milestones = [ms()]; });

  it('Formular: AP-Suche nach Titel oder Kennung, Auswahl und Status speichern', async () => {
    wrap(<MilestoneForm milestone={ms()} onClose={() => undefined} />);
    const dlg = screen.getByRole('dialog', { name: 'Meilenstein: Go-Live' });
    expect(within(dlg).getByLabelText(/Design abnehmen/)).toBeChecked();
    fireEvent.change(within(dlg).getByLabelText('Arbeitspakete suchen'), { target: { value: 'WEB-3' } });
    expect(within(dlg).queryByText('Texte liefern')).toBeNull();
    fireEvent.click(within(dlg).getByLabelText(/Hosting/));
    fireEvent.click(within(dlg).getByLabelText('erreicht'));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1/milestones/m1', expect.objectContaining({ taskIds: ['t1', 't3'], reached: true })));
  });

  it('Liste: alle verknüpften APs erledigt → „Erreicht bestätigen“; erreicht → Datum und „wieder öffnen“', async () => {
    milestones = [ms({ reachSuggestedAt: '2026-11-06T10:00:00Z' }), ms({ id: 'm2', name: 'Abnahme', reachedAt: '2026-11-05T09:00:00Z', reachedBy: { userId: 'u1', name: 'Petra Lenz' } })];
    wrap(<MilestoneList />);
    fireEvent.click(screen.getByRole('button', { name: 'Erreicht bestätigen' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1/milestones/m1', { reached: true }));
    expect(screen.getByText('erreicht 2026-11-05')).toHaveAttribute('title', expect.stringContaining('Petra Lenz'));
    fireEvent.click(screen.getByRole('button', { name: 'wieder öffnen' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1/milestones/m2', { reached: false }));
  });
});

import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const put = vi.fn();
const reload = vi.fn(async () => undefined);
const columns = [
  { id: 'c1', name: 'Geplant', kind: 'backlog', isDone: false, position: 0, wipLimit: null, group: null },
  { id: 'c2', name: 'In Arbeit', kind: 'active', isDone: false, position: 1, wipLimit: 3, group: null },
  { id: 'c3', name: 'Wartet', kind: 'waiting', isDone: false, position: 2, wipLimit: null, group: null },
  { id: 'c4', name: 'Zurückgestellt', kind: 'parked', isDone: false, position: 3, wipLimit: null, group: 'Später' },
  { id: 'c5', name: 'Erledigt', kind: 'done', isDone: true, position: 4, wipLimit: null, group: null }
];
vi.mock('../../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: (...a: unknown[]) => put(...a), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, today: () => '2026-11-06' }));
vi.mock('../../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', myMembership: { role: 'pl' } }, columns, labels: [], members: [], subprojects: [], milestones: [] }, users: [], reload, tasks: [], reloadTasks: vi.fn(async () => undefined), ai: null }), useProjectOptional: () => null }));
import { ColumnsForm } from './Planning';

describe('Projekteinstellungen › Spalten: Spaltengruppen', () => {
  beforeEach(() => { put.mockReset(); put.mockResolvedValue({ columns }); reload.mockClear(); });

  it('Knopf setzt bei Geplant, Wartet und Zurückgestellt die Gruppe „Nicht in Arbeit“ und speichert sie mit; Datalist kennt vorhandene Gruppen', async () => {
    render(<MemoryRouter><ColumnsForm onClose={() => undefined} /></MemoryRouter>);
    expect(screen.getByLabelText('Gruppe der Spalte Zurückgestellt')).toHaveValue('Später');
    expect(Array.from(document.querySelectorAll('datalist#column-groups option')).map((o) => (o as HTMLOptionElement).value)).toEqual(['Später']);
    const btn = screen.getByRole('button', { name: 'Geplant, Wartet und Zurückgestellt zu „Nicht in Arbeit“ zusammenfassen' });
    fireEvent.click(btn);
    expect(screen.getByLabelText('Gruppe der Spalte Geplant')).toHaveValue('Nicht in Arbeit');
    expect(screen.getByLabelText('Gruppe der Spalte Wartet')).toHaveValue('Nicht in Arbeit');
    expect(screen.getByLabelText('Gruppe der Spalte Zurückgestellt')).toHaveValue('Nicht in Arbeit');
    expect(screen.getByLabelText('Gruppe der Spalte In Arbeit')).toHaveValue('');
    expect(btn).toBeDisabled();
    // Gruppenfeld je Spalte frei änderbar
    fireEvent.change(screen.getByLabelText('Gruppe der Spalte In Arbeit'), { target: { value: 'Arbeit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][0]).toBe('/projects/p1/columns');
    expect(put.mock.calls[0][1].columns.map((c: { group: string | null }) => c.group)).toEqual(['Nicht in Arbeit', 'Arbeit', 'Nicht in Arbeit', 'Nicht in Arbeit', null]);
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});

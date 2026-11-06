import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const patch = vi.fn();
const reload = vi.fn(async () => undefined);
let project: Record<string, unknown> = {};
vi.mock('../../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-11-06' }));
vi.mock('../../ProjectPage', () => ({ useProject: () => ({ detail: { project, columns: [], labels: [], members: [], subprojects: [], milestones: [] }, users: [], reload, tasks: [], reloadTasks: vi.fn(async () => undefined), ai: null }), useProjectOptional: () => null }));
vi.mock('../../../lib/auth', () => ({ useAuth: () => ({ timeTracking: false }) }));
vi.mock('../../PortfolioPage', () => ({ HealthDialog: () => null }));
import { GeneralTab } from './General';

describe('Projekteinstellungen › Allgemein: Automatik „erledigt“', () => {
  beforeEach(() => {
    patch.mockReset(); patch.mockResolvedValue({}); reload.mockClear();
    project = { id: 'p1', key: 'WEB', name: 'Website', description: '', visibility: 'members', status: 'active', timeTrackingEnabled: false, budgetHours: null, autoCompleteParent: true, health: null, myMembership: { role: 'pl' } };
  });

  it('Schalter für Aufgaben neben dem AP-Schalter, Standard an; Ausschalten speichert autoDoneAufgabe false', async () => {
    render(<MemoryRouter><GeneralTab /></MemoryRouter>);
    const ap = screen.getByLabelText(/Arbeitspaket automatisch erledigt, wenn alle Aufgaben erledigt sind/);
    const auf = screen.getByLabelText(/Aufgabe automatisch erledigt, wenn alle Checklistenpunkte erledigt sind/);
    expect(ap).toBeChecked();
    expect(auf).toBeChecked();
    fireEvent.click(auf);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1', expect.objectContaining({ autoCompleteParent: true, autoDoneAufgabe: false })));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('autoDoneAufgabe false aus dem Projekt erscheint ausgeschaltet', () => {
    project = { ...project, autoDoneAufgabe: false };
    render(<MemoryRouter><GeneralTab /></MemoryRouter>);
    expect(screen.getByLabelText(/Aufgabe automatisch erledigt, wenn alle Checklistenpunkte erledigt sind/)).not.toBeChecked();
  });
});

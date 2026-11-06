import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const post = vi.fn();
const reload = vi.fn(async () => undefined);
const reloadTasks = vi.fn(async () => undefined);
let role = 'pl';
let canEditPlan = false;
vi.mock('../../../lib/api', () => ({ api: { get: vi.fn(), post: (...a: unknown[]) => post(...a), patch: vi.fn(), put: vi.fn(), del: vi.fn() }, ApiError: class ApiError extends Error { details: unknown; constructor(_s: number, m: string, d?: unknown) { super(m); this.details = d; } }, toCsv: () => 'x', fmtDate: (d: string) => d }));
vi.mock('../../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', key: 'WEB', myMembership: { role, canEditPlan } }, columns: [], labels: [], members: [], subprojects: [], milestones: [] }, users: [], reload, tasks: [], reloadTasks, ai: null }), useProjectOptional: () => null }));
import { ImportCard } from './ImportCard';
import { ToastProvider } from '../../../components/ui';

const preview = (errors: string[][]) => ({
  dryRun: true, headers: ['Ebene', 'Titel', 'Zuständig'], mapping: ['level', 'title', 'responsible'],
  counts: { ap: 1, aufgabe: 1, item: 0, errors: errors.filter((e) => e.length).length, subprojects: 0, labels: 0 },
  rows: [{ line: 1, kind: 'ap', title: 'Hosting', parentLine: null, errors: errors[0] ?? [], warnings: ['Label „Infra“ wird angelegt'] }, { line: 2, kind: 'aufgabe', title: 'Angebote', parentLine: 1, errors: errors[1] ?? [], warnings: [] }]
});
const csvFile = () => new File(['Ebene;Titel;Zuständig\n1;Hosting;max@demo.local\n2;Angebote;niemand'], 'plan.csv', { type: 'text/csv' });
const renderCard = () => render(<MemoryRouter><ToastProvider><ImportCard /></ToastProvider></MemoryRouter>);

describe('Projekt › Einstellungen › Daten: CSV-Import', () => {
  beforeEach(() => { post.mockReset(); reload.mockClear(); reloadTasks.mockClear(); role = 'pl'; canEditPlan = false; });

  it('Datei → Trockenlauf mit Zuordnung und Fehlern je Zeile; Importieren gesperrt; Zuordnung ändern prüft neu', async () => {
    post.mockResolvedValueOnce(preview([[], ['Zuständig „niemand“: kein Mitglied']]));
    renderCard();
    fireEvent.change(screen.getByLabelText('CSV-Datei wählen'), { target: { files: [csvFile()] } });
    await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/p1/import', expect.objectContaining({ dryRun: true, mapping: null, csv: expect.stringContaining('Hosting') })));
    expect(await screen.findByText('Zuständig „niemand“: kein Mitglied')).toBeInTheDocument();
    expect(screen.getByText('1 Zeile(n) mit Fehlern')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importieren' })).toBeDisabled();
    expect(screen.getByLabelText('Zuordnung der Spalte Zuständig')).toHaveValue('responsible');
    post.mockResolvedValueOnce({ ...preview([[], []]), mapping: ['level', 'title', 'ignore'] });
    fireEvent.change(screen.getByLabelText('Zuordnung der Spalte Zuständig'), { target: { value: 'ignore' } });
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/projects/p1/import', expect.objectContaining({ dryRun: true, mapping: ['level', 'title', 'ignore'] })));
    expect(await screen.findByText('keine Fehler')).toBeInTheDocument();
    // Import: nicht mehr Trockenlauf, mit der gewählten Zuordnung; danach neu laden
    post.mockResolvedValueOnce({ ...preview([[], []]), dryRun: false, created: { ap: 1, aufgabe: 1, item: 0 } });
    fireEvent.click(screen.getByRole('button', { name: 'Importieren' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/projects/p1/import', expect.objectContaining({ dryRun: false, mapping: ['level', 'title', 'ignore'] })));
    await waitFor(() => expect(reloadTasks).toHaveBeenCalled());
    expect(await screen.findByText(/Importiert: 1 Arbeitspakete, 1 Aufgaben/)).toBeInTheDocument();
  });

  it('Vorschau-Tabelle: Art, Titel, gehört zu, Hinweise; Filter „nur Zeilen mit Hinweisen“', async () => {
    post.mockResolvedValueOnce(preview([[], []]));
    renderCard();
    fireEvent.change(screen.getByLabelText('CSV-Datei wählen'), { target: { files: [csvFile()] } });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Arbeitspaket')).toBeInTheDocument();
    expect(within(table).getByText('Zeile 1')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('nur Zeilen mit Hinweisen'));
    expect(within(table).queryByText('Angebote')).toBeNull();
    expect(within(table).getByText('Hosting')).toBeInTheDocument();
  });

  it('ohne Planrecht kein Import', () => {
    role = 'member';
    renderCard();
    expect(screen.queryByLabelText('CSV-Datei wählen')).toBeNull();
    expect(screen.getByText(/Importieren darf die PL/)).toBeInTheDocument();
  });
});

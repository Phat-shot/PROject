import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), put: vi.fn(), patch: vi.fn() }, ApiError: class extends Error {}, downloadCsv: vi.fn(), fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-11-06' }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' }, timeTracking: false }) }));
import { PortfolioView } from './PortfolioPage';

const row = (id: string, key: string, name: string) => ({ id, key, name, description: null, myRole: 'pl', leadName: 'Petra', stats: { open: 3, done: 2, overdue: 0, dueWeek: 1, blocked: 0, escalated: 0, redRisks: 0 }, computed: 'green', health: { color: null, note: null }, nextMilestone: null, budgetHours: null, loggedMinutes: 0, timeTrackingEnabled: false, lastActivity: null });

describe('Dashboard › Projekte: Management-Report über das Portfolio', () => {
  beforeEach(() => {
    window.open = vi.fn() as any;
    get.mockReset(); post.mockReset();
    get.mockResolvedValue({ projects: [row('11111111-1111-4111-8111-111111111111', 'A', 'Alpha'), row('22222222-2222-4222-8222-222222222222', 'B', 'Beta')], workload: [] });
    post.mockResolvedValue({ html: '<h2>Gesamtübersicht</h2><svg width="10" height="10"><rect x="0" y="0" width="5" height="5"></rect></svg><p>2 Projekte</p>', title: 'Portfolio-Report 06.11.2026', projects: [] });
  });

  it('öffnet den Dialog mit Standardwerten, holt die Vorschau und öffnet das PDF mit den gewählten Parametern', async () => {
    render(<MemoryRouter><PortfolioView projectId={null} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Management-Report' }));
    const dialog = screen.getByRole('dialog', { name: 'Management-Report (Portfolio)' });
    expect(within(dialog).getByLabelText('Zeitraum')).toHaveValue('month');
    expect(within(dialog).getByLabelText('alle sichtbaren Projekte (2)')).toBeChecked();
    expect(within(dialog).getByLabelText('grafisch (Diagramme)')).toBeChecked();
    const extras = within(dialog).getByRole('group', { name: 'Zusatzblöcke' });
    expect(within(extras).getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked).map((c) => c.parentElement!.textContent!.trim())).toEqual(['Änderungen im Zeitraum', 'Meilensteine', 'Ausblick']);
    // Vorschau mit Standardwerten
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vorschau' }));
    expect(await within(dialog).findByText('2 Projekte')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/portfolio/report', { period: 'month', days: undefined, graphic: true, projectIds: undefined, blocks: [{ id: 'p1', type: 'changes' }, { id: 'p2', type: 'milestones' }, { id: 'p3', type: 'outlook' }] });
    expect(dialog.querySelector('svg rect')).not.toBeNull();
    // Auswahl ändern: Quartal, nur Beta, ohne Grafik, Risiken dazu, Ausblick weg
    fireEvent.change(within(dialog).getByLabelText('Zeitraum'), { target: { value: 'quarter' } });
    fireEvent.click(within(dialog).getByLabelText('alle sichtbaren Projekte (2)'));
    const projects = within(dialog).getByRole('group', { name: 'Projekte auswählen' });
    fireEvent.click(within(projects).getByLabelText(/Alpha/));
    fireEvent.click(within(dialog).getByLabelText('grafisch (Diagramme)'));
    fireEvent.click(within(extras).getByLabelText('Risiken und Entscheidungen (RAID)'));
    fireEvent.click(within(extras).getByLabelText('Ausblick'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'PDF' }));
    const url = (window.open as any).mock.calls[0][0] as string;
    expect(url.startsWith('/api/portfolio/report.pdf?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('period')).toBe('quarter');
    expect(q.get('graphic')).toBe('false');
    expect(JSON.parse(q.get('projectIds')!)).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(JSON.parse(q.get('blocks')!).map((b: { type: string }) => b.type)).toEqual(['changes', 'milestones', 'risks']);
    // n Tage: Zahlfeld erscheint; keine Projekte gewählt sperrt die Knöpfe
    fireEvent.change(within(dialog).getByLabelText('Zeitraum'), { target: { value: 'days' } });
    expect(within(dialog).getByLabelText('Tage')).toHaveValue(30);
    fireEvent.click(within(projects).getByLabelText(/Beta/));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'PDF' })).toBeDisabled());
  });
});

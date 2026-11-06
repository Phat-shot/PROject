import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_ESCALATION, DEFAULT_REPORTING } from '@projekttool/shared';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const reload = vi.fn(async () => undefined);
vi.mock('../../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-11-06' }));
let role = 'pl';
const reporting = () => ({ ...DEFAULT_REPORTING, enabled: true, recipients: ['gf@kunde.de'], blocks: [{ id: 'b1', type: 'summary', chart: true }, { id: 'b2', type: 'changes', period: 'since_last', limit: 15 }], textSource: 'ai', graphic: true });
vi.mock('../../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', myMembership: { role }, escalation: DEFAULT_ESCALATION, reporting: reporting(), mailAddress: 'p1@demo.local' }, members: [] }, users: [], reload, tasks: [], reloadTasks: vi.fn(), ai: null }), useProjectOptional: () => null }));
import { DeadlinesTab } from './Deadlines';

const renderTab = () => render(<MemoryRouter><DeadlinesTab /></MemoryRouter>);

describe('Projekteinstellungen › Fristen und Berichte: Reporting mit Block-Editor', () => {
  beforeEach(() => {
    role = 'pl';
    window.confirm = () => true;
    window.open = vi.fn() as any;
    get.mockReset(); post.mockReset(); patch.mockReset(); reload.mockClear();
    get.mockImplementation(async (url: string) => (url === '/docs/templates' ? { templates: [{ key: 'statusbericht', name: 'Statusbericht' }] } : { pages: [] }));
    patch.mockResolvedValue({});
  });

  it('Vorschau holt das HTML mit den ungespeicherten Blöcken, zeigt es bereinigt (SVG bleibt) und öffnet das PDF in neuem Tab', async () => {
    post.mockResolvedValue({ html: '<h2>Gesamtstand</h2><div class="report-chart"><svg width="10" height="10"><rect x="0" y="0" width="5" height="5" fill="red"></rect><script>alert(1)</script></svg></div><p>Ampel Grün</p>', title: 'Management-Report P1 06.11.2026', textSource: 'rules' });
    renderTab();
    expect(await screen.findByRole('list', { name: 'Blöcke des Berichts' })).toBeInTheDocument();
    expect(screen.getByLabelText('Texte')).toHaveValue('ai');
    expect(screen.getByLabelText('Grafisch ausarbeiten (Diagramme)')).toBeChecked();
    // Block ändern, ohne zu speichern: Vorschau nimmt den aktuellen Stand
    fireEvent.change(screen.getByLabelText('Maximale Einträge „Änderungen im Zeitraum“'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vorschau' }));
    const dialog = await screen.findByRole('dialog', { name: 'Management-Report P1 06.11.2026' });
    expect(post).toHaveBeenCalledWith('/projects/p1/reporting/preview', { blocks: [{ id: 'b1', type: 'summary', chart: true }, { id: 'b2', type: 'changes', period: 'since_last', limit: 5 }], textSource: 'ai', graphic: true });
    expect(within(dialog).getByText(/Entwurf, nicht gespeichert/)).toBeInTheDocument();
    expect(within(dialog).getByText('Ampel Grün')).toBeInTheDocument();
    expect(dialog.querySelector('svg rect')).not.toBeNull();
    expect(dialog.querySelector('script')).toBeNull();
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Als PDF' }));
    const url = (window.open as any).mock.calls[0][0] as string;
    expect(url.startsWith('/api/projects/p1/reporting/preview.pdf?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(JSON.parse(q.get('blocks')!)[1]).toMatchObject({ type: 'changes', limit: 5 });
    expect(q.get('textSource')).toBe('ai');
    expect(q.get('graphic')).toBe('true');
  });

  it('Speichern sendet Blöcke, Textquelle und Grafik mit', async () => {
    renderTab();
    await screen.findByRole('list', { name: 'Blöcke des Berichts' });
    fireEvent.change(screen.getByLabelText('Texte'), { target: { value: 'rules' } });
    fireEvent.click(screen.getByLabelText('Grafisch ausarbeiten (Diagramme)'));
    // Speichern-Knopf des Reportings (die Eskalationsregeln haben einen eigenen)
    const form = screen.getByRole('list', { name: 'Blöcke des Berichts' }).closest('.form')!;
    fireEvent.click(within(form as HTMLElement).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0][1].reporting;
    expect(body).toMatchObject({ enabled: true, recipients: ['gf@kunde.de'], textSource: 'rules', graphic: false });
    expect(body.blocks.map((b: { type: string }) => b.type)).toEqual(['summary', 'changes']);
  });

  it('ohne PL-Rolle nur eine Zusammenfassung des Aufbaus', async () => {
    role = 'member';
    renderTab();
    expect(await screen.findByText(/Aufbau: Gesamtstand, Änderungen im Zeitraum \(seit letztem Bericht\) · Texte: KI · grafisch/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Blöcke des Berichts' })).toBeNull();
  });
});

import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d }));
vi.mock('../../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', myMembership: { role: 'pl' } }, members: [] }, users: [], reload: vi.fn(), tasks: [], reloadTasks: vi.fn(), ai: null }), useProjectOptional: () => null }));
import { AgentSourcesCard } from './AgentSources';

const data = (o: Partial<any> = {}) => ({
  canEdit: true,
  folders: [
    { id: 'f1', name: 'Verträge', parentId: null, depth: 0, pages: 3, agentAccess: 'none', inheritedOff: false },
    { id: 'f2', name: 'Nachträge', parentId: 'f1', depth: 1, pages: 1, agentAccess: 'write', inheritedOff: true },
    { id: 'f3', name: 'Protokolle', parentId: null, depth: 0, pages: 5, agentAccess: 'read', inheritedOff: false }
  ],
  bindings: [{ id: 'b1', label: 'Pläne Halle 3', sourceName: 'Firmen-Nextcloud', subPath: '/Halle 3', active: true, files: 7, agentEnabled: true }],
  mails: { enabled: true, views: 2 },
  ...o
});

describe('Quellen für den Agenten', () => {
  beforeEach(() => { get.mockReset(); patch.mockReset(); });

  it('PL setzt den Agent-Zugriff je Ordner (wie in der Doku), schaltet Dateiquelle und Mails; Unterordner eines ausgeschlossenen Ordners ohne eigene Auswahl', async () => {
    get.mockResolvedValue(data());
    patch.mockImplementation(async (_url: string, body: any) => data(body.bindings ? { bindings: [{ ...data().bindings[0], agentEnabled: false }] } : {}));
    render(<MemoryRouter><AgentSourcesCard /></MemoryRouter>);
    const folder = await screen.findByLabelText('Zugriff der KI-Agenten auf Ordner Verträge');
    expect(folder).toHaveValue('none');
    expect(screen.queryByLabelText('Zugriff der KI-Agenten auf Ordner Nachträge')).toBeNull();
    expect(within(screen.getByText('Nachträge').closest('tr') as HTMLElement).getByText('ausgeschlossen (über Oberordner)')).toBeInTheDocument();
    expect(screen.getByLabelText('Zugriff der KI-Agenten auf Ordner Protokolle')).toHaveValue('read');
    expect(within(folder).getAllByRole('option').map((o) => o.textContent)).toEqual(['schreiben (Seiten anlegen, ändern, verschieben)', 'nur lesen', 'kein Zugriff (auch nicht im Kontext der Agenten)']);
    fireEvent.change(folder, { target: { value: 'write' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1/agent-sources', { folders: [{ id: 'f1', agentAccess: 'write' }] }));
    fireEvent.click(screen.getByLabelText('Dateiquelle Pläne Halle 3 für KI-Agenten'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1/agent-sources', { bindings: [{ id: 'b1', agentEnabled: false }] }));
    await waitFor(() => expect(screen.getByLabelText('Dateiquelle Pläne Halle 3 für KI-Agenten')).not.toBeChecked());
    fireEvent.click(screen.getByLabelText('Mails für KI-Agenten durchsuchbar'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1/agent-sources', { mails: false }));
    expect(screen.getByText(/2 Ansichten; zusätzlich gelten die Rechte je Ansicht/)).toBeInTheDocument();
  });

  it('Mitglieder sehen die Schalter nur lesend; als Abschnitt in der Assistent-Karte mit Überschrift', async () => {
    get.mockResolvedValue(data({ canEdit: false }));
    render(<MemoryRouter><AgentSourcesCard section /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Quellen für den Agenten' })).toBeInTheDocument();
    expect(screen.getByLabelText('Mails für KI-Agenten durchsuchbar')).toBeDisabled();
    expect(screen.getByLabelText('Zugriff der KI-Agenten auf Ordner Verträge')).toBeDisabled();
    expect(get).toHaveBeenCalledWith('/projects/p1/agent-sources');
  });
});

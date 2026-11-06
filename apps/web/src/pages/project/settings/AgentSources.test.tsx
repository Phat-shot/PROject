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
    { id: 'f1', name: 'Verträge', parentId: null, depth: 0, pages: 3, agentEnabled: false, agentAccess: 'write', inheritedOff: false },
    { id: 'f2', name: 'Nachträge', parentId: 'f1', depth: 1, pages: 1, agentEnabled: true, agentAccess: 'write', inheritedOff: true },
    { id: 'f3', name: 'Protokolle', parentId: null, depth: 0, pages: 5, agentEnabled: true, agentAccess: 'none', inheritedOff: false }
  ],
  bindings: [{ id: 'b1', label: 'Pläne Halle 3', sourceName: 'Firmen-Nextcloud', subPath: '/Halle 3', active: true, files: 7, agentEnabled: true }],
  mails: { enabled: true, views: 2 },
  ...o
});

describe('Quellen für den Agenten', () => {
  beforeEach(() => { get.mockReset(); patch.mockReset(); });

  it('PL schaltet Ordner, Dateiquelle und Mails einzeln; Unterordner eines ausgeschlossenen Ordners ohne eigenen Schalter', async () => {
    get.mockResolvedValue(data());
    patch.mockImplementation(async (_url: string, body: any) => data(body.bindings ? { bindings: [{ ...data().bindings[0], agentEnabled: false }] } : {}));
    render(<MemoryRouter><AgentSourcesCard /></MemoryRouter>);
    const folder = await screen.findByLabelText('Ordner Verträge für KI-Agenten');
    expect(folder).not.toBeChecked();
    expect(screen.queryByLabelText('Ordner Nachträge für KI-Agenten')).toBeNull();
    expect(within(screen.getByText('Nachträge').closest('tr') as HTMLElement).getByText('ausgeschlossen (über Oberordner)')).toBeInTheDocument();
    expect(within(screen.getByText('Protokolle').closest('tr') as HTMLElement).getByText('kein Zugriff')).toBeInTheDocument();
    fireEvent.click(folder);
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1/agent-sources', { folders: [{ id: 'f1', agentEnabled: true }] }));
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
    expect(screen.getByLabelText('Ordner Verträge für KI-Agenten')).toBeDisabled();
    expect(get).toHaveBeenCalledWith('/projects/p1/agent-sources');
  });
});

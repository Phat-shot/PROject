import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const patch = vi.fn();
vi.mock('../../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: (...a: unknown[]) => del(...a) }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d }));
vi.mock('../../../lib/useAi', () => ({ invalidateAi: vi.fn(async () => undefined), useAiStatus: () => null }));
let role = 'pl';
vi.mock('../../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', myMembership: { role } }, members: [] }, users: [], reload: vi.fn(), tasks: [], reloadTasks: vi.fn(), ai: null }), useProjectOptional: () => null }));
import { ToastProvider } from '../../../components/ui';
import { FilesTab } from './Files';

const binding = { id: 'b1', sourceId: 'org1', sourceName: 'Firmen-Nextcloud', scope: 'org', kind: 'webdav', subPath: '/Projekte/Halle 3', label: 'Pläne Halle 3', lastSyncAt: null, lastError: null, active: true, files: 7 };
let bindings: unknown[] = [];
let own: unknown[] = [];
const ownSource = { id: 'own1', name: 'Ablage', kind: 'webdav', url: 'https://cloud.example.de/remote.php/dav/files/lea', davUrl: 'https://cloud.example.de/remote.php/dav/files/lea', username: 'lea', hasSecret: true, rootPath: '/Projekt', scope: 'project', ownerProjectId: 'p1', projectScope: 'none', projectIds: [], personalUse: 'none', personalUserIds: [], active: true, lastSyncAt: null, lastError: null, lastStats: null, files: 3, bindings: [], createdAt: '2026-11-01' };

describe('Projekt › Einstellungen › Dateien', () => {
  beforeEach(() => {
    role = 'pl'; bindings = []; own = [];
    get.mockReset(); post.mockReset(); del.mockReset(); patch.mockReset();
    get.mockImplementation(async (url: string) => url === '/projects/p1/file-sources'
      ? { available: [{ id: 'org1', name: 'Firmen-Nextcloud', kind: 'webdav', scope: 'org', rootPath: '/', lastSyncAt: null, lastError: null, files: 9 }], own, bindings }
      : url === '/projects/p1/files' ? { binding: null, path: '/', parent: null, roots: [{ bindingId: 'b1', sourceId: 'org1', label: 'Pläne Halle 3', sourceName: 'Firmen-Nextcloud', kind: 'webdav', scope: 'org', subPath: '/Projekte/Halle 3', lastSyncAt: null, lastError: 'HTTP 401' }], entries: [] } : {});
    post.mockImplementation(async (url: string, body: any) => {
      if (url === '/file-sources/browse') return body.path === '/' ? { kind: 'webdav', path: '/', parent: null, folders: [{ name: 'Projekte', path: '/Projekte' }], files: 0 } : { kind: 'webdav', path: body.path, parent: '/', folders: [], files: 4 };
      if (url === '/projects/p1/file-sources') { bindings = [{ ...binding, subPath: body.subPath, label: body.label }]; return { binding: bindings[0] }; }
      if (url === '/file-sources/org1/sync') return { stats: { files: 4, added: 4, changed: 0, deleted: 0, extracted: 2, truncated: false } };
      return {};
    });
  });

  it('PL bindet eine freigegebene Quelle mit Unterordner ein und gleicht direkt danach ab (Toast)', async () => {
    render(<MemoryRouter><ToastProvider><FilesTab /></ToastProvider></MemoryRouter>);
    expect(await screen.findByText(/Noch nichts eingebunden/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Freigegebene Quelle einbinden' }));
    const dlg = await screen.findByRole('dialog', { name: 'Freigegebene Quelle einbinden' });
    const q = within(dlg);
    fireEvent.click(q.getByRole('button', { name: 'Ordner wählen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/file-sources/browse', { sourceId: 'org1', projectId: 'p1', path: '/' }));
    fireEvent.click(await q.findByRole('button', { name: 'Projekte' }));
    await q.findByText(/^4 Dateien/);
    fireEvent.change(q.getByLabelText('Anzeigename in der Doku'), { target: { value: 'Projektordner' } });
    fireEvent.click(q.getByRole('button', { name: 'Einbinden' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/p1/file-sources', { sourceId: 'org1', subPath: '/Projekte', label: 'Projektordner' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/file-sources/org1/sync'));
    expect(await screen.findByText('Projektordner synchronisiert: 4 Dateien, 4 neu, 0 geändert, 0 entfernt, 2 Textauszüge.')).toBeInTheDocument();
    // Liste neu geladen: Einbindung mit Link in die Doku, Dateianzahl unter dem Unterordner
    const link = await screen.findByRole('link', { name: 'Projektordner' });
    expect(link).toHaveAttribute('href', '/projekte/p1/doku/dateien/b1');
    expect(within(link.closest('tr') as HTMLElement).getAllByRole('cell')[3]).toHaveTextContent(/^7$/);
    // Badge „KI: an/aus“ je Einbindung (Schalter unter Einstellungen › KI)
    expect(within(link.closest('tr') as HTMLElement).getByRole('link', { name: 'KI: an' })).toHaveAttribute('href', '/projekte/p1/einstellungen/ki');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Eigene Quelle: Anlegen sendet Adresse, Zugang und Startordner, danach Abgleich', async () => {
    render(<MemoryRouter><FilesTab /></MemoryRouter>);
    await screen.findByText(/Noch nichts eingebunden/);
    fireEvent.click(screen.getByRole('button', { name: 'Eigene Quelle anlegen' }));
    const q = within(await screen.findByRole('dialog', { name: 'Eigene Quelle anlegen' }));
    expect(q.queryByLabelText('Projektfreigabe')).toBeNull();
    fireEvent.change(q.getByLabelText('Name'), { target: { value: 'Ablage' } });
    fireEvent.change(q.getByLabelText(/^Adresse/), { target: { value: 'https://cloud.example.de/s/XyZ' } });
    fireEvent.click(q.getByRole('button', { name: 'Anlegen und einbinden' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/p1/file-sources', { name: 'Ablage', url: 'https://cloud.example.de/s/XyZ', username: null, rootPath: '/', label: undefined }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/file-sources/org1/sync'));
  });

  it('Eigene Quelle bearbeiten: Ordnerwahl ohne Passwort über sourceId (absolute); geänderte Adresse verlangt das Passwort', async () => {
    own = [ownSource];
    bindings = [{ ...binding, id: 'b2', sourceId: 'own1', sourceName: 'Ablage', scope: 'project', subPath: null, label: 'Ablage', files: 3 }];
    render(<MemoryRouter><FilesTab /></MemoryRouter>);
    const row = (await screen.findByRole('link', { name: 'Ablage' })).closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('cell')[3]).toHaveTextContent(/^3$/);
    fireEvent.click(within(row).getByRole('button', { name: 'Bearbeiten' }));
    const q = within(await screen.findByRole('dialog', { name: 'Eigene Quelle: Ablage' }));
    expect(q.queryByText(/Passwort erneut eingeben/)).toBeNull();
    fireEvent.click(q.getByRole('button', { name: 'Ordner wählen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/file-sources/browse', { sourceId: 'own1', absolute: true, path: '/Projekt' }));
    fireEvent.click(q.getByRole('button', { name: 'Ordnerwahl schließen' }));
    fireEvent.change(q.getByLabelText('Benutzer'), { target: { value: 'max' } });
    expect(q.getByText(/Adresse oder Benutzer geändert: zum Durchsuchen das Passwort erneut eingeben/)).toBeInTheDocument();
    expect(q.getByRole('button', { name: 'Ordner wählen' })).toBeDisabled();
    fireEvent.change(q.getByLabelText('Benutzer'), { target: { value: 'lea' } });
    fireEvent.click(q.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/file-sources/own1', { name: 'Ablage', url: 'https://cloud.example.de/remote.php/dav/files/lea', username: 'lea', rootPath: '/Projekt' }));
  });

  it('Mitglieder sehen die Einbindungen nur lesend', async () => {
    role = 'member';
    render(<MemoryRouter><FilesTab /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Pläne Halle 3' })).toHaveAttribute('href', '/projekte/p1/doku/dateien/b1');
    expect(screen.getByText(/Nur lesend/)).toBeInTheDocument();
    expect(screen.getByText('Fehler')).toHaveAttribute('title', 'HTTP 401');
    expect(screen.queryByRole('button', { name: 'Eigene Quelle anlegen' })).toBeNull();
    expect(get).not.toHaveBeenCalledWith('/projects/p1/file-sources');
  });
});

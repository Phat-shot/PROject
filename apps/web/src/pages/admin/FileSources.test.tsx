import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FileSource } from '@projekttool/shared';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: (...a: unknown[]) => del(...a) }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d }));
vi.mock('../../lib/useAi', () => ({ invalidateAi: vi.fn(async () => undefined), useAiStatus: () => null }));
import { ToastProvider } from '../../components/ui';
import { FileSourcesSection, syncMessage } from './FileSources';

const source: FileSource = {
  id: 's1', name: 'Pläne Kunde', kind: 'nextcloud_share', url: 'https://cloud.example.de/s/AbC', davUrl: 'https://cloud.example.de/public.php/webdav', username: null, hasSecret: false, rootPath: '/',
  scope: 'org', ownerProjectId: null, projectScope: 'all', projectIds: [], personalUse: 'none', personalUserIds: [], active: true, lastSyncAt: '2026-11-05T10:00:00Z', lastError: null,
  lastStats: null, files: 12, bindings: [], createdAt: '2026-11-01T10:00:00Z'
};

const browse = (path: string) => path === '/'
  ? { kind: 'webdav', path: '/', parent: null, folders: [{ name: 'Projekte', path: '/Projekte' }, { name: 'Privat', path: '/Privat' }], files: 2 }
  : path === '/Projekte'
    ? { kind: 'webdav', path: '/Projekte', parent: '/', folders: [{ name: 'Halle 3', path: '/Projekte/Halle 3' }], files: 0 }
    : { kind: 'webdav', path, parent: '/Projekte', folders: [], files: 5 };

describe('Sync-Meldung', () => {
  it('nennt die Texterkennung, wenn Dateien per OCR gelesen wurden', () => {
    expect(syncMessage('Scans', { files: 5, added: 3, changed: 0, deleted: 0, extracted: 3, ocr: 2, truncated: false })).toBe('Scans synchronisiert: 5 Dateien, 3 neu, 0 geändert, 0 entfernt, 3 Textauszüge, davon 2 per Texterkennung.');
    expect(syncMessage('Scans', { files: 5, added: 0, changed: 0, deleted: 0, extracted: 0, ocr: 0, truncated: false })).not.toMatch(/Texterkennung/);
  });
});

describe('Verwaltung › Dateiquellen', () => {
  beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset();
    get.mockImplementation(async (url: string) => url === '/file-sources'
      ? { sources: [source], projectSources: [{ id: 's9', name: 'Eigene Ablage', kind: 'webdav', active: true, project: 'WEB Website', files: 3, lastSyncAt: null, lastError: null }] }
      : url === '/ai/release-projects' ? { projects: [{ id: 'p1', label: 'WEB Website' }, { id: 'p2', label: 'BAU Halle 3' }, { id: 'pp', label: 'persönlich (Lea)' }] }
      : url === '/users' ? { users: [] } : {});
    post.mockImplementation(async (url: string, body: any) => url === '/file-sources/browse' ? browse(body.path) : url === '/file-sources' ? { source } : url.endsWith('/sync') ? { stats: { files: 12, added: 2, changed: 1, deleted: 0, extracted: 3, truncated: false } } : {});
  });

  it('listet Quellen und Projektquellen; Anlegen mit Ordnerwahl (browse, hoch, Pfad) und Projektfreigabe sendet den vollständigen Body', async () => {
    render(<FileSourcesSection />);
    expect(await screen.findByText('Pläne Kunde')).toBeInTheDocument();
    expect(screen.getByText('Freigabelink')).toBeInTheDocument();
    expect(screen.getByText('Eigene Ablage')).toBeInTheDocument();
    expect(screen.getByText('WEB Website')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Quelle anlegen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Dateiquelle anlegen' });
    const q = within(dlg);
    // Ohne Adresse keine Ordnerwahl
    expect(q.getByRole('button', { name: 'Ordner wählen' })).toBeDisabled();
    fireEvent.change(q.getByLabelText('Name'), { target: { value: 'Firmen-Nextcloud' } });
    fireEvent.change(q.getByLabelText(/^Adresse/), { target: { value: 'https://cloud.example.de/remote.php/dav/files/lea/' } });
    fireEvent.change(q.getByLabelText('Benutzer'), { target: { value: 'lea' } });
    fireEvent.change(q.getByLabelText(/^App-Passwort/), { target: { value: 'app-pw' } });

    fireEvent.click(q.getByRole('button', { name: 'Ordner wählen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/file-sources/browse', { url: 'https://cloud.example.de/remote.php/dav/files/lea/', username: 'lea', secret: 'app-pw', path: '/' }));
    fireEvent.click(await q.findByRole('button', { name: 'Projekte' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/file-sources/browse', expect.objectContaining({ path: '/Projekte' })));
    fireEvent.click(await q.findByRole('button', { name: 'Halle 3' }));
    expect(await q.findByText('5 Dateien direkt in diesem Ordner. Gewählt ist der angezeigte Ordner.')).toBeInTheDocument();
    const crumbs = q.getByRole('navigation', { name: 'Ordnerpfad' });
    expect(within(crumbs).getByRole('button', { name: 'Halle 3' })).toBeInTheDocument();
    // hoch führt zum übergeordneten Ordner zurück
    fireEvent.click(q.getByRole('button', { name: 'hoch' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/file-sources/browse', expect.objectContaining({ path: '/Projekte' })));
    expect(await q.findByRole('button', { name: 'Halle 3' })).toBeInTheDocument();
    fireEvent.click(q.getByRole('button', { name: 'Halle 3' }));
    await q.findByText(/^5 Dateien/);

    fireEvent.change(q.getByRole('combobox', { name: /Projektfreigabe/ }), { target: { value: 'selected' } });
    expect(await q.findByLabelText('Projekt BAU Halle 3')).toBeInTheDocument();
    expect(q.queryByLabelText('Projekt persönlich (Lea)')).toBeNull();
    fireEvent.change(q.getByLabelText('Projekte suchen'), { target: { value: 'bau' } });
    expect(q.queryByLabelText('Projekt WEB Website')).toBeNull();
    fireEvent.click(q.getByLabelText('Projekt BAU Halle 3'));
    fireEvent.change(q.getByLabelText('Für persönliche Projekte'), { target: { value: 'all' } });

    fireEvent.click(q.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/file-sources', expect.anything()));
    const body = post.mock.calls.find((c) => c[0] === '/file-sources')![1];
    expect(body).toEqual({ name: 'Firmen-Nextcloud', url: 'https://cloud.example.de/remote.php/dav/files/lea/', username: 'lea', secret: 'app-pw', rootPath: '/Projekte/Halle 3', projectScope: 'selected', projectIds: ['p2'], personalUse: 'all', personalUserIds: [], active: true });
  });

  it('Freigabelink: kein Benutzerfeld, Passwort optional; „Jetzt synchronisieren“ zeigt das Ergebnis als Toast', async () => {
    render(<ToastProvider><FileSourcesSection /></ToastProvider>);
    await screen.findByText('Pläne Kunde');
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt synchronisieren' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/file-sources/s1/sync'));
    expect(await screen.findByText('Pläne Kunde synchronisiert: 12 Dateien, 2 neu, 1 geändert, 0 entfernt, 3 Textauszüge.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    const dlg = await screen.findByRole('dialog', { name: 'Dateiquelle: Pläne Kunde' });
    expect(within(dlg).queryByLabelText('Benutzer')).toBeNull();
    expect(within(dlg).getByLabelText(/Passwort des Freigabelinks/)).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/file-sources/s1');
    expect(patch.mock.calls[0][1]).toMatchObject({ name: 'Pläne Kunde', url: 'https://cloud.example.de/s/AbC', username: null, rootPath: '/', projectScope: 'all', personalUse: 'none', active: true });
    expect(patch.mock.calls[0][1]).not.toHaveProperty('secret');
  });

  it('Bearbeiten: Ordnerwahl ohne Passwort ruft die sourceId-Variante (absolute); Hinweis nur bei geänderter Adresse', async () => {
    const withSecret = { ...source, hasSecret: true, rootPath: '/Projekte' };
    get.mockImplementation(async (url: string) => url === '/file-sources' ? { sources: [withSecret], projectSources: [] } : url === '/users' ? { users: [] } : {});
    render(<FileSourcesSection />);
    await screen.findByText('Pläne Kunde');
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    const q = within(await screen.findByRole('dialog', { name: 'Dateiquelle: Pläne Kunde' }));
    expect(q.queryByText(/Passwort erneut eingeben/)).toBeNull();
    fireEvent.click(q.getByRole('button', { name: 'Ordner wählen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/file-sources/browse', { sourceId: 's1', absolute: true, path: '/Projekte' }));
    // Startordner selbst ändern: eine Ebene hoch bis zur Wurzel
    fireEvent.click(await q.findByRole('button', { name: 'hoch' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/file-sources/browse', { sourceId: 's1', absolute: true, path: '/' }));
    fireEvent.click(q.getByRole('button', { name: 'Ordnerwahl schließen' }));
    fireEvent.change(q.getByLabelText(/^Adresse/), { target: { value: 'https://cloud.example.de/s/Neu' } });
    expect(q.getByText(/Adresse oder Benutzer geändert: zum Durchsuchen das Passwort erneut eingeben/)).toBeInTheDocument();
    expect(q.getByRole('button', { name: 'Ordner wählen' })).toBeDisabled();
    // Neues Passwort eingegeben: Ordnerwahl über die eingegebene Adresse
    fireEvent.change(q.getByLabelText(/Passwort des Freigabelinks/), { target: { value: 'neu' } });
    fireEvent.click(q.getByRole('button', { name: 'Ordner wählen' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/file-sources/browse', { url: 'https://cloud.example.de/s/Neu', username: null, secret: 'neu', path: '/' }));
    fireEvent.click(q.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
  });
});

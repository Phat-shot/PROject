import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const get = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d }));
vi.mock('../../lib/useMedia', () => ({ useIsMobile: () => false }));
vi.mock('../../components/RichEditor', () => ({ RichEditor: () => null, HtmlView: () => null }));
vi.mock('./MeetingsView', () => ({ MeetingsView: () => null }));
vi.mock('../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', myMembership: { role: 'member' } }, members: [] }, users: [], reload: vi.fn(), tasks: [], reloadTasks: vi.fn(), ai: null }), useProjectOptional: () => null }));
import { DocsView } from './DocsView';

const root = { bindingId: 'b1', sourceId: 's1', label: 'Pläne Halle 3', sourceName: 'Firmen-Nextcloud', kind: 'webdav', scope: 'org', subPath: '/Projekte/Halle 3', lastSyncAt: '2026-11-06T08:00:00Z', lastError: null };
const file = (id: string, name: string, mime: string, textStatus: string | null, path: string, textNote: string | null = null) => ({ type: 'file', id, name, path, mime, size: 2048, modifiedAt: '2026-11-01T09:00:00Z', textStatus, textNote, bindingId: 'b1' });

function listing(url: string) {
  const u = new URL(url, 'http://x');
  if (u.pathname !== '/projects/p1/files') return null;
  const binding = u.searchParams.get('binding');
  const path = u.searchParams.get('path') ?? '/';
  if (!binding) return { binding: null, path: '/', parent: null, roots: [root], entries: [{ type: 'folder', name: root.label, path: '/', bindingId: 'b1' }] };
  if (path === '/') return { binding: root, path: '/', parent: null, roots: [root], entries: [{ type: 'folder', name: 'Statik', path: '/Statik', files: 2, bindingId: 'b1' }, file('f1', 'Notiz.md', 'text/markdown', 'ok', '/Notiz.md'), file('f2', 'Plan.pdf', 'application/pdf', 'skipped', '/Plan.pdf'), file('f4', 'Scan.pdf', 'application/pdf', 'error', '/Scan.pdf', 'PDF ohne Textebene')] };
  if (path === '/Statik') return { binding: root, path: '/Statik', parent: '/', roots: [root], entries: [file('f3', 'Last.txt', 'text/plain', 'ok', '/Statik/Last.txt')] };
  return null;
}

const renderAt = (at: string) => render(
  <MemoryRouter initialEntries={[at]}>
    <Routes>
      <Route path="/projekte/:id/doku/dateien" element={<DocsView files />} />
      <Route path="/projekte/:id/doku/dateien/:bindingId/*" element={<DocsView files />} />
      <Route path="/projekte/:id/doku/:pageId?" element={<DocsView />} />
    </Routes>
  </MemoryRouter>
);

describe('Doku › Dateien', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(async (url: string) => {
      const l = listing(url);
      if (l) return l;
      if (url === '/projects/p1/docs') return { folders: [], pages: [], templates: [] };
      if (url === '/files/f1/text') return { id: 'f1', name: 'Notiz.md', path: '/Notiz.md', projectId: 'p1', bindingId: 'b1', displayPath: 'Pläne Halle 3/Notiz.md', mime: 'text/markdown', size: 2048, modifiedAt: null, textStatus: 'ok', textNote: null, text: '# Baubesprechung\n\n- Termin **Montag**' };
      if (url === '/files/f2/download?check=1') return { ok: true };
      if (url === '/files/f4/download?check=1') throw new Error('Zugriff verweigert (HTTP 401)');
      if (url === '/files/f3/text') return { id: 'f3', name: 'Last.txt', path: '/Statik/Last.txt', projectId: 'p1', bindingId: 'b1', displayPath: '', mime: 'text/plain', size: 2048, modifiedAt: null, textStatus: 'ok', textNote: null, text: 'Lastannahmen <b>roh</b>' };
      throw new Error(`unerwartet ${url}`);
    });
  });

  it('Leiste zeigt die Einbindungen unter „Dateien“; Übersicht führt in den Ordner', async () => {
    renderAt('/projekte/p1/doku');
    const tree = (await screen.findByText('Pläne Halle 3')).closest('.doc-tree') as HTMLElement;
    expect(within(tree).getByText('Dateien')).toBeInTheDocument();
    fireEvent.click(within(tree).getByText('Pläne Halle 3'));
    expect(await screen.findByRole('navigation', { name: 'Pfad' })).toBeInTheDocument();
    expect(screen.getByText(/Nur lesend · Quelle: Firmen-Nextcloud › \/Projekte\/Halle 3 · zuletzt synchronisiert 2026-11-06T08:00:00Z/)).toBeInTheDocument();
  });

  it('Liste mit Ordnern zuerst, Textstatus-Badge; Ordner navigiert, Textdatei als Vorschau (pre), Markdown gerendert', async () => {
    renderAt('/projekte/p1/doku/dateien/b1');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Statik');
    expect(rows[0]).toHaveTextContent('2 Dateien');
    expect(within(rows[1]).getByText('durchsuchbar')).toBeInTheDocument();
    expect(within(rows[2]).getByText('nicht durchsuchbar')).toHaveAttribute('title', expect.stringMatching(/Kein Textauszug/));
    expect(rows[2]).toHaveTextContent('2 kB');

    // Markdown-Datei: Text gerendert
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Notiz.md' }));
    const md = await screen.findByRole('dialog', { name: 'Notiz.md' });
    expect(await within(md).findByRole('heading', { name: 'Baubesprechung' })).toBeInTheDocument();
    expect(within(md).getByText('Montag').tagName).toBe('STRONG');
    expect(within(md).getByRole('link', { name: /Herunterladen/ })).toHaveAttribute('href', '/api/files/f1/download');
    fireEvent.click(within(md).getByRole('button', { name: /schließen/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Ordner öffnen
    fireEvent.click(within(rows[0]).getByRole('link', { name: 'Statik' }));
    expect(await screen.findByRole('button', { name: 'Last.txt' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/projects/p1/files?binding=b1&path=%2FStatik');
    const crumbs = screen.getByRole('navigation', { name: 'Pfad' });
    expect(within(crumbs).getByRole('link', { name: 'Pläne Halle 3' })).toHaveAttribute('href', '/projekte/p1/doku/dateien/b1');
    fireEvent.click(screen.getByRole('button', { name: 'Last.txt' }));
    const txt = await screen.findByRole('dialog', { name: 'Last.txt' });
    const pre = await within(txt).findByText('Lastannahmen <b>roh</b>');
    expect(pre.tagName).toBe('PRE');
    // hoch führt zurück
    fireEvent.click(within(txt).getByRole('button', { name: /schließen/i }));
    fireEvent.click(screen.getByText('hoch'));
    expect(await screen.findByRole('button', { name: 'Plan.pdf' })).toBeInTheDocument();
  });

  it('PDF: Vorab-Check, dann inline im iframe, ohne Textabruf; Badge aus dem Index', async () => {
    renderAt('/projekte/p1/doku/dateien/b1');
    fireEvent.click(await screen.findByRole('button', { name: 'Plan.pdf' }));
    const dlg = await screen.findByRole('dialog', { name: 'Plan.pdf' });
    expect(await within(dlg).findByTitle('Vorschau Plan.pdf')).toHaveAttribute('src', '/api/files/f2/download?inline=1');
    expect(get).toHaveBeenCalledWith('/files/f2/download?check=1');
    expect(get).not.toHaveBeenCalledWith('/files/f2/text');
    expect(within(dlg).getByText('nicht durchsuchbar')).toBeInTheDocument();
  });

  it('PDF bei nicht erreichbarer Quelle: Meldung statt leerem iframe; Tooltip mit dem echten Grund', async () => {
    renderAt('/projekte/p1/doku/dateien/b1');
    const row = (await screen.findByRole('button', { name: 'Scan.pdf' })).closest('tr') as HTMLElement;
    expect(within(row).getByText('nicht durchsuchbar')).toHaveAttribute('title', 'PDF ohne Textebene');
    fireEvent.click(within(row).getByRole('button', { name: 'Scan.pdf' }));
    const dlg = await screen.findByRole('dialog', { name: 'Scan.pdf' });
    expect(await within(dlg).findByText('Quelle nicht erreichbar: Zugriff verweigert (HTTP 401)')).toBeInTheDocument();
    expect(within(dlg).queryByTitle('Vorschau Scan.pdf')).toBeNull();
    expect(within(dlg).getByText('nicht durchsuchbar')).toHaveAttribute('title', 'PDF ohne Textebene');
  });

  it('Fehler der Quelle verständlich; leerer Zustand ohne Einbindung', async () => {
    get.mockImplementation(async (url: string) => url === '/projects/p1/docs' ? { folders: [], pages: [], templates: [] } : url === '/projects/p1/files' ? { binding: null, path: '/', parent: null, roots: [], entries: [] } : (() => { throw new Error('Ordner nicht gefunden'); })());
    const { unmount } = renderAt('/projekte/p1/doku/dateien');
    expect(await screen.findByText(/Noch keine Dateiquelle eingebunden/)).toBeInTheDocument();
    expect(screen.getByText(/Die PL bindet Quellen unter Einstellungen › Dateien ein/)).toBeInTheDocument();
    unmount();
    renderAt('/projekte/p1/doku/dateien/b9');
    expect(await screen.findByText(/Ordner nicht gefunden: die Einbindung wurde entfernt/)).toBeInTheDocument();
  });

  it('Quelle beim letzten Abgleich nicht erreichbar: Hinweis über der Liste', async () => {
    const bad = { ...root, lastError: 'HTTP 502 Bad Gateway' };
    get.mockImplementation(async (url: string) => url === '/projects/p1/docs' ? { folders: [], pages: [], templates: [] } : url.startsWith('/projects/p1/files') ? { binding: url.includes('binding') ? bad : null, path: '/', parent: null, roots: [bad], entries: [] } : {});
    renderAt('/projekte/p1/doku/dateien/b1');
    expect(await screen.findByText(/Quelle nicht erreichbar beim letzten Abgleich: HTTP 502 Bad Gateway/)).toBeInTheDocument();
    expect(screen.getByText('Dieser Ordner ist leer.')).toBeInTheDocument();
  });
});

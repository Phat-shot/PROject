import '@testing-library/jest-dom/vitest';
import { createContext } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Notification, User } from '@projekttool/shared';

const get = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), patch: vi.fn(), post: vi.fn() }, fmtDateTime: (d: string) => d }));
vi.mock('../lib/useAi', () => ({ useAiStatus: () => null }));
vi.mock('../lib/useChatUnread', () => ({ useChatUnread: () => ({ total: 0, reload: vi.fn() }) }));
vi.mock('../lib/useMedia', () => ({ useIsMobile: () => false }));
vi.mock('./Tour', () => ({ Tour: () => null, tourDone: () => true }));
vi.mock('./Messenger', () => ({ Messenger: () => null, MessengerCtx: createContext(() => undefined), useOpenChat: () => vi.fn() }));
const openNotification = vi.fn(async () => undefined);
vi.mock('./Notifications', async (importOriginal) => ({ ...(await importOriginal<typeof import('./Notifications')>()), useOpenNotification: () => openNotification }));
let user: Partial<User> = {};
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user, orgName: 'Demo', logout: vi.fn(), setUser: vi.fn() }) }));
import { Layout, TopBar } from './Layout';

const base: Partial<User> = { id: 'u1', name: 'Lea Reuter', email: 'lea@demo.local', globalRole: 'user', orgRights: [], active: true, kind: 'person' };
const note: Notification = { id: 'n1', projectId: 'p1', type: 'task.due_soon', event: 'due', title: 'Bald fällig: Angebot prüfen', body: null, link: '/projekte/p1/board?task=t1', readAt: null, createdAt: '2026-10-18T10:00:00Z' };
const renderAs = (u: Partial<User>) => { user = { ...base, ...u }; return render(<MemoryRouter initialEntries={['/dashboard']}><Layout><div /></Layout></MemoryRouter>); };

beforeEach(() => {
  user = {};
  get.mockReset();
  openNotification.mockClear();
  get.mockImplementation(async (url: string) => url === '/projects' ? { projects: [{ id: 'p1', key: 'WEB', name: 'Website', status: 'active' }] } : url.startsWith('/notifications') ? { notifications: [note], unread: 1 } : {});
});

describe('Seitenleiste: Menüpunkt Verwaltung', () => {
  it('sehen Org-Admin, Org-Rechte KI, Gruppen und Ressourcen sowie Verwalter einer Gruppe', () => {
    for (const u of [{ globalRole: 'org_admin' as const }, { orgRights: ['ai_admin' as const] }, { orgRights: ['groups_admin' as const] }, { orgRights: ['resources_admin' as const] }, { managesGroups: true }]) {
      const { unmount } = renderAs(u);
      expect(screen.getByRole('link', { name: 'Verwaltung' }), JSON.stringify(u)).toHaveAttribute('href', '/verwaltung');
      unmount();
    }
  });

  it('nicht ohne Recht', () => {
    for (const u of [{}, { managesGroups: false }]) {
      const { unmount } = renderAs(u);
      expect(screen.queryByRole('link', { name: 'Verwaltung' }), JSON.stringify(u)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('Glocke (Kopfzeile)', () => {
  it('Filter Klasse, nur ungelesene und Projekt gehen als Abfrage an /notifications; Klick öffnet die Meldung über openNotification', async () => {
    render(<MemoryRouter><TopBar title="Dashboard" /></MemoryRouter>);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/notifications'));
    fireEvent.click(screen.getByRole('button', { name: 'Benachrichtigungen' }));
    expect(await screen.findByText('Bald fällig: Angebot prüfen')).toBeInTheDocument();
    expect(screen.getByText(/^Fälligkeit · /)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Klasse'), { target: { value: 'due' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/notifications?event=due'));
    fireEvent.click(screen.getByLabelText('nur ungelesene'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/notifications?event=due&unread=1'));
    const project = screen.getByLabelText('Projekt');
    await waitFor(() => expect(screen.getByRole('option', { name: 'WEB' })).toBeInTheDocument());
    fireEvent.change(project, { target: { value: 'p1' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/notifications?event=due&projectId=p1&unread=1'));
    fireEvent.click(screen.getByText('Bald fällig: Angebot prüfen'));
    await waitFor(() => expect(openNotification).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1', event: 'due' })));
    expect(screen.queryByLabelText('Klasse')).toBeNull();
  });
});

describe('Seitenleiste: Doku des geöffneten Projekts', () => {
  it('zeigt eingebundene Dateiquellen unter „Dateien“ als eigene Ordner', async () => {
    const pid = '11111111-1111-1111-1111-111111111111';
    user = { ...base };
    get.mockImplementation(async (url: string) => url === '/projects' ? { projects: [{ id: pid, key: 'BAU', name: 'Halle 3', status: 'active' }] }
      : url === `/projects/${pid}/docs` ? { folders: [], pages: [] }
      : url === `/projects/${pid}/files` ? { binding: null, path: '/', parent: null, roots: [{ bindingId: 'b1', sourceId: 's1', label: 'Pläne Halle 3', sourceName: 'Firmen-Nextcloud', kind: 'webdav', scope: 'org', subPath: null, lastSyncAt: null, lastError: null }], entries: [] }
      : url.startsWith('/notifications') ? { notifications: [], unread: 0 } : {});
    render(<MemoryRouter initialEntries={[`/projekte/${pid}/board`]}><Layout><div /></Layout></MemoryRouter>);
    const link = await screen.findByRole('link', { name: /Pläne Halle 3/ });
    expect(link).toHaveAttribute('href', `/projekte/${pid}/doku/dateien/b1`);
    expect(screen.getByText('Dateien')).toHaveClass('proj-sub-h');
  });
});

import '@testing-library/jest-dom/vitest';
import { createContext } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@projekttool/shared';

vi.mock('../lib/api', () => ({ api: { get: vi.fn(async (url: string) => (url === '/projects' ? { projects: [] } : {})), patch: vi.fn(), post: vi.fn() } }));
vi.mock('../lib/useAi', () => ({ useAiStatus: () => null }));
vi.mock('../lib/useChatUnread', () => ({ useChatUnread: () => ({ total: 0, reload: vi.fn() }) }));
vi.mock('../lib/useMedia', () => ({ useIsMobile: () => false }));
vi.mock('./Tour', () => ({ Tour: () => null, tourDone: () => true }));
vi.mock('./Messenger', () => ({ Messenger: () => null, MessengerCtx: createContext(() => undefined) }));
vi.mock('./Notifications', () => ({ useOpenNotification: () => vi.fn() }));
let user: Partial<User> = {};
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user, orgName: 'Demo', logout: vi.fn(), setUser: vi.fn() }) }));
import { Layout } from './Layout';

const base: Partial<User> = { id: 'u1', name: 'Lea Reuter', email: 'lea@demo.local', globalRole: 'user', orgRights: [], active: true, kind: 'person' };
const renderAs = (u: Partial<User>) => { user = { ...base, ...u }; return render(<MemoryRouter initialEntries={['/dashboard']}><Layout><div /></Layout></MemoryRouter>); };

describe('Seitenleiste: Menüpunkt Verwaltung', () => {
  beforeEach(() => { user = {}; });

  it('sehen Org-Admin, Org-Rechte KI und Gruppen sowie Verwalter einer Gruppe', () => {
    for (const u of [{ globalRole: 'org_admin' as const }, { orgRights: ['ai_admin' as const] }, { orgRights: ['groups_admin' as const] }, { managesGroups: true }]) {
      const { unmount } = renderAs(u);
      expect(screen.getByRole('link', { name: 'Verwaltung' }), JSON.stringify(u)).toHaveAttribute('href', '/verwaltung');
      unmount();
    }
  });

  it('nicht ohne Recht (Pool-Ressourcen haben noch keine Karte)', () => {
    for (const u of [{}, { managesGroups: false }, { orgRights: ['resources_admin' as const] }]) {
      const { unmount } = renderAs(u);
      expect(screen.queryByRole('link', { name: 'Verwaltung' }), JSON.stringify(u)).not.toBeInTheDocument();
      unmount();
    }
  });
});

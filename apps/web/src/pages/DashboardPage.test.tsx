import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

const get = vi.fn();
const post = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn() }, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-10-18' }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' }, timeTracking: false }) }));
vi.mock('../components/Messenger', () => ({ useOpenChat: () => vi.fn() }));
// Kopfzeile (mit eigener Glocke) und die anderen Reiter spielen hier keine Rolle
vi.mock('../components/Layout', () => ({ TopBar: ({ title }: { title: ReactNode }) => <h1>{title}</h1> }));
vi.mock('./PortfolioPage', () => ({ PortfolioView: () => null }));
vi.mock('./AllTasksPage', () => ({ AllTasksView: () => null }));
vi.mock('./ProjectPage', () => ({ ProjectScope: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./project/OverviewView', () => ({ OverviewView: () => null }));
import { DashboardPage } from './DashboardPage';

describe('Dashboard: Meldungen', () => {
  let read = false;
  beforeEach(() => {
    read = false;
    get.mockReset();
    post.mockReset();
    post.mockImplementation(async (url: string) => { if (url === '/notifications/read') read = true; return { ok: true }; });
    get.mockImplementation(async (url: string) => {
      if (url === '/notifications') return { notifications: [{ id: 'n1', projectId: 'p1', type: 'task.comment', title: 'Kommentar zu „Angebot“', body: null, link: '/projekte/p1/board?task=t1', readAt: read ? '2026-10-18T11:00:00Z' : null, createdAt: '2026-10-18T10:00:00Z' }], unread: read ? 0 : 1 };
      if (url === '/my/waiting') return { drafts: [], pagesInReview: [], tasks: [] };
      return { projects: [] };
    });
  });

  it('Klick auf eine Meldung markiert sie als gelesen, lädt die Liste neu und öffnet das Ziel', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/projekte/p1/board" element={<div>Board geöffnet</div>} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('1 neu')).toBeInTheDocument();
    const calls = () => get.mock.calls.filter(([u]) => u === '/notifications').length;
    const before = calls();
    fireEvent.click(screen.getByText('Kommentar zu „Angebot“'));
    expect(await screen.findByText('Board geöffnet')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/notifications/read', { ids: ['n1'] });
    await waitFor(() => expect(calls()).toBeGreaterThan(before));
  });
});

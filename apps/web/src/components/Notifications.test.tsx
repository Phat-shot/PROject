import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Notification } from '@projekttool/shared';

const post = vi.fn();
vi.mock('../lib/api', () => ({ api: { post: (...a: unknown[]) => post(...a) }, fmtDateTime: (d: string) => d }));
const openChat = vi.fn();
vi.mock('./Messenger', () => ({ useOpenChat: () => openChat }));
import { NotificationRow } from './Notifications';

const note = (x: Partial<Notification> = {}): Notification => ({ id: 'n1', projectId: 'p1', type: 'task.comment', title: 'Kommentar zu „Angebot“', body: null, link: '/projekte/p1/board?task=t1', readAt: null, createdAt: '2026-10-18T10:00:00Z', ...x });

describe('Meldungen im Dashboard', () => {
  beforeEach(() => { post.mockReset(); post.mockResolvedValue({ ok: true }); openChat.mockReset(); });

  it('Klick markiert die Meldung als gelesen und öffnet das Ziel', async () => {
    const onOpened = vi.fn();
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<NotificationRow n={note()} onOpened={onOpened} />} />
          <Route path="/projekte/p1/board" element={<div>Board geöffnet</div>} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText('Kommentar zu „Angebot“'));
    expect(await screen.findByText('Board geöffnet')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/notifications/read', { ids: ['n1'] });
    expect(onOpened).toHaveBeenCalled();
  });

  it('Chat-Links öffnen den Messenger mit Thread; schon gelesene werden nicht erneut markiert', async () => {
    const c = '11111111-1111-4111-8111-111111111111';
    const th = '22222222-2222-4222-8222-222222222222';
    render(<MemoryRouter><NotificationRow n={note({ link: `/chat/${c}?thread=${th}`, readAt: '2026-10-18T11:00:00Z' })} /></MemoryRouter>);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    await waitFor(() => expect(openChat).toHaveBeenCalledWith(c, th, null));
    expect(post).not.toHaveBeenCalled();
  });

  it('Chat-Bezug ohne Chat-Link öffnet den Kanal im Messenger', async () => {
    const c = '33333333-3333-4333-8333-333333333333';
    render(<MemoryRouter><NotificationRow n={note({ link: null, ref: { type: 'chat_channel', id: c }, readAt: '2026-10-18T11:00:00Z' })} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(openChat).toHaveBeenCalledWith(c, null));
  });

  it('zeigt die Ereignisklasse als Präfix, bei Information keines', () => {
    const { unmount } = render(<MemoryRouter><NotificationRow n={note({ event: 'escalation' })} /></MemoryRouter>);
    expect(screen.getByText('Eskalation · 2026-10-18T10:00:00Z')).toBeInTheDocument();
    unmount();
    render(<MemoryRouter><NotificationRow n={note({ event: 'info' })} /></MemoryRouter>);
    expect(screen.getByText('2026-10-18T10:00:00Z')).toBeInTheDocument();
    expect(screen.queryByText(/Information/)).toBeNull();
  });
});

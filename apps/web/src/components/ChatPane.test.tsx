import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const get = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn(), del: vi.fn() }, fmtDateTime: (d: string) => d }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
import { ChatPane } from './ChatPane';

const base = '/chat/channels/c1/messages';
const msg = (id: string, body: string, threadId: string | null = null) => ({ id, channelId: 'c1', userId: 'u2', userName: 'Petra Lenz', threadId, body, mentions: [], replyCount: 0, lastReplyAt: null, createdAt: '2026-10-18T10:00:00Z', editedAt: null, deleted: false });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('ChatPane', () => {
  let canWrite = true;
  beforeEach(() => {
    vi.useFakeTimers();
    canWrite = true;
    get.mockReset();
    get.mockImplementation(async (url: string) => (url.includes('?thread=') ? { messages: [msg('r1', 'Antwort im Thread', 'm1')], hasMore: false } : { messages: [msg('m1', 'Stand zum Angebot?')], hasMore: false, canWrite }));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('holt alle 5 s auch die Antworten des gerade geöffneten Threads, nach dem Schließen nicht mehr', async () => {
    render(<ChatPane channelId="c1" members={[]} />);
    await flush();
    expect(screen.getByText('Stand zum Angebot?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Antworten' }));
    await flush();
    expect(screen.getByText('Antwort im Thread')).toBeInTheDocument();
    get.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(get).toHaveBeenCalledWith(base);
    expect(get).toHaveBeenCalledWith(`${base}?thread=m1`);
    // Thread schließen: das Intervall fragt nur noch den Kanal ab
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    await flush();
    get.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(get).toHaveBeenCalledWith(base);
    expect(get).not.toHaveBeenCalledWith(`${base}?thread=m1`);
  });

  it('zeigt impliziten Lesern im Projektkanal statt der Eingabe einen Hinweis', async () => {
    canWrite = false;
    render(<ChatPane channelId="c1" members={[]} />);
    await flush();
    expect(screen.getByText(/schreiben nur Mitglieder des Projekts; du liest mit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Senden' })).not.toBeInTheDocument();
  });
});

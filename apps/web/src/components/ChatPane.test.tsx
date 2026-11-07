import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), del: vi.fn() }, fmtDateTime: (d: string) => d }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
import { MemoryRouter } from 'react-router-dom';
import { ChatPane } from './ChatPane';
import { resetProjectKeys } from './MentionInput';

const base = '/chat/channels/c1/messages';
const msg = (id: string, body: string, threadId: string | null = null) => ({ id, channelId: 'c1', userId: 'u2', userName: 'Petra Lenz', threadId, body, mentions: [], replyCount: 0, lastReplyAt: null, createdAt: '2026-10-18T10:00:00Z', editedAt: null, deleted: false });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('ChatPane', () => {
  let canWrite = true;
  beforeEach(() => {
    vi.useFakeTimers();
    canWrite = true;
    get.mockReset(); post.mockReset(); post.mockResolvedValue({});
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
    // Thread zuklappen (er steht direkt unter der Nachricht): das Intervall fragt nur noch den Kanal ab
    fireEvent.click(screen.getByRole('button', { expanded: true }));
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

  it('Rückfrage-Karte (choices): Knöpfe als Gruppe, Klick sendet den Wert als Nachricht; gewählt bleibt sichtbar und gesperrt', async () => {
    const choices = [{ label: 'Projekt WEB – Website-Relaunch', value: 'Projekt WEB' }, { label: 'Allgemein (kein Projekt)', value: 'allgemein', hint: 'Wissensfrage' }];
    const card = (chosen?: string) => ({ ...msg('s1', 'Thema wählen:'), userId: null, userName: 'System', kind: 'system' as const, meta: { card: 'choices' as const, choices, forMessageId: 'm1', ...(chosen ? { chosen } : {}) } });
    get.mockImplementation(async () => ({ messages: [msg('m1', 'Was meinst du dazu?'), card()], hasMore: false }));
    render(<ChatPane channelId="c1" members={[]} />);
    await flush();
    const group = screen.getByRole('group', { name: 'Rückfrage: Thema wählen' });
    expect(group).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Projekt WEB – Website-Relaunch' });
    expect(btn).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Allgemein (kein Projekt)' })).toHaveAttribute('title', 'Wissensfrage');
    // Klick sendet den Wert über den normalen Sendepfad in den Kanal (kein Thread) und lädt neu
    get.mockImplementation(async () => ({ messages: [msg('m1', 'Was meinst du dazu?'), card('Projekt WEB')], hasMore: false }));
    fireEvent.click(btn);
    await flush();
    expect(post).toHaveBeenCalledWith(base, { body: 'Projekt WEB', threadId: null });
    const chosenBtn = screen.getByRole('button', { name: 'Projekt WEB – Website-Relaunch' });
    expect(chosenBtn).toBeDisabled();
    expect(chosenBtn.className).toContain('primary');
    expect(screen.getByRole('button', { name: 'Allgemein (kein Projekt)' })).toBeDisabled();
  });

  it('zeigt bei ausstehender Agentenantwort nur den Spinner ohne sichtbaren Text; Screenreader hören „Morton denkt nach“', async () => {
    get.mockImplementation(async () => ({ messages: [msg('m1', 'Hi Morton, was steht an?')], hasMore: false, canWrite: true, busy: [{ id: 'a1', name: 'Morton' }] }));
    const { container } = render(<ChatPane channelId="c1" members={[]} />);
    await flush();
    const status = screen.getByRole('status', { name: 'Morton denkt nach' });
    expect(status.textContent).toBe('');
    expect(status.querySelector('.spinner')).not.toBeNull();
    expect(status.querySelector('svg.chat-busy-still')).not.toBeNull();
    expect(container.querySelectorAll('.chat-busy')).toHaveLength(1);
  });

  it('mehrere Agenten: ein Spinner, aria-label mit allen Namen', async () => {
    get.mockImplementation(async () => ({ messages: [msg('m1', 'Status?')], hasMore: false, canWrite: true, busy: [{ id: 'a1', name: 'Morton' }, { id: 'a2', name: 'Jarvis' }] }));
    const { container } = render(<ChatPane channelId="c1" members={[]} />);
    await flush();
    expect(screen.getByRole('status', { name: 'Morton, Jarvis denken nach' }).textContent).toBe('');
    expect(container.querySelectorAll('.chat-busy .spinner')).toHaveLength(1);
  });

  it('Aufgabenkarte (tasks): nummerierte Liste mit Link, „Übernehmen“ sendet die Nummer, danach „übernommen“; gesperrt mit Grund', async () => {
    const items = [
      { n: 1, ref: 'WEB-12', taskId: 't12', projectId: 'p1', title: 'Angebot prüfen', due: '2026-11-06', status: 'Offen', canTake: true },
      { n: 2, ref: 'WEB-14', taskId: 't14', projectId: 'p1', title: 'Logo', due: null, status: 'Offen', canTake: false, reason: 'schon bei Morton' }
    ];
    const card = { ...msg('s1', 'Aufgaben aus der Antwort:'), userId: null, userName: 'System', kind: 'system' as const, meta: { card: 'tasks' as const, items, agentId: 'a1' } };
    get.mockImplementation(async (url: string) => (url === '/projects' ? { projects: [{ key: 'WEB' }] } : { messages: [{ ...msg('m1', 'Überfällig ist das Angebot (WEB-12).'), userId: 'a1', userName: 'Morton' }, card], hasMore: false, canWrite: true }));
    post.mockResolvedValue({ items: [{ ...items[0], taken: true, canTake: false }, items[1]] });
    resetProjectKeys();
    render(<MemoryRouter><ChatPane channelId="c1" members={[]} /></MemoryRouter>);
    await flush();
    // Kennung im Agententext wird zum Link (Projekt der Person)
    expect(screen.getAllByRole('link', { name: 'WEB-12' }).map((a) => a.getAttribute('href'))).toEqual(['/k/WEB-12', '/projekte/p1/board?task=t12']);
    const list = screen.getByRole('list');
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'WEB-14' })).toHaveAttribute('href', '/projekte/p1/board?task=t14');
    const buttons = screen.getAllByRole('button', { name: 'Übernehmen' });
    expect(buttons[1]).toBeDisabled();
    expect(buttons[1]).toHaveAttribute('title', 'schon bei Morton');
    fireEvent.click(buttons[0]);
    await flush();
    expect(post).toHaveBeenCalledWith('/chat/messages/s1/take', { items: [1] });
    expect(screen.getByText('übernommen')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Übernehmen' })).toHaveLength(1);
  });
});

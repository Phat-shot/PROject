import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-11-06' }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u0', globalRole: 'org_admin' }, timeTracking: true, refresh: vi.fn() }) }));
const aiStatus = { enabled: true, profiles: [{ id: 'pr1', name: 'Qwen', provider: 'local', model: 'qwen', baseUrl: 'http://x/v1', hasKey: false, active: true, thinkingOff: false, projectScope: 'all', projectIds: [], personalUse: 'none', personalUserIds: [] }], agentDailyBudget: 50, models: [] };
vi.mock('../lib/useAi', () => ({ invalidateAi: vi.fn(async () => undefined), useAiStatus: () => aiStatus }));
vi.mock('../components/RichEditor', () => ({ RichEditor: () => null }));
vi.mock('./PortfolioPage', () => ({ HealthDialog: () => null }));
let project: Record<string, unknown> = {};
const reload = vi.fn(async () => undefined);
vi.mock('./ProjectPage', () => ({ useProjectOptional: () => null, useProject: () => ({ detail: { project: { id: 'p1', key: 'PER1', name: 'Persönlich – Alex', myMembership: { role: 'pl' }, visibility: 'members', timeTrackingEnabled: false, ...project }, members: [], columns: [], subprojects: [], milestones: [], labels: [] }, users: [], reload, tasks: [], reloadTasks: vi.fn(), ai: null }) }));
import { InvitationsCard } from './admin/People';
import { AcceptInvitePage } from './AcceptInvitePage';
import { LlmsCard } from './admin/Ai';
import { AssistantCard } from './project/settings/Ai';
import { GeneralTab } from './project/settings/General';

const wrap = (n: ReactNode) => render(<MemoryRouter>{n}</MemoryRouter>);

beforeEach(() => { get.mockReset(); post.mockReset(); patch.mockReset(); reload.mockClear(); project = { personal: true }; });

describe('Einladung mit persönlichem Projekt', () => {
  it('Haken ist an und sendet personalProject; Liste zeigt „persönlich“', async () => {
    get.mockResolvedValue({ invitations: [{ id: 'i1', email: 'a@x.de', name: 'Anna', globalRole: 'user', personalProject: true, createdAt: '', expiresAt: '', sentAt: null, sendError: null, acceptedAt: null, link: 'l' }], hasOrgAccount: true });
    post.mockResolvedValue({ invitation: { email: 'b@x.de', link: 'l' }, sent: true });
    wrap(<InvitationsCard onAccepted={() => undefined} />);
    const row = (await screen.findByText('Anna')).closest('tr')!;
    expect(within(row).getByText('persönlich')).toBeInTheDocument();
    const box = screen.getByLabelText(/Persönliches Projekt freigeben \(Assistent\)/);
    expect(box).toBeChecked();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ben' } });
    fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'b@x.de' } });
    fireEvent.click(screen.getByRole('button', { name: 'Einladen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/invitations', { email: 'b@x.de', name: 'Ben', globalRole: 'user', personalProject: true }));
    fireEvent.click(box);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cem' } });
    fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'c@x.de' } });
    fireEvent.click(screen.getByRole('button', { name: 'Einladen' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/invitations', { email: 'c@x.de', name: 'Cem', globalRole: 'user', personalProject: false }));
  });
});

describe('Einladung annehmen', () => {
  it('zeigt den Hinweis und leitet ins persönliche Projekt', async () => {
    get.mockResolvedValue({ email: 'a@x.de', name: 'Anna', orgName: 'Demo', personalProject: true });
    post.mockResolvedValue({ user: {}, personalProjectId: 'pp1' });
    const navigate = vi.fn();
    render(<AcceptInvitePage token="t1" navigate={navigate} />);
    expect(await screen.findByText(/Du bekommst ein persönliches Projekt mit Assistent-Möglichkeit/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Passwort \(/), { target: { value: 'geheim12345' } });
    fireEvent.change(screen.getByLabelText('Passwort wiederholen'), { target: { value: 'geheim12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen und anmelden' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/projekte/pp1/board'));
    expect(post).toHaveBeenCalledWith('/invitations/accept/t1', { name: 'Anna', password: 'geheim12345' });
  });
});

describe('Verwaltung › KI: Freigabe für persönliche Projekte', () => {
  it('Select „bestimmte Personen“ mit Personenauswahl speichert personalUse und personalUserIds', async () => {
    get.mockImplementation(async (url: string) => url === '/users' ? { users: [{ id: 'u1', name: 'Max Keller', email: 'max@x.de', active: true, kind: 'person' }, { id: 'a1', name: 'Bot', email: 'b@agent.local', active: true, kind: 'agent' }] } : url === '/agents' ? { agents: [] } : { projects: [] });
    patch.mockResolvedValue({});
    wrap(<LlmsCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Bearbeiten' }));
    expect(screen.getByText(/Mandanten-LLMs sind für persönliche Projekte standardmäßig gesperrt/)).toBeInTheDocument();
    const sel = screen.getByLabelText('Für persönliche Projekte');
    expect(sel).toHaveValue('none');
    fireEvent.change(sel, { target: { value: 'users' } });
    await screen.findByLabelText('Person Max Keller');
    expect(screen.queryByLabelText('Person Bot')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Person Max Keller'));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/ai/profiles/pr1');
    expect(patch.mock.calls[0][1]).toMatchObject({ personalUse: 'users', personalUserIds: ['u1'] });
  });
});

describe('Projekt › Einstellungen › KI: Dein Assistent', () => {
  const profiles = [{ id: 'own1', name: 'Meine 3090', provider: 'local', model: 'qwen', own: true }, { id: 'org1', name: 'Claude', provider: 'anthropic', model: 'sonnet', own: false }];
  it('ohne Assistent: Formular mit LLM-Kennzeichnung, POST legt an', async () => {
    get.mockResolvedValue({ assistant: null, profiles, blocked: [], canCreate: true });
    post.mockResolvedValue({});
    wrap(<AssistantCard />);
    expect(await screen.findByDisplayValue('Assistent')).toBeInTheDocument();
    const opts = within(screen.getByLabelText('LLM')).getAllByRole('option').map((o) => o.textContent);
    expect(opts[0]).toContain('eigenes LLM');
    expect(opts[1]).toContain('Mandant');
    fireEvent.change(screen.getByLabelText('LLM'), { target: { value: 'org1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assistent anlegen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/p1/assistant', { name: 'Assistent', profileId: 'org1', persona: null }));
  });
  it('ohne freies LLM: Gründe und Hinweis, kein Formular', async () => {
    get.mockResolvedValue({ assistant: null, profiles: [], blocked: ['Kein LLM frei'], canCreate: false });
    wrap(<AssistantCard />);
    expect(await screen.findByText('Kein LLM frei')).toBeInTheDocument();
    expect(screen.getByText(/den Admin um Freigabe/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assistent anlegen' })).not.toBeInTheDocument();
  });
  it('mit Assistent: Chat-Link, Pausieren', async () => {
    get.mockResolvedValue({ assistant: { id: 'ag1', name: 'Kai', persona: null, active: true, aiProfileId: 'own1', profileName: 'Meine 3090', dailyBudget: null, channelId: 'ch1' }, profiles, blocked: [], canCreate: false });
    patch.mockResolvedValue({});
    wrap(<AssistantCard />);
    expect(await screen.findByRole('link', { name: 'Chat öffnen' })).toHaveAttribute('href', '/chat/ch1');
    fireEvent.click(screen.getByRole('button', { name: 'Pausieren' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/agents/ag1', { active: false }));
  });
});

describe('Schlankes persönliches Projekt', () => {
  it('Schalter „Alle Bereiche anzeigen“ speichert showAllTabs', async () => {
    patch.mockResolvedValue({});
    wrap(<GeneralTab />);
    fireEvent.click(screen.getByLabelText(/Alle Bereiche anzeigen/));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1', { showAllTabs: true }));
  });
  it('kein Schalter im normalen Projekt', () => {
    project = { personal: false };
    wrap(<GeneralTab />);
    expect(screen.queryByLabelText(/Alle Bereiche anzeigen/)).not.toBeInTheDocument();
  });
});

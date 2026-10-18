import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const put = vi.fn();
const reload = vi.fn(async () => undefined);
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: (...a: unknown[]) => put(...a), patch: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-10-18' }));
let role = 'pl';
const profile = { name: 'Neubau Firmensitz', address: 'Hafenstraße 1', access: 'Tor 3', contacts: [{ name: 'Bauleitung Nord', email: 'bauleitung@firma.example', role: 'Bauleitung' }] };
vi.mock('../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', myMembership: { role }, externalProfile: profile } }, reload }), useProjectOptional: () => null }));
vi.mock('../../lib/useAi', () => ({ useAiStatus: () => ({ externalGuard: 'strict' }), invalidateAi: vi.fn(), aiBlocked: () => undefined }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ timeTracking: false, user: { id: 'u1' } }) }));
vi.mock('../../components/RichEditor', () => ({ RichEditor: () => null }));
vi.mock('./MailAi', () => ({ MailAiBox: () => null, AiFolderDialog: () => null }));
import { ExternalCard } from './MembersView';

const renderCard = () => render(<MemoryRouter><ExternalCard /></MemoryRouter>);

describe('Projekteinstellungen: Außenkommunikation', () => {
  beforeEach(() => { put.mockReset(); put.mockResolvedValue({}); reload.mockClear(); role = 'pl'; });

  it('PL pflegt das externe Profil mit Ansprechpartnern', async () => {
    renderCard();
    expect(screen.getByText('neu formulieren und prüfen')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Name nach außen/), { target: { value: 'Neubau Nord' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ansprechpartner hinzufügen' }));
    const names = screen.getAllByPlaceholderText('Name');
    fireEvent.change(names[1], { target: { value: 'Empfang' } });
    fireEvent.change(screen.getAllByPlaceholderText('Mail')[1], { target: { value: 'empfang@firma.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/projects/p1/external-profile', {
      name: 'Neubau Nord', address: 'Hafenstraße 1', access: 'Tor 3',
      contacts: [{ name: 'Bauleitung Nord', email: 'bauleitung@firma.example', role: 'Bauleitung' }, { name: 'Empfang', email: 'empfang@firma.example', role: '' }]
    }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('Mitglieder sehen das Profil nur lesend', () => {
    role = 'member';
    renderCard();
    expect(screen.getByText('Bauleitung Nord (Bauleitung) <bauleitung@firma.example>')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Speichern' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

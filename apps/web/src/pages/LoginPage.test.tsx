import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const post = vi.fn();
const get = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
const login = vi.fn();
vi.mock('../lib/auth', () => ({ useAuth: () => ({ login, loginTotp: vi.fn() }) }));
import { LoginPage } from './LoginPage';

describe('Anmeldeseite', () => {
  beforeEach(() => { post.mockReset(); get.mockReset(); login.mockReset(); });
  it('zeigt Demo-Zugänge nur, wenn Demodaten existieren', async () => {
    get.mockResolvedValue({ demo: false });
    render(<LoginPage />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/setup/status'));
    expect(screen.queryByText(/Demo-Zugänge/)).not.toBeInTheDocument();
    expect((screen.getByLabelText('E-Mail') as HTMLInputElement).value).toBe('');
  });
  it('„Passwort vergessen“ fordert einen Link an', async () => {
    get.mockResolvedValue({ demo: false });
    post.mockResolvedValue({ sent: true });
    render(<LoginPage />);
    fireEvent.click(screen.getByText('Passwort vergessen?'));
    fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'ph@srz.one' } });
    fireEvent.click(screen.getByText('Link anfordern'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/forgot', { email: 'ph@srz.one' }));
    expect(await screen.findByText(/ist ein Link unterwegs/)).toBeInTheDocument();
  });
  it('verlangt den zweiten Faktor, wenn die Anmeldung ihn meldet', async () => {
    get.mockResolvedValue({ demo: false });
    login.mockResolvedValue({ mfaRequired: true, challenge: 'c1' });
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'a@b.de' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'geheim1234' } });
    fireEvent.click(screen.getByText('Anmelden'));
    expect(await screen.findByLabelText('Code (6 Stellen)')).toBeInTheDocument();
  });
});

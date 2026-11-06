import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../components/Layout', () => ({ TopBar: ({ title }: { title: string }) => <h1>{title}</h1> }));
import { NotFoundPage } from './NotFoundPage';

describe('NotFoundPage', () => {
  it('nennt den Pfad und führt zum Dashboard', () => {
    render(<MemoryRouter initialEntries={['/gibts/nicht']}><NotFoundPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Nicht gefunden' })).toBeInTheDocument();
    expect(screen.getByText('/gibts/nicht')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zum Dashboard' })).toHaveAttribute('href', '/dashboard');
  });

  it('im Projekt: ohne eigene Kopfzeile, Link zum Board', () => {
    render(<MemoryRouter initialEntries={['/projekte/p1/foo']}><NotFoundPage project={{ id: 'p1', name: 'Website' }} withTopBar={false} /></MemoryRouter>);
    expect(screen.queryByRole('heading', { name: 'Nicht gefunden' })).toBeNull();
    expect(screen.getByText(/im Projekt „Website“/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zum Board' })).toHaveAttribute('href', '/projekte/p1/board');
  });
});

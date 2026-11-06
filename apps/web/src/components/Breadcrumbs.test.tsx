import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Breadcrumbs } from './Breadcrumbs';

const items = (onSp: () => void) => [
  { label: 'Website-Relaunch', to: '/projekte/p1/board' },
  { label: 'Konzept', onClick: onSp },
  { label: 'WEB-4 Angebot prüfen', onClick: vi.fn() },
  { label: 'Lizenzen klären' }
];

describe('Breadcrumbs', () => {
  it('Projekt › Teilprojekt › Arbeitspaket › Aufgabe: klickbar, letzte Ebene aria-current', () => {
    const onSp = vi.fn();
    render(<MemoryRouter><Breadcrumbs items={items(onSp)} compact={false} /></MemoryRouter>);
    const nav = screen.getByRole('navigation', { name: 'Brotkrumen' });
    expect(within(nav).getByRole('link', { name: 'Website-Relaunch' })).toHaveAttribute('href', '/projekte/p1/board');
    fireEvent.click(within(nav).getByRole('button', { name: 'Konzept' }));
    expect(onSp).toHaveBeenCalled();
    expect(within(nav).getByText('Lizenzen klären')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getAllByRole('listitem')).toHaveLength(4);
  });

  it('mobil gekürzt: nur die letzten zwei Ebenen und „…“, das aufklappt', () => {
    render(<MemoryRouter><Breadcrumbs items={items(vi.fn())} compact /></MemoryRouter>);
    const nav = screen.getByRole('navigation', { name: 'Brotkrumen' });
    expect(within(nav).queryByText('Website-Relaunch')).toBeNull();
    expect(within(nav).getByText('WEB-4 Angebot prüfen')).toBeInTheDocument();
    const more = within(nav).getByRole('button', { name: /Weitere Ebenen: Website-Relaunch › Konzept/ });
    fireEvent.click(more);
    expect(within(nav).getByRole('link', { name: 'Website-Relaunch' })).toBeInTheDocument();
  });
});

import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock('./Messenger', () => ({ useOpenChat: () => vi.fn() }));
vi.mock('./Notifications', () => ({ NotifIcon: () => null }));
import { OpenForMeList } from './OpenForMe';

describe('Offen für dich: Zeile „Prüfung“', () => {
  it('Arbeitspaket in Prüfung führt in den Drawer des Arbeitspakets', () => {
    render(<MemoryRouter><OpenForMeList questions={[]} projectId={null} waiting={{ drafts: [], pagesInReview: [], tasks: [], tasksInReview: [{ id: 't1', number: 4, title: 'Angebot prüfen', projectId: 'p1', projectKey: 'WEB' }] }} /></MemoryRouter>);
    const link = screen.getByRole('link', { name: /Prüfung.*WEB-4 Angebot prüfen/ });
    expect(link).toHaveAttribute('href', '/projekte/p1/board?task=t1');
  });
});

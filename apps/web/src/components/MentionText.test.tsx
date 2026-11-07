import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const get = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));
import { MentionText, TaskRefRedirect } from './MentionInput';

function Where() { return <div data-testid="where">{useLocation().pathname + useLocation().search}</div>; }

describe('Chat-Text: Erwähnungen und Kennungen', () => {
  it('hebt @Namen hervor, verlinkt WEB-12 auf /k/WEB-12; die Weiterleitung öffnet das Board', async () => {
    get.mockResolvedValue({ tasks: [{ id: 't12', number: 12, projectId: 'p1', projectKey: 'WEB' }] });
    render(<MemoryRouter initialEntries={['/chat']}><Routes><Route path="/k/:ref" element={<TaskRefRedirect />} /><Route path="*" element={<><MentionText text="@Anna bitte WEB-12 prüfen, nicht XWEB-12x" members={[{ userId: 'u1', name: 'Anna' }]} /><Where /></>} /></Routes></MemoryRouter>);
    expect(screen.getByText('@Anna')).toHaveClass('mention');
    expect(screen.getByRole('link', { name: 'WEB-12' })).toHaveAttribute('href', '/k/WEB-12');
    expect(screen.queryAllByRole('link')).toHaveLength(1);
    fireEvent.click(screen.getByText('WEB-12'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/projekte/p1/board?task=t12'));
    expect(get).toHaveBeenCalledWith('/search?q=WEB-12');
  });

  it('mit keys: nur Kennungen aus Projekten der Person werden zu Links', () => {
    render(<MemoryRouter><MentionText text="Siehe WEB-12 (ALT-3 und ERP-4)" members={[]} keys={['WEB', 'ERP']} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'WEB-12' })).toHaveAttribute('href', '/k/WEB-12');
    expect(screen.getByRole('link', { name: 'ERP-4' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'ALT-3' })).not.toBeInTheDocument();
    expect(screen.getByText(/ALT-3 und/)).toBeInTheDocument();
  });

  it('Weiterleitung: unbekannte Kennung zeigt einen Hinweis', async () => {
    get.mockResolvedValue({ tasks: [] });
    render(<MemoryRouter initialEntries={['/k/WEB-99']}><Routes><Route path="/k/:ref" element={<TaskRefRedirect />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/WEB-99 gibt es nicht/)).toBeInTheDocument());
  });
});

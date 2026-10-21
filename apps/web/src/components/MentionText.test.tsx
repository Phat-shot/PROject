import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const get = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));
import { MentionText } from './MentionInput';

function Where() { return <div data-testid="where">{useLocation().pathname + useLocation().search}</div>; }

describe('Chat-Text: Erwähnungen und Kennungen', () => {
  it('hebt @Namen hervor und öffnet WEB-12 im Board', async () => {
    get.mockResolvedValue({ tasks: [{ id: 't12', number: 12, projectId: 'p1', projectKey: 'WEB' }] });
    render(<MemoryRouter initialEntries={['/chat']}><Routes><Route path="*" element={<><MentionText text="@Anna bitte WEB-12 prüfen, nicht XWEB-12x" members={[{ userId: 'u1', name: 'Anna' }]} /><Where /></>} /></Routes></MemoryRouter>);
    expect(screen.getByText('@Anna')).toHaveClass('mention');
    fireEvent.click(screen.getByText('WEB-12'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/projekte/p1/board?task=t12'));
    expect(screen.queryAllByRole('link')).toHaveLength(1);
  });
});

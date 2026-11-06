import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d }));
const reloadTasks = vi.fn(async () => undefined);
vi.mock('../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', key: 'WEB', myMembership: { role: 'member' } } }, reloadTasks }) }));
import { TrashCard } from './TrashCard';
import { DialogProvider, ToastProvider } from '../../components/ui';

describe('Papierkorb: Aufgabe, die Checklistenpunkt wurde', () => {
  beforeEach(() => { get.mockReset(); post.mockReset(); reloadTasks.mockClear(); });

  it('zeigt die Ziel-Aufgabe und meldet nach dem Wiederherstellen, dass der Punkt entfernt wurde', async () => {
    get.mockResolvedValue({ tasks: [{ id: 't3', number: 13, title: 'Fugen', deletedAt: '2026-11-06T10:00:00Z' }], pages: [], purgeAfterDays: 30, demoted: { t3: { number: 15, title: 'Silikon' } } });
    post.mockResolvedValue({ task: { id: 't3' } });
    render(<MemoryRouter><ToastProvider><DialogProvider><TrashCard /></DialogProvider></ToastProvider></MemoryRouter>);
    const row = (await screen.findByText('Fugen')).closest('tr') as HTMLElement;
    expect(within(row).getByText('wurde Checklistenpunkt von WEB-15')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Wiederherstellen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t3/restore'));
    expect(await screen.findByText('„Fugen“ ist wieder eine Aufgabe; der Checklistenpunkt wurde entfernt.')).toBeInTheDocument();
    expect(reloadTasks).toHaveBeenCalled();
  });
});

import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const post = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: (...a: unknown[]) => post(...a), patch: vi.fn(), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d }));
const parent = { id: 't1', number: 9, title: 'Fliesen koordinieren' };
const base = { done: false, archivedAt: null, deletedAt: null, position: 0, parentId: 't1', parent };
const fugen = { ...base, id: 't3', number: 13, title: 'Fugen' };
const silikon = { ...base, id: 't5', number: 15, title: 'Silikon' };
const reloadTasks = vi.fn(async () => undefined);
vi.mock('../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', key: 'WEB' } }, tasks: [{ id: 't1', number: 9, title: 'Fliesen koordinieren', parentId: null }, fugen, silikon], reloadTasks }) }));
import { DEMOTED_TEXT, DemoteDialog } from './MoveDialog';
import { ToastProvider, useToast } from '../../components/ui';

/** Aufrufer wie im TaskDrawer: zeigt nach dem Umwandeln denselben Hinweis (wird vom Toast mit „Rückgängig“ ersetzt). */
function Caller({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  return <DemoteDialog task={fugen as any} onClose={onClose} onDone={() => toast.ok(DEMOTED_TEXT)} />;
}

describe('Aufgabe → Checklistenpunkt: Papierkorb und Rückgängig', () => {
  beforeEach(() => { post.mockReset(); reloadTasks.mockClear(); });

  it('Bestätigungstext nennt den Papierkorb; nach dem Umwandeln ein Toast mit „Rückgängig“, der die Aufgabe wiederherstellt', async () => {
    post.mockImplementation(async (url: string) => url === '/tasks/t3/demote'
      ? { task: { ...silikon, checklistTotal: 1 }, ap: parent, itemId: 'n1', trashedId: 't3' }
      : { task: fugen });
    const onClose = vi.fn();
    render(<ToastProvider><Caller onClose={onClose} /></ToastProvider>);
    expect(screen.getByText(/landet im Papierkorb \(30 Tage\) und ist dort wiederherstellbar/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zu Checklistenpunkt machen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t3/demote', { toTaskId: 't5' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await screen.findAllByText(DEMOTED_TEXT)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t3/restore'));
    await waitFor(() => expect(reloadTasks).toHaveBeenCalled());
    expect(await screen.findByText('„Fugen“ ist wieder eine Aufgabe.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rückgängig' })).toBeNull();
  });

  it('Rückgängig scheitert: Fehlermeldung', async () => {
    post.mockImplementation(async (url: string) => { if (url.endsWith('/restore')) throw new Error('Arbeitspaket nicht gefunden'); return { task: silikon, ap: parent, itemId: 'n1', trashedId: 't3' }; });
    render(<ToastProvider><Caller onClose={() => undefined} /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Zu Checklistenpunkt machen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rückgängig' }));
    expect(await screen.findByText('Rückgängig nicht möglich: Arbeitspaket nicht gefunden')).toBeInTheDocument();
  });
});

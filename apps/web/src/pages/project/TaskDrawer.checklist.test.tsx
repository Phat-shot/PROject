import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDate: (d: string) => d, fmtDateTime: (d: string) => d, today: () => '2026-11-06' }));
const base = { done: false, parentId: null, parent: null, archivedAt: null, deletedAt: null, responsibleUserId: null, responsibleEmail: null, responsible: { userId: null, name: 'Petra Lenz', email: null, inherited: true, inheritedFrom: 'pl' }, blocked: false, blockedReason: null, escalationLevel: 0, conflicts: [], columnId: 'c1', subprojectId: null, priority: 'normal', labelIds: [], startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, mailCode: 'abc', description: '', externalBrief: null, recurrence: null, checklistTotal: 0, checklistDone: 0, checklist: [], subtaskTotal: 0, subtaskDone: 0, agentPaused: false, agentWait: null, agentNextCheckAt: null, position: 0, autoComplete: null, autoDoneAt: null };
const item = (id: string, taskId: string, title: string, done = false) => ({ id, taskId, title, done, responsibleUserId: null, responsibleEmail: null, position: 0 });
const legacy = { ...base, id: 't1', number: 9, title: 'Fliesen koordinieren', checklistTotal: 2, checklistDone: 1, checklist: [item('i1', 't1', 'Maße prüfen', true), item('i2', 't1', 'Fliesen bestellen')] };
const ap = { ...base, id: 't1', number: 9, title: 'Fliesen koordinieren', subtaskTotal: 2 };
const parent = { id: 't1', number: 9, title: 'Fliesen koordinieren' };
const aufgabe = { ...base, id: 't3', number: 13, title: 'Fugen', parentId: 't1', parent, checklistTotal: 2, checklistDone: 1, checklist: [item('j1', 't3', 'Fugenmasse kaufen', true), item('j2', 't3', 'Verfugen')] };
const aufgabeDone = { ...aufgabe, done: true, columnId: 'c9', checklistDone: 2, checklist: [item('j1', 't3', 'Fugenmasse kaufen', true), item('j2', 't3', 'Verfugen', true)], autoDoneAt: '2026-11-06T10:00:00Z' };
const silikon = { ...base, id: 't5', number: 15, title: 'Silikon', parentId: 't1', parent };
let tasks: unknown[] = [];
const reloadTasks = vi.fn(async () => undefined);
const openTask = vi.fn();
vi.mock('../ProjectPage', () => ({
  useProject: () => ({
    detail: { project: { id: 'p1', key: 'WEB', myMembership: { role: 'pl', canEditPlan: true, userId: 'u1' }, mailAddress: null, timeTrackingEnabled: false, autoCompleteParent: true, autoDoneAufgabe: true }, columns: [{ id: 'c1', name: 'Offen', kind: 'active', isDone: false }, { id: 'c9', name: 'Erledigt', kind: 'done', isDone: true }], subprojects: [], members: [{ userId: 'u1', name: 'Petra Lenz' }], labels: [] },
    users: [], tasks, reloadTasks, openTask, ai: null
  }),
  useProjectOptional: () => null
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ timeTracking: false }) }));
vi.mock('../../lib/useData', () => ({ useData: () => ({ data: null, error: null, loading: false, reload: async () => undefined }) }));
vi.mock('../../lib/useContacts', () => ({ useContacts: () => ({ contacts: [] }), contactLabel: (c: { email: string }) => c.email }));
vi.mock('../../lib/useAi', () => ({ aiBlocked: () => undefined, assistChoice: () => ({ fit: [], def: null }) }));
vi.mock('./BoardView', () => ({ LabelPicker: () => null }));
vi.mock('./CopyMove', () => ({ CopyMoveDialog: () => null }));
vi.mock('./TimeView', () => ({ fmtH: (m: number) => String(m) }));
vi.mock('../../components/QuickMail', () => ({ QuickMail: () => null }));
import { TaskDrawer } from './TaskDrawer';
import { ToastProvider } from '../../components/ui';

const renderDrawer = (id = 't1') => render(<MemoryRouter><ToastProvider><TaskDrawer taskId={id} onClose={() => undefined} /></ToastProvider></MemoryRouter>);
const detailOf = (task: unknown, subtasks: unknown[] = []) => ({ task, subtasks, comments: [], mails: [], attachments: [] });

describe('TaskDrawer: Checklisten gehören zu Aufgaben', () => {
  beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); reloadTasks.mockClear(); openTask.mockReset();
    tasks = [ap, aufgabe];
  });

  it('Arbeitspaket ohne Altbestand: kein Eingabefeld für Checklistenpunkte, Hinweis auf Aufgaben', async () => {
    get.mockResolvedValue(detailOf(ap, [aufgabe]));
    renderDrawer();
    expect(await screen.findByText('Checklistenpunkte gehören zu Aufgaben – lege oben eine Aufgabe an.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Neuer Checklistenpunkt')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Checkliste/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'In Aufgabe überführen' })).not.toBeInTheDocument();
  });

  it('Arbeitspaket mit Altbestand: Punkte abhakbar, „In Aufgabe überführen“ sendet convert mit Titel und lädt neu', async () => {
    get.mockResolvedValue(detailOf(legacy));
    patch.mockResolvedValue({ task: legacy });
    post.mockResolvedValue({ task: ap, aufgabe: { ...aufgabe, title: 'Checkliste' } });
    renderDrawer();
    expect(await screen.findByRole('heading', { name: /Checkliste \(Altbestand\)/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Neuer Checklistenpunkt')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('„Fliesen bestellen“ erledigt'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t1/checklist/i2', { done: true }));
    fireEvent.click(screen.getByRole('button', { name: 'In Aufgabe überführen' }));
    const input = await screen.findByLabelText('Titel der neuen Aufgabe');
    expect(input).toHaveValue('Checkliste');
    fireEvent.change(input, { target: { value: 'Fliesen-Schritte' } });
    get.mockClear(); reloadTasks.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Überführen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t1/checklist/convert', { title: 'Fliesen-Schritte' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/tasks/t1'));
    await waitFor(() => expect(reloadTasks).toHaveBeenCalled());
  });

  it('Aufgabe im Arbeitspaket: letzter Punkt abgehakt → Aufgabe, AP und Board neu, Toast und Badge „automatisch erledigt“', async () => {
    let auf: unknown = aufgabe;
    get.mockImplementation(async (url: string) => (url === '/tasks/t3' ? detailOf(auf) : detailOf(ap, [auf])));
    patch.mockImplementation(async () => { auf = aufgabeDone; return { task: aufgabeDone }; });
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: /Fugen/ }));
    fireEvent.click(await screen.findByLabelText('„Verfugen“ erledigt'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t3/checklist/j2', { done: true }));
    expect(await screen.findByText('Aufgabe automatisch erledigt')).toBeInTheDocument();
    await waitFor(() => expect(get.mock.calls.filter((c) => c[0] === '/tasks/t3').length).toBeGreaterThan(1));
    expect(get.mock.calls.filter((c) => c[0] === '/tasks/t1').length).toBeGreaterThan(1);
    expect(reloadTasks).toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByText('automatisch erledigt').length).toBeGreaterThan(0));
  });

  it('Abhaken ohne Erledigung: kein Toast', async () => {
    get.mockImplementation(async (url: string) => (url === '/tasks/t3' ? detailOf(aufgabe) : detailOf(ap, [aufgabe])));
    patch.mockResolvedValue({ task: aufgabe });
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: /Fugen/ }));
    fireEvent.click(await screen.findByLabelText('„Fugenmasse kaufen“ erledigt'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t3/checklist/j1', { done: false }));
    await waitFor(() => expect(reloadTasks).toHaveBeenCalled());
    expect(screen.queryByText('Aufgabe automatisch erledigt')).not.toBeInTheDocument();
  });

  it('Aufgabe ganz: Checkliste mit Eingabe, Schalter „Automatisch erledigt“ für Checklistenpunkte sendet autoComplete', async () => {
    get.mockImplementation(async (url: string) => (url === '/tasks/t3' ? detailOf(aufgabe) : detailOf(ap, [aufgabe])));
    patch.mockResolvedValue({ task: aufgabe });
    post.mockResolvedValue({ task: aufgabe });
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: /Fugen/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Alle Details/ }));
    const input = await screen.findByLabelText('Neuer Checklistenpunkt');
    expect(screen.getByRole('heading', { name: /^Checkliste/ })).not.toHaveTextContent('Altbestand');
    const sel = screen.getByLabelText(/Automatisch erledigt/) as HTMLSelectElement;
    expect(sel.closest('label')).toHaveTextContent('wenn alle Checklistenpunkte erledigt sind');
    expect(within(sel).getByRole('option', { name: 'wie im Projekt (an)' })).toBeInTheDocument();
    fireEvent.change(sel, { target: { value: 'off' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t3', { autoComplete: false }));
    fireEvent.change(input, { target: { value: 'Nachkontrolle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t3/checklist', { title: 'Nachkontrolle' }));
  });

  it('Arbeitspaket: Schalter „Automatisch erledigt“ spricht von Aufgaben', async () => {
    get.mockResolvedValue(detailOf(ap, [aufgabe]));
    renderDrawer();
    const sel = await screen.findByLabelText(/Automatisch erledigt/);
    expect(sel.closest('label')).toHaveTextContent('wenn alle Aufgaben erledigt sind');
  });

  const openDemote = async () => {
    get.mockImplementation(async (url: string) => (url === '/tasks/t3' ? detailOf(aufgabe) : detailOf(ap, [aufgabe])));
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: /Fugen/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Alle Details/ }));
    await screen.findByLabelText('Neuer Checklistenpunkt');
    fireEvent.click(screen.getByRole('button', { name: 'Verschieben …' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Zu Checklistenpunkt machen …' }));
  };

  it('Zu Checklistenpunkt machen: einzige andere Aufgabe vorausgewählt, sendet toTaskId und öffnet die Ziel-Aufgabe', async () => {
    tasks = [ap, aufgabe, silikon];
    post.mockResolvedValue({ task: { ...silikon, checklistTotal: 1 }, ap, itemId: 'n1' });
    await openDemote();
    const list = await screen.findByRole('listbox', { name: 'Ziel-Aufgabe' });
    expect(within(list).getByRole('radio')).toBeChecked();
    expect(screen.getByText(/„Fugen“ wird Checklistenpunkt der Aufgabe „Silikon“/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zu Checklistenpunkt machen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/t3/demote', { toTaskId: 't5' }));
    await waitFor(() => expect(openTask).toHaveBeenCalledWith('t5'));
  });

  it('Zu Checklistenpunkt machen: mehrere Ziele ohne Vorauswahl; ohne andere Aufgabe nicht möglich', async () => {
    tasks = [ap, aufgabe, silikon, { ...silikon, id: 't6', number: 16, title: 'Abnahme' }];
    await openDemote();
    const list = await screen.findByRole('listbox', { name: 'Ziel-Aufgabe' });
    expect(within(list).getAllByRole('radio')).toHaveLength(2);
    expect(within(list).getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect(screen.getByRole('button', { name: 'Zu Checklistenpunkt machen' })).toBeDisabled();
    fireEvent.click(within(list).getByLabelText(/Abnahme/));
    expect(screen.getByText(/wird Checklistenpunkt der Aufgabe „Abnahme“/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zu Checklistenpunkt machen' })).toBeEnabled();
  });

  it('Zu Checklistenpunkt machen ohne andere Aufgabe: Hinweis, Knopf gesperrt', async () => {
    tasks = [ap, aufgabe];
    await openDemote();
    expect(await screen.findByText(/gibt es keine andere Aufgabe/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zu Checklistenpunkt machen' })).toBeDisabled();
  });
});

import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), put: vi.fn(), patch: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDateTime: (d: string) => d }));
vi.mock('../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', key: 'WEB', myMembership: { role: 'pl' } } }, tasks: [{ id: 't1', title: 'Angebot prüfen', responsible: { userId: null, email: null } }] }), useProjectOptional: () => null, ProjectScope: () => null }));
vi.mock('./MailAi', () => ({ MailAiBox: () => null }));
import { Compose, type ViewRow } from './MailView';

const views = [{ id: 'v1', name: 'Projektpostfach', accountAddress: 'projekt-web@demo.local', accountType: 'project', myRights: { canRead: true, canDraft: true, canSend: true, canAi: true, canCreateTask: true } }] as unknown as ViewRow[];
const finding = { kind: 'task', match: 'Wireframes Startseite', text: 'Titel eines anderen Arbeitspakets (WEB-2 „Wireframes Startseite“)' };

describe('Neue Mail: Hinweise der Außenprüfung vor dem Senden', () => {
  beforeEach(() => { get.mockReset(); post.mockReset(); });
  const fill = () => {
    fireEvent.change(screen.getByLabelText('An'), { target: { value: 'k.mueller@mueller-design.de' } });
    fireEvent.change(screen.getByLabelText('Betreff'), { target: { value: 'Stand' } });
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Parallel laufen die Wireframes Startseite.' } });
  };

  it('zeigt Fundstellen, „Trotzdem senden“ sendet ohne Block', async () => {
    post.mockImplementation(async (url: string) => url.endsWith('/outbound-hint') ? { outbound: { audience: 'task_external', result: 'held', findings: [finding] } } : { draft: {} });
    const done = vi.fn();
    render(<MemoryRouter><Compose views={views} onDone={done} /></MemoryRouter>);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Senden' }));
    expect(await screen.findByText(finding.text)).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/projects/p1/outbound-hint', { taskId: null, to: ['k.mueller@mueller-design.de'], cc: [], subject: 'Stand', body: 'Parallel laufen die Wireframes Startseite.' });
    expect(post).not.toHaveBeenCalledWith('/mail/drafts', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Trotzdem senden' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/mail/drafts', expect.objectContaining({ viewId: 'v1', to: ['k.mueller@mueller-design.de'], subject: 'Stand', send: true })));
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it('„Bearbeiten“ blendet die Hinweise aus; ohne Fundstellen geht die Mail direkt', async () => {
    post.mockImplementationOnce(async () => ({ outbound: { audience: 'task_external', result: 'held', findings: [finding] } }));
    const done = vi.fn();
    render(<MemoryRouter><Compose views={views} onDone={done} /></MemoryRouter>);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Senden' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bearbeiten' }));
    expect(screen.queryByText(finding.text)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Wir melden uns bis Freitag.' } });
    post.mockImplementation(async (url: string) => url.endsWith('/outbound-hint') ? { outbound: null } : { draft: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Senden' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/mail/drafts', expect.objectContaining({ body: 'Wir melden uns bis Freitag.', send: true })));
    expect(done).toHaveBeenCalled();
  });
});

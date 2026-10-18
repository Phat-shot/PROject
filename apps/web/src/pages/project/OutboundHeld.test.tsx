import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), put: vi.fn(), patch: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDateTime: (d: string) => d }));
vi.mock('../ProjectPage', () => ({ useProject: () => ({ detail: { project: { id: 'p1', myMembership: { role: 'pl', canFinalize: true } } } }), useProjectOptional: () => null, ProjectScope: () => null }));
vi.mock('./MailAi', () => ({ MailAiBox: () => null }));
import { OutboundHeld } from './MailView';

const check = {
  id: 'c1', projectId: 'p1', taskId: 't1', taskRef: 'WEB-9', taskTitle: 'Fliesen koordinieren', channel: 'mail', recipients: [{ email: 'fliesen@extern.example', audience: 'task_external' }],
  audience: 'task_external', result: 'held', withheld: ['Budget'], mailDraftId: 'd1', decidedBy: null, decidedAt: null, createdAt: '2026-10-18',
  findings: [{ kind: 'ref', match: 'WEB-3', text: 'fremde Kennung WEB-3' }, { kind: 'page', match: 'Statusbericht KW 41', text: 'Titel einer nicht freigegebenen Seite „Statusbericht KW 41“', pageId: 'pg1' }],
  draft: { subject: 'Lieferung', body: 'Die Lieferung hängt an WEB-3.', toAddrs: ['fliesen@extern.example'], ccAddrs: [], userName: 'Außendienst', status: 'pending_approval', pageId: null, pageTitle: null }
};

describe('Mail › Freigaben: Außenprüfung angehalten', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ checks: [check] });
    post.mockResolvedValue({ ok: true });
  });

  it('zeigt Fundstellen und Zurückgehaltenes; „Bearbeiten und senden“ mit Seitenfreigabe', async () => {
    const changed = vi.fn(async () => undefined);
    render(<OutboundHeld onChanged={changed} />);
    expect(await screen.findByText('fremde Kennung WEB-3')).toBeInTheDocument();
    expect(screen.getByText('Zurückgehalten: Budget')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/projects/p1/outbound-checks?result=held');
    fireEvent.click(screen.getByLabelText(/Seite „Statusbericht KW 41“ für fliesen@extern\.example freigeben/));
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten und senden' }));
    expect(screen.queryByRole('button', { name: 'Unverändert senden' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Passt die Lieferung am 12.11.?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Senden' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/outbound-checks/c1/decide', { action: 'edit', subject: 'Lieferung', body: 'Passt die Lieferung am 12.11.?', sharePageIds: ['pg1'] }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it('Ablehnen sendet nichts und gibt keine Seiten frei', async () => {
    render(<OutboundHeld onChanged={async () => undefined} />);
    fireEvent.click(await screen.findByLabelText(/Seite „Statusbericht KW 41“/));
    fireEvent.click(screen.getByRole('button', { name: 'Ablehnen' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/outbound-checks/c1/decide', { action: 'block', sharePageIds: [] }));
  });
});

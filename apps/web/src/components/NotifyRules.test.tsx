import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EffectiveNotifyRule, NotificationRule, NotifyEvent } from '@projekttool/shared';
import { NOTIFY_DEFAULTS, NOTIFY_EVENTS } from '@projekttool/shared';

const get = vi.fn();
const put = vi.fn();
vi.mock('../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a), post: vi.fn(), patch: vi.fn(), del: vi.fn() }, ApiError: class extends Error {}, fmtDateTime: (d: string) => d }));
import { MyNotifyCard, ProjectNotifyCard, ReportWish, RulesMatrix } from './NotifyRules';

/** Aufgelöste Regeln wie vom Server: Code-Standard je Klasse, einzelne Felder überschrieben (Wert, Herkunft, Sperre). */
const eff = (over: Partial<Record<NotifyEvent, { value?: Partial<EffectiveNotifyRule['value']>; origin?: EffectiveNotifyRule['origin']; locked?: EffectiveNotifyRule['locked'] }>> = {}): EffectiveNotifyRule[] =>
  NOTIFY_EVENTS.map((e) => {
    const d = NOTIFY_DEFAULTS[e.key];
    const o = over[e.key] ?? {};
    return { event: e.key, value: { ...d, recipients: [...d.recipients], ...o.value }, origin: { ...Object.fromEntries(Object.keys(d).map((k) => [k, 'code'])), ...o.origin }, locked: { ...o.locked } };
  });
const row = (event: string, x: Partial<NotificationRule> = {}): NotificationRule => ({ id: `r-${event}`, projectId: 'p1', taskId: null, userId: null, event: event as NotifyEvent, recipients: null, channels: {}, timing: {}, locked: [], updatedBy: null, updatedByName: null, updatedAt: '2026-10-18T10:00:00Z', ...x });
const item = (event: string, x: Record<string, unknown> = {}) => ({ event, recipients: null, channels: {}, timing: {}, locked: [], ...x });

describe('Regelmatrix', () => {
  const onSave = vi.fn(async () => undefined);
  beforeEach(() => onSave.mockClear());

  it('Projekt: geerbte Werte mit Herkunft, Sperre der Org deaktiviert das Feld, feste Kanäle; Änderungen gehen als Zeile der Klasse an onSave', () => {
    const data = { rules: [row('decision', { channels: { doc: 'page1' } })], effective: eff({ assigned: { value: { mail: 'now' }, origin: { mail: 'org' }, locked: { mail: 'org' } }, decision: { value: { doc: 'page1' }, origin: { doc: 'project' } } }) };
    render(<RulesMatrix level="project" data={data} canEdit onSave={onSave} />);
    const assignedMail = screen.getByLabelText('assigned mail');
    expect(assignedMail).toBeDisabled();
    expect(within(assignedMail).getByRole('option', { name: 'erbt: sofort (Org)' })).toBeInTheDocument();
    expect(assignedMail.closest('td')).toHaveTextContent('🔒 Org');
    expect(assignedMail.closest('td')!.querySelector('button')).toBeNull();
    expect(within(screen.getByLabelText('due mail')).getByRole('option', { name: 'erbt: Digest (Standard)' })).toBeInTheDocument();
    // Fragearten: der Chat ist die Frage selbst; Chat-Meldungen haben keinen Chat-Kanal
    expect(within(screen.getByText('offene Fragen').closest('tr')!).getByText('Thread (fest)')).toBeInTheDocument();
    expect(screen.queryByLabelText('question chat')).toBeNull();
    expect(within(screen.getByText('Direktnachricht, Erwähnung, Antwort').closest('tr')!).getAllByRole('cell')[2]).toHaveTextContent('–');
    expect(screen.queryByLabelText('chat chat')).toBeNull();
    // Mail auf Digest: nur das geänderte Feld, der Rest erbt
    fireEvent.change(screen.getByLabelText('due mail'), { target: { value: 'digest' } });
    expect(onSave).toHaveBeenLastCalledWith([item('due', { channels: { mail: 'digest' } })]);
    // Log als Wahrheitswert, nicht als Text
    fireEvent.change(screen.getByLabelText('due log'), { target: { value: 'true' } });
    expect(onSave).toHaveBeenLastCalledWith([item('due', { channels: { log: true } })]);
    // Schloss sperrt das Feld für die Ebenen darunter
    fireEvent.click(within(screen.getByLabelText('due mail').closest('tr')!).getByRole('button', { name: 'mail sperren' }));
    expect(onSave).toHaveBeenLastCalledWith([item('due', { locked: ['mail'] })]);
    // Zeile mit eingeschalteter Doku-Seite: die Seite geht als „an“ zurück, die Änderung dazu
    expect(screen.getByLabelText('decision Doku')).toBeChecked();
    fireEvent.change(screen.getByLabelText('decision mail'), { target: { value: 'digest' } });
    expect(onSave).toHaveBeenLastCalledWith([item('decision', { channels: { doc: true, mail: 'digest' } })]);
    fireEvent.click(screen.getByLabelText('decision Doku'));
    expect(onSave).toHaveBeenLastCalledWith([item('decision', { channels: { doc: false } })]);
  });

  it('Benutzer: nur Chat (aus, Thread) und Mail, keine Spalten Empfänger, Log, Doku, Fristen', () => {
    render(<RulesMatrix level="user" data={{ rules: [], effective: eff() }} canEdit onSave={onSave} />);
    const chat = screen.getByLabelText('assigned chat') as HTMLSelectElement;
    expect(Array.from(chat.options).map((o) => o.textContent)).toEqual(['erbt: aus (Standard)', 'aus', 'Thread']);
    for (const h of ['Empfänger', 'Log', 'Doku', 'Fristen']) expect(screen.queryByRole('columnheader', { name: h })).toBeNull();
    expect(screen.queryByRole('button', { name: /sperren/ })).toBeNull();
    fireEvent.change(chat, { target: { value: 'thread' } });
    expect(onSave).toHaveBeenLastCalledWith([item('assigned', { channels: { chat: 'thread' } })]);
  });

  it('Empfänger: Rollen in Reihenfolge, „sonst“ hängt an den letzten Eintrag, „Erben“ löscht die eigene Liste', async () => {
    render(<RulesMatrix level="project" data={{ rules: [], effective: eff() }} canEdit onSave={onSave} />);
    const reviewRow = () => screen.getByLabelText('review mail').closest('tr')!;
    fireEvent.click(within(reviewRow()).getByRole('button', { name: 'ändern' }));
    let dlg = screen.getByText('Empfänger: Prüfung und Freigabe').closest('.modal') as HTMLElement;
    fireEvent.change(within(dlg).getByLabelText('Empfänger hinzufügen'), { target: { value: 'subproject_lead' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    fireEvent.change(within(dlg).getByLabelText('Empfänger hinzufügen'), { target: { value: 'pl' } });
    fireEvent.click(within(dlg).getByLabelText(/nur als Ersatz für den letzten Eintrag/));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    expect(within(dlg).getByRole('listitem')).toHaveTextContent('TP-Verantwortung, sonst verantwortliche PL');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    expect(onSave).toHaveBeenLastCalledWith([item('review', { recipients: ['subproject_lead|pl'] })]);
    await waitFor(() => expect(screen.queryByText('Empfänger: Prüfung und Freigabe')).toBeNull());
    fireEvent.click(within(reviewRow()).getByRole('button', { name: 'ändern' }));
    dlg = screen.getByText('Empfänger: Prüfung und Freigabe').closest('.modal') as HTMLElement;
    fireEvent.click(within(dlg).getByRole('button', { name: 'Erben' }));
    expect(onSave).toHaveBeenLastCalledWith([item('review', { recipients: null })]);
  });
});

describe('Projekteinstellungen › Kommunikation', () => {
  it('„Doku-Seite einschalten“ setzt Doku für Entscheidung und Eskalation, danach steht der Link; „Wer bekommt was?“ zeigt Personen mit Rolle und Mail-Modus', async () => {
    let listing: Record<string, unknown> = { rules: [], effective: eff(), canEdit: true };
    get.mockReset();
    get.mockImplementation(async (url: string) => {
      if (url === '/projects/p1/notification-rules') return listing;
      if (url === '/groups') return { groups: [] };
      if (url === '/projects/p1/notification-rules/effective') return { events: [{ event: 'decision', label: 'Entscheidung', rule: eff()[1], people: [{ id: 'u1', name: 'Petra Lenz', role: 'pl', roleLabel: 'verantwortliche PL', mail: 'now', chat: 'thread' }], projectChannel: false, perEvent: [], caller: null }] };
      throw new Error(url);
    });
    put.mockReset();
    put.mockImplementation(async () => {
      listing = { rules: [row('decision', { channels: { doc: 'page1' } }), row('escalation', { channels: { doc: 'page1' } })], effective: eff({ decision: { value: { doc: 'page1' } }, escalation: { value: { doc: 'page1' } } }), canEdit: true };
      return listing;
    });
    render(<MemoryRouter><ProjectNotifyCard projectId="p1" members={[{ userId: 'u1', name: 'Petra Lenz' }, { userId: 'a1', name: 'Morton', kind: 'agent' }]} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Doku-Seite „Entscheidungen und Meldungen“ einschalten/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/projects/p1/notification-rules', { rules: [item('decision', { channels: { doc: true } }), item('escalation', { channels: { doc: true } })] }));
    expect(await screen.findByRole('link', { name: 'Seite „Entscheidungen und Meldungen“' })).toHaveAttribute('href', '/projekte/p1/doku/page1');
    expect(screen.queryByRole('button', { name: /Doku-Seite/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Wer bekommt was?' }));
    expect(await screen.findByText('Petra Lenz')).toBeInTheDocument();
    expect(screen.getByText('(verantwortliche PL) · Mail sofort')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/projects/p1/notification-rules/effective');
  });
});

describe('Benutzereinstellungen › Benachrichtigungen', () => {
  it('Projekt wählen lädt die Regeln im Projekt; stummschalten setzt „*“ auf Mail und Chat aus, aufheben löscht die Zeile', async () => {
    let rules: NotificationRule[] = [];
    get.mockReset();
    get.mockImplementation(async (url: string) => {
      if (url === '/projects') return { projects: [{ id: 'p1', key: 'WEB', name: 'Website', status: 'active' }, { id: 'p2', key: 'ALT', name: 'Abgeschlossen', status: 'archived' }] };
      if (url === '/me/notification-rules') return { level: 'user', rules: [], effective: eff() };
      if (url === '/me/notification-rules?projectId=p1') return { level: 'user_project', rules, effective: eff() };
      throw new Error(url);
    });
    put.mockReset();
    put.mockImplementation(async (_url: string, body: { rules: { channels?: NotificationRule['channels'] }[] }) => {
      rules = body.rules[0].channels ? [row('*', { channels: body.rules[0].channels, userId: 'me' })] : [];
      return { level: 'user_project', rules, effective: eff() };
    });
    render(<MyNotifyCard />);
    const scope = await screen.findByLabelText('Geltungsbereich');
    await waitFor(() => expect(within(scope).getByRole('option', { name: 'WEB · Website' })).toBeInTheDocument());
    expect(within(scope).queryByRole('option', { name: /ALT/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Projekt stummschalten' })).toBeNull();
    fireEvent.change(scope, { target: { value: 'p1' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/me/notification-rules?projectId=p1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Projekt stummschalten' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/me/notification-rules?projectId=p1', { rules: [{ event: '*', channels: { mail: 'off', chat: 'off' } }] }));
    expect(await screen.findByText('stummgeschaltet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stummschaltung aufheben' }));
    await waitFor(() => expect(put).toHaveBeenLastCalledWith('/me/notification-rules?projectId=p1', { rules: [{ event: '*' }] }));
    await waitFor(() => expect(screen.queryByText('stummgeschaltet')).toBeNull());
  });
});

describe('Berichtswunsch am AP', () => {
  const taskRules = (over: Record<string, unknown> = {}) => ({ rules: [], effective: eff(), canEdit: false, canEditProgress: false, mine: [], myEffective: eff().find((e) => e.event === 'progress'), ...over });
  beforeEach(() => { get.mockReset(); put.mockReset(); put.mockResolvedValue({}); });

  it('eigener Wunsch geht als Benutzer am AP mit Häufigkeit und Mail; ohne Recht keine Felder für das AP', async () => {
    get.mockResolvedValue(taskRules());
    render(<ReportWish taskId="t1" />);
    fireEvent.change(await screen.findByLabelText('Zwischenstände für mich'), { target: { value: 'each' } });
    await waitFor(() => expect(put).toHaveBeenCalledWith('/me/notification-rules?taskId=t1', { rules: [{ event: 'progress', channels: { mail: 'now' }, timing: { every: 'each' } }] }));
    expect(screen.queryByLabelText('verantwortliche PL')).toBeNull();
    expect(screen.queryByLabelText('Zwischenstände')).toBeNull();
  });

  it('PL oder zuständige Person: Empfänger und Häufigkeit für das AP', async () => {
    get.mockResolvedValue(taskRules({ canEditProgress: true }));
    render(<ReportWish taskId="t1" />);
    fireEvent.click(await screen.findByLabelText('verantwortliche PL'));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/tasks/t1/notification-rules', { rules: [{ event: 'progress', recipients: ['requester', 'pl'], channels: {}, timing: {} }] }));
    fireEvent.change(screen.getByLabelText('Zwischenstände'), { target: { value: 'done' } });
    await waitFor(() => expect(put).toHaveBeenLastCalledWith('/tasks/t1/notification-rules', { rules: [{ event: 'progress', recipients: null, channels: {}, timing: { every: 'done' } }] }));
  });
});

import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_AGENT_RIGHTS, type AiCapabilities } from '@projekttool/shared';
import { AgentEditorModal, RightsEditor, rightsSummary } from './AgentEditor';
import { api } from '../lib/api';
import { assistChoice } from '../lib/useAi';

vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));

describe('Antwortstil auf Statusfragen', () => {
  it('Select mit vier Stilen und Erklärung; Speichern schickt statusStyle', async () => {
    vi.mocked(api.patch).mockResolvedValue({ warnings: [] });
    const onSaved = vi.fn();
    const agent = { id: 'a1', name: 'Morton', email: 'm@agent.local', active: true, aiProfileId: 'l1', persona: null, signature: null, thinkingMode: null, statusStyle: 'technical' as const, createdAt: '', projects: [], runs: 0, lastRunAt: null };
    render(<AgentEditorModal agent={agent} llms={[{ id: 'l1', name: 'Qwen', provider: 'local' }]} llmId="l1" orgBudget={50} scoped={false} onClose={() => undefined} onSaved={onSaved} />);
    const select = screen.getByLabelText(/Antwort auf Statusfragen/) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['technical', 'compact', 'text', 'management']);
    expect(screen.getByText(/Liste mit Kennung, Titel und Termin/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'management' } });
    expect(screen.getByText(/Lagebild in wenigen Sätzen/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Speichern' })); });
    expect(api.patch).toHaveBeenCalledWith('/agents/a1', expect.objectContaining({ statusStyle: 'management' }));
    expect(onSaved).toHaveBeenCalled();
  });
});

describe('Rechte eines Agenten', () => {
  it('PL schränkt nur ein: nicht erteilte Rechte sind gesperrt, erteilte abschaltbar', () => {
    const onChange = vi.fn();
    render(<RightsEditor value={['assist.ask', 'agent.run']} granted={['assist.ask', 'agent.run']} onChange={onChange} />);
    const web = screen.getByLabelText(/Online-Recherche \(nicht erteilt\)/);
    expect(web).toBeDisabled();
    expect(web).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Arbeitspakete bearbeiten'));
    expect(onChange).toHaveBeenCalledWith(['assist.ask']);
  });
  it('Kurztext: Standard ohne Online-Recherche', () => {
    expect(rightsSummary(DEFAULT_AGENT_RIGHTS)).toBe('alle außer Online-Recherche');
    expect(rightsSummary(['assist.ask', 'assist.summarize', 'agent.chat', 'agent.run'])).toBe('Assistenz (2 von 5), Arbeit (2 von 4)');
    expect(rightsSummary([])).toBe('keine Rechte');
  });
});

describe('Agent für die Assistenz', () => {
  const agent = (id: string, projectAgent: boolean) => ({ id, name: id, projectAgent, assist: ['assist.ask' as const], run: { allowed: true, reason: '', stage: 'ok' as const }, chat: { allowed: true, reason: '', stage: 'ok' as const } });
  const caps = (agents: AiCapabilities['agents']): AiCapabilities => ({ killswitch: false, features: {}, agents, assistAgentId: null });
  it('Projektagent zuerst, sonst der einzige, bei mehreren Auswahl', () => {
    expect(assistChoice(caps([agent('a', false), agent('b', true)]), 'assist.ask').def).toBe('b');
    expect(assistChoice(caps([agent('a', false)]), 'assist.ask').def).toBe('a');
    const many = assistChoice(caps([agent('a', false), agent('c', false)]), 'assist.ask');
    expect(many.def).toBeNull();
    expect(many.fit).toHaveLength(2);
    expect(assistChoice(caps([agent('a', false)]), 'assist.report').fit).toHaveLength(0);
  });
});

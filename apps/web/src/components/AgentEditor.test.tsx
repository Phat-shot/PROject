import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_AGENT_RIGHTS, type AiCapabilities } from '@projekttool/shared';
import { RightsEditor, rightsSummary } from './AgentEditor';
import { assistChoice } from '../lib/useAi';

vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));

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

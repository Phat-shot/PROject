import { describe, expect, it, vi } from 'vitest';
vi.mock('../components/RichEditor', () => ({ RichEditor: () => null }));
import { projectTabs } from './ProjectPage';

describe('Projektreiter: schlankes persönliches Projekt', () => {
  it('slim blendet Plan, Risiken, Zeiten und Auswertung aus; KI und Einstellungen bleiben', () => {
    const labels = (slim: boolean) => projectTabs({ base: '/projekte/p1', slim, timeTracking: true, aiTab: true, openProposals: 0 }).map((t) => t.label);
    expect(labels(true)).toEqual(['Board', 'Doku', 'KI', 'Einstellungen']);
    expect(labels(false)).toEqual(['Board', 'Plan', 'Doku', 'Risiken', 'Zeiten', 'Auswertung', 'KI', 'Einstellungen']);
  });
});

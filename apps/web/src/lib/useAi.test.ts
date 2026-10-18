import { describe, expect, it } from 'vitest';
import type { AiCapabilities } from '@projekttool/shared';
import { aiBlocked } from './useAi';

describe('KI-Knöpfe mit Begründung', () => {
  const caps: AiCapabilities = {
    killswitch: false,
    features: {
      'assist.ask': { allowed: true, reason: 'Erlaubt', stage: 'ok' },
      'assist.report': { allowed: false, reason: 'Gesperrt durch Org-Admin (A. Admin) für Projekt BAU: Datenschutz', stage: 'policy' }
    },
    agents: []
  };
  it('liefert die Begründung der Sperre, sonst nichts', () => {
    expect(aiBlocked(caps, 'assist.ask')).toBeUndefined();
    expect(aiBlocked(caps, 'assist.report')).toMatch(/Datenschutz/);
  });
  it('sperrt, solange die Freigaben laden', () => {
    expect(aiBlocked(null, 'assist.ask')).toMatch(/geladen/);
  });
});

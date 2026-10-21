import { useState } from 'react';
import type { AiCapabilities, AiFeature } from '@projekttool/shared';
import { assistChoice } from '../lib/useAi';

/**
 * Wer führt die Assistenz aus: ohne Projektagent und mit mehreren geeigneten Agenten eine kleine Auswahl neben dem Knopf,
 * sonst nichts. agentId geht mit der Anfrage mit (null = Server wählt).
 */
export function useAssistAgent(caps: AiCapabilities | null | undefined, feature: AiFeature): { agentId: string | null; picker: React.ReactNode } {
  const [pick, setPick] = useState<string | null>(null);
  const { fit, def } = assistChoice(caps, feature);
  const agentId = (pick && fit.some((a) => a.id === pick) ? pick : null) ?? def ?? fit[0]?.id ?? null;
  const picker = !def && fit.length > 1
    ? <select className="sm" aria-label="Ausführender Agent" title="Ausführender Agent" style={{ width: 'auto' }} value={agentId ?? ''} onChange={(e) => setPick(e.target.value)}>{fit.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
    : null;
  return { agentId, picker };
}

import { useEffect, useState } from 'react';
import { api } from './api';

import type { AiCapabilities, AiFeature, AiProfile, AgentPolicy, WebSearchSettings, ExternalWindow } from '@projekttool/shared';
export interface AiStatus { enabled: boolean; /** Notaus aktiv */ killswitch?: boolean; profiles: (AiProfile & { projectScope?: 'all' | 'selected' | 'none'; projectIds?: string[] })[]; defaultProfileId: string | null; agentDailyBudget: number; assistDailyBudget?: number; plAgents?: { enabled: boolean; maxBudget: number }; ownLlm?: 'off' | 'personal' | 'all'; /** Außenprüfung für Agenten-Mails an Nicht-Interne */ externalGuard?: 'strict' | 'check'; /** Agenten-Policy des Mandanten (Rohwert) */ agentPolicy?: AgentPolicy; web?: WebSearchSettings; externalWindow?: ExternalWindow; models: string[] }
let cache: AiStatus | null = null;
let pending: Promise<AiStatus> | null = null;
const listeners = new Set<(s: AiStatus) => void>();

/** KI-Status des Mandanten (einmal geladen, nach Änderung in der Verwaltung über invalidateAi() neu). */
export function useAiStatus(): AiStatus | null {
  const [s, setS] = useState<AiStatus | null>(cache);
  useEffect(() => {
    listeners.add(setS);
    if (!cache && !pending) pending = api.get<AiStatus>('/ai/status').then((r) => { cache = r; listeners.forEach((l) => l(r)); return r; }).catch(() => { pending = null; return { enabled: false, profiles: [], defaultProfileId: null, agentDailyBudget: 50, models: [] }; });
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

export async function invalidateAi() {
  cache = null; pending = null;
  const r = await api.get<AiStatus>('/ai/status');
  cache = r; listeners.forEach((l) => l(r));
}

/**
 * Begründung, warum eine KI-Funktion im Projekt nicht geht (KI-Freigaben, aus /projects/:id/ai/capabilities); undefined = erlaubt.
 * Solange die Fähigkeiten laden, gilt die Funktion als gesperrt, damit kein Knopf kurz aufblitzt.
 */
export function aiBlocked(caps: AiCapabilities | null | undefined, feature: AiFeature): string | undefined {
  if (!caps) return 'KI-Freigaben werden geladen …';
  const c = caps.features[feature];
  return !c || c.allowed ? undefined : c.reason;
}

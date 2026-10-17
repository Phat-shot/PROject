import { useEffect, useState } from 'react';
import { api } from './api';

export interface AiStatus { enabled: boolean; provider: 'anthropic' | 'local'; model: string; baseUrl: string | null; hasKey: boolean; source: 'env' | 'org' | null; agentDailyBudget: number; models: string[] }
let cache: AiStatus | null = null;
let pending: Promise<AiStatus> | null = null;
const listeners = new Set<(s: AiStatus) => void>();

/** KI-Status des Mandanten (einmal geladen, nach Änderung in der Verwaltung über invalidateAi() neu). */
export function useAiStatus(): AiStatus | null {
  const [s, setS] = useState<AiStatus | null>(cache);
  useEffect(() => {
    listeners.add(setS);
    if (!cache && !pending) pending = api.get<AiStatus>('/ai/status').then((r) => { cache = r; listeners.forEach((l) => l(r)); return r; }).catch(() => { pending = null; return { enabled: false, provider: 'anthropic', model: '', baseUrl: null, hasKey: false, source: null, agentDailyBudget: 50, models: [] }; });
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

export async function invalidateAi() {
  cache = null; pending = null;
  const r = await api.get<AiStatus>('/ai/status');
  cache = r; listeners.forEach((l) => l(r));
}

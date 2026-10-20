import { useEffect, useState } from 'react';
import type { Question } from '@projekttool/shared';
import { api } from './api';

/** Was auf die Person wartet (GET /my/waiting), ohne offene Fragen. */
export interface Waiting {
  drafts: { projectId: string; projectKey: string; count: number }[];
  pagesInReview: { id: string; title: string; projectId: string; projectKey: string }[];
  tasks: { id: string; number: number; title: string; projectId: string; projectKey: string; blocked: boolean; escalationLevel: number }[];
  proposals?: { projectId: string; projectKey: string; count: number }[];
  mailSuggestions?: { mailId: string; subject: string; projectId: string; projectKey: string }[];
}
export interface OpenForMe { questions: Question[]; waiting: Waiting | null; total: number; byProject: Record<string, number> }

/** Projekte der Einträge in „Offen für dich“: ein Eintrag je Zeile der Liste (Sammelzeilen wie „3 Entwürfe“ zählen einmal). */
export function openProjectIds(questions: Question[], w: Waiting | null): string[] {
  return [
    ...questions.map((q) => q.projectId),
    ...(w?.proposals ?? []).map((x) => x.projectId), ...(w?.drafts ?? []).map((x) => x.projectId), ...(w?.mailSuggestions ?? []).map((x) => x.projectId),
    ...(w?.tasks ?? []).map((x) => x.projectId), ...(w?.pagesInReview ?? []).map((x) => x.projectId)
  ];
}

const EMPTY: OpenForMe = { questions: [], waiting: null, total: 0, byProject: {} };
let cache = EMPTY;
const listeners = new Set<(o: OpenForMe) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let last = 0;
const load = () => { last = Date.now(); return Promise.all([api.get<{ questions: Question[] }>('/questions?status=open'), api.get<Waiting>('/my/waiting')]).then(([q, w]) => {
  const ids = openProjectIds(q.questions ?? [], w);
  const byProject: Record<string, number> = {};
  for (const id of ids) byProject[id] = (byProject[id] ?? 0) + 1;
  cache = { questions: q.questions ?? [], waiting: w, total: ids.length, byProject };
  listeners.forEach((l) => l(cache));
}).catch(() => undefined); };

/** „Offen für dich“ für Dashboard und Leiste aus einer Quelle; alle 60 s und beim Fokus neu, refreshOpenForMe() nach Änderungen. */
export function useOpenForMe(): OpenForMe {
  const [o, setO] = useState<OpenForMe>(cache);
  useEffect(() => {
    listeners.add(setO);
    if (!timer) { void load(); timer = setInterval(load, 60_000); window.addEventListener('focus', () => void load()); }
    return () => { listeners.delete(setO); };
  }, []);
  return o;
}
export function refreshOpenForMe() { if (Date.now() - last > 10_000) void load(); }

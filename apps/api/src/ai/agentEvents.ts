/**
 * Sofortläufe von Agenten bei Ereignissen (Zuweisung, Kommentar, Mail): die Routen melden ein Ereignis, der
 * registrierte Läufer startet kurz danach entkoppelt vom Request. Mehrere Ereignisse zum selben Arbeitspaket
 * werden zusammengefasst; flushAgentRuns() wartet in Tests auf alle anstehenden Läufe.
 */
type Runner = (taskId: string, trigger: string) => Promise<unknown>;
let runner: Runner | null = null;
const pending = new Map<string, Promise<unknown>>();
const delayMs = () => (process.env.NODE_ENV === 'test' ? 0 : 1500);

export function registerAgentRunner(fn: Runner | null) { runner = fn; }

export function queueAgentRun(taskId: string, trigger: string): void {
  if (!runner || pending.has(taskId)) return;
  const run = runner;
  const p = new Promise<unknown>((resolve) => setTimeout(resolve, delayMs()))
    .then(() => run(taskId, trigger))
    .catch((e) => console.error('[agent]', e?.message ?? e))
    .finally(() => pending.delete(taskId));
  pending.set(taskId, p);
}

export async function flushAgentRuns(): Promise<void> { await Promise.all([...pending.values()]); }

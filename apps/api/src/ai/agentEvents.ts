/**
 * Sofortläufe von Agenten bei Ereignissen (Zuweisung, Kommentar, Mail, Chat-Nachricht): die Routen melden ein Ereignis,
 * der registrierte Läufer startet kurz danach entkoppelt vom Request. Mehrere Ereignisse zum selben Arbeitspaket bzw.
 * Gespräch werden zusammengefasst; flushAgentRuns() wartet in Tests auf alle anstehenden Läufe.
 */
type Runner = (taskId: string, trigger: string) => Promise<unknown>;
type ChatRunner = (agentId: string, channelId: string, messageId: string) => Promise<unknown>;
type MailAiRunner = (runId: string) => Promise<unknown>;
let runner: Runner | null = null;
let chatRunner: ChatRunner | null = null;
let mailAiRunner: MailAiRunner | null = null;
const pending = new Map<string, Promise<unknown>>();
const delayMs = () => (process.env.NODE_ENV === 'test' ? 0 : 1500);

export function registerAgentRunner(fn: Runner | null) { runner = fn; }
export function registerAgentChatRunner(fn: ChatRunner | null) { chatRunner = fn; }
export function registerMailAiRunner(fn: MailAiRunner | null) { mailAiRunner = fn; }

/** Mail-KI-Lauf (Ordner „KI Bearbeiten“ oder Agent an einer Ansicht) entkoppelt vom Sync starten. */
export function queueMailAi(runId: string): void {
  const key = `mail:${runId}`;
  if (!mailAiRunner || pending.has(key)) return;
  const run = mailAiRunner;
  const p = new Promise<unknown>((resolve) => setTimeout(resolve, delayMs()))
    .then(() => run(runId))
    .catch((e) => console.error('[mail-ai]', e?.message ?? e))
    .finally(() => pending.delete(key));
  pending.set(key, p);
}

export function queueAgentRun(taskId: string, trigger: string): void {
  if (!runner || pending.has(taskId)) return;
  const run = runner;
  const p = new Promise<unknown>((resolve) => setTimeout(resolve, delayMs()))
    .then(() => run(taskId, trigger))
    .catch((e) => console.error('[agent]', e?.message ?? e))
    .finally(() => pending.delete(taskId));
  pending.set(taskId, p);
}

/** Agent antwortet im Chat (Direktnachricht, Erwähnung im Projektkanal oder Antwort in seinem Thread). */
export function queueAgentChat(agentId: string, channelId: string, messageId: string): void {
  const key = `chat:${agentId}:${channelId}`;
  if (!chatRunner || pending.has(key)) return;
  const run = chatRunner;
  const p = new Promise<unknown>((resolve) => setTimeout(resolve, delayMs()))
    .then(() => run(agentId, channelId, messageId))
    .catch((e) => console.error('[agent-chat]', e?.message ?? e))
    .finally(() => pending.delete(key));
  pending.set(key, p);
}

/** Wartet, bis alle Läufe fertig sind, auch solche, die während des Wartens dazukommen (z. B. Agent nach Mail-KI). */
export async function flushAgentRuns(): Promise<void> { while (pending.size) await Promise.all([...pending.values()]); }

/**
 * Sofortläufe von Agenten bei Ereignissen (Zuweisung, Kommentar, Mail, Chat-Nachricht): die Routen melden ein Ereignis,
 * der registrierte Läufer startet kurz danach entkoppelt vom Request. Ereignisse zum selben Arbeitspaket bzw. Gespräch
 * (Direktnachricht oder Thread im Projektkanal), die vor dem Start eintreffen, gehen im anstehenden Lauf auf; was während
 * eines Laufs eintrifft, setzt das Dirty-Flag und löst danach genau einen Folgelauf aus, der den Stand neu liest.
 * flushAgentRuns() wartet in Tests auf alle Läufe.
 */
type Runner = (taskId: string, trigger: string, agentId: string | null) => Promise<unknown>;
type ChatRunner = (agentId: string, channelId: string, messageId: string) => Promise<unknown>;
type MailAiRunner = (runId: string) => Promise<unknown>;
let runner: Runner | null = null;
let chatRunner: ChatRunner | null = null;
let mailAiRunner: MailAiRunner | null = null;
const pending = new Map<string, Promise<unknown>>();
/** Anstehende Läufe (noch nicht gestartet): neuere Ereignisse ersetzen die Angaben. */
const waiting = new Map<string, () => Promise<unknown>>();
/** Dirty-Flag: während eines Laufs eingetroffen, mit den Angaben des letzten Ereignisses. */
const dirty = new Map<string, () => Promise<unknown>>();
const delayMs = () => (process.env.NODE_ENV === 'test' ? 0 : 1500);

/** Ein Lauf je Schlüssel: steht er noch an, gilt das neueste Ereignis; läuft er schon, folgt genau ein weiterer Lauf. */
function schedule(key: string, label: string, run: () => Promise<unknown>, keepFirst = false): void {
  if (pending.has(key)) {
    if (waiting.has(key)) { if (!keepFirst) waiting.set(key, run); } else dirty.set(key, run);
    return;
  }
  waiting.set(key, run);
  const p = new Promise<unknown>((resolve) => setTimeout(resolve, delayMs()))
    .then(() => { const fn = waiting.get(key)!; waiting.delete(key); return fn(); })
    .catch((e) => console.error(`[${label}]`, e?.message ?? e))
    .finally(() => {
      pending.delete(key);
      const next = dirty.get(key);
      dirty.delete(key);
      if (next) schedule(key, label, next);
    });
  pending.set(key, p);
}

export function registerAgentRunner(fn: Runner | null) { runner = fn; }
export function registerAgentChatRunner(fn: ChatRunner | null) { chatRunner = fn; }
export function registerMailAiRunner(fn: MailAiRunner | null) { mailAiRunner = fn; }

/** Mail-KI-Lauf (Ordner „KI Bearbeiten“ oder Agent an einer Ansicht) entkoppelt vom Sync starten. */
export function queueMailAi(runId: string): void {
  const key = `mail:${runId}`;
  if (!mailAiRunner || pending.has(key)) return;
  const run = mailAiRunner;
  schedule(key, 'mail-ai', () => run(runId));
}

/** Lauf am Arbeitspaket; steht schon einer an, bleibt dessen Anlass (z. B. Zuweisung vor dem folgenden Kommentar). */
export function queueAgentRun(taskId: string, trigger: string, agentId?: string | null): void {
  if (!runner) return;
  const run = runner;
  schedule(taskId, 'agent', () => run(taskId, trigger, agentId ?? null), true);
}

/**
 * Agent antwortet im Chat (Direktnachricht, Erwähnung im Projektkanal oder Antwort in seinem Thread); der Lauf antwortet auf
 * die neueste Nachricht des Gesprächs. Gespräch ist in Direktnachrichten der Kanal, im Projektkanal der Thread (threadKey),
 * damit Erwähnungen in verschiedenen Threads je eine Antwort bekommen.
 */
export function queueAgentChat(agentId: string, channelId: string, messageId: string, threadKey = ''): void {
  if (!chatRunner) return;
  const run = chatRunner;
  schedule(`chat:${agentId}:${channelId}${threadKey ? `:${threadKey}` : ''}`, 'agent-chat', () => run(agentId, channelId, messageId));
}

/** Wartet, bis alle Läufe fertig sind, auch solche, die während des Wartens dazukommen (z. B. Agent nach Mail-KI). */
export async function flushAgentRuns(): Promise<void> { while (pending.size) await Promise.all([...pending.values()]); }

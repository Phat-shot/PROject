import type { BoardColumn } from '@projekttool/shared';
import { api } from './api';

type Form = (o: { title: string; text?: string; fields: { key: string; label: string; type?: 'text' | 'date'; value?: string; placeholder?: string; required?: boolean }[]; submitLabel?: string }) => Promise<Record<string, string> | null>;

/**
 * Status ändern (Board, Status-Menü, Arbeitspaket). Nach „Wartet“ fragt es, worauf und bis wann gewartet wird: läuft die
 * Frist ohne Lösung ab, wandert das Arbeitspaket nach „Zurückgestellt“. false = abgebrochen.
 */
export async function moveTaskTo(form: Form, taskId: string, column: Pick<BoardColumn, 'id' | 'kind'>, index: number | null = null): Promise<boolean> {
  let wait: { reason: string; until: string | null } | undefined;
  if (column.kind === 'waiting') {
    const d = new Date(); d.setDate(d.getDate() + 7);
    const v = await form({ title: 'Wartet auf …', text: 'Läuft die Frist ohne Lösung ab, wandert das Arbeitspaket nach „Zurückgestellt“ und die Verantwortlichen bekommen eine Meldung.', fields: [
      { key: 'reason', label: 'Worauf wird gewartet?', placeholder: 'z. B. Angebot vom Elektriker', required: true },
      { key: 'until', label: 'Frist', type: 'date', value: d.toISOString().slice(0, 10) }
    ], submitLabel: 'Auf „Wartet“ setzen' });
    if (!v) return false;
    wait = { reason: v.reason, until: v.until || null };
  }
  await api.post(`/tasks/${taskId}/move`, { columnId: column.id, index, ...(wait ? { wait } : {}) });
  return true;
}

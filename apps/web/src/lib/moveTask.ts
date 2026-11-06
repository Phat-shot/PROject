import type { BoardColumn } from '@projekttool/shared';
import { api } from './api';

import type { FormOptions } from '../components/ui';

type Form = (o: FormOptions) => Promise<Record<string, string> | null>;

/** Auswahl der prüfenden Person beim Wechsel in eine Spalte der Art „In Prüfung“ */
export interface ReviewOpts { reviewers: { value: string; label: string }[]; required: boolean; current?: string | null }

/** Prüfer-Auswahl aus den Projektmitgliedern (keine Leser, keine KI-Agenten); Pflicht laut Projekteinstellung. */
export function reviewOptsOf(detail: { project: { reviewRequired?: boolean }; members: { userId: string; name: string; role: string; kind?: string }[] }, current?: string | null): ReviewOpts {
  return { reviewers: (detail.members ?? []).filter((m) => m.role !== 'reader' && m.kind !== 'agent').map((m) => ({ value: m.userId, label: m.name })), required: Boolean(detail.project.reviewRequired), current: current ?? null };
}

/**
 * Status ändern (Board, Status-Menü, Arbeitspaket). Nach „Wartet“ fragt es, worauf und bis wann gewartet wird: läuft die
 * Frist ohne Lösung ab, wandert das Arbeitspaket nach „Zurückgestellt“. Nach „In Prüfung“ (Art review) fragt es, wer prüft
 * (Pflicht mit der Projekteinstellung „Prüfer erforderlich“). false = abgebrochen.
 */
export async function moveTaskTo(form: Form, taskId: string, column: Pick<BoardColumn, 'id' | 'kind'>, index: number | null = null, review?: ReviewOpts): Promise<boolean> {
  let wait: { reason: string; until: string | null } | undefined;
  let rv: { reviewerUserId: string | null } | undefined;
  if (column.kind === 'waiting') {
    const d = new Date(); d.setDate(d.getDate() + 7);
    const v = await form({ title: 'Wartet auf …', text: 'Läuft die Frist ohne Lösung ab, wandert das Arbeitspaket nach „Zurückgestellt“ und die Verantwortlichen bekommen eine Meldung.', fields: [
      { key: 'reason', label: 'Worauf wird gewartet?', placeholder: 'z. B. Angebot vom Elektriker', required: true },
      { key: 'until', label: 'Frist', type: 'date', value: d.toISOString().slice(0, 10) }
    ], submitLabel: 'Auf „Wartet“ setzen' });
    if (!v) return false;
    wait = { reason: v.reason, until: v.until || null };
  }
  if (column.kind === 'review' && review) {
    const options = [...(review.required ? [] : [{ value: '', label: '– ohne benannte Person –' }]), ...review.reviewers];
    const v = await form({ title: 'Zur Prüfung an …', text: 'Die prüfende Person bekommt eine Meldung, sieht das Arbeitspaket unter „Offen für dich“ und kann freigeben oder mit Kommentar zurückweisen.', fields: [
      { key: 'reviewer', label: 'Wer prüft?', type: 'select', required: review.required, options, value: review.current ?? (review.required ? review.reviewers[0]?.value ?? '' : '') }
    ], submitLabel: 'Zur Prüfung geben' });
    if (!v) return false;
    rv = { reviewerUserId: v.reviewer || null };
  }
  await api.post(`/tasks/${taskId}/move`, { columnId: column.id, index, ...(wait ? { wait } : {}), ...(rv ? { review: rv } : {}) });
  return true;
}

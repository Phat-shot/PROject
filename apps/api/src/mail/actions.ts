import type { Db } from '../db.js';
import { USE_LATERAL } from './accounts.js';

/** Markdown-Darstellung einer Mail für Doku und Arbeitspaket-Log (1:1, ohne KI). */
export function mailToMarkdown(m: any, opts: { heading?: 1 | 2 | 3; withBody?: boolean } = {}): string {
  const h = '#'.repeat(opts.heading ?? 1);
  const date = new Date(m.date).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const from = m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr;
  const to = Array.isArray(m.to_json) ? m.to_json.join(', ') : '';
  const lines = [
    `${h} ${m.subject || '(kein Betreff)'}`,
    '',
    `**Von:** ${from}  `,
    `**An:** ${to}  `,
    `**Datum:** ${date}${m.has_attachments ? '  \n**Anhänge:** ja' : ''}`,
    ''
  ];
  if (opts.withBody !== false) {
    const body = (m.text_body ?? m.snippet ?? '').trim();
    lines.push(body.split('\n').map((l: string) => `> ${l}`).join('\n'));
  }
  return lines.join('\n');
}

/** Kurzfassung für einen Log-Eintrag (maximal ~1.200 Zeichen). */
export function mailToLogEntry(m: any): string {
  const date = new Date(m.date).toLocaleDateString('de-DE');
  const from = m.from_name ? `${m.from_name} (${m.from_addr})` : m.from_addr;
  const body = (m.text_body ?? m.snippet ?? '').trim().replace(/\n{3,}/g, '\n\n');
  const cut = body.length > 1200 ? body.slice(0, 1200) + ' …' : body;
  return `Aus Mail „${m.subject}“ von ${from}, ${date}:\n\n${cut}`;
}

/** Mail mit der Bindung ihres Kontos im Kontext eines Projekts (use, use_user_id); ohne Projekt zählt die persönliche oder Org-Bindung. */
export async function loadMailRow(db: Db, mailId: string, projectId: string | null = null) {
  return db.maybeOne(`select m.*, ux.use, ux.use_user_id from mails m join mail_accounts a on a.id = m.account_id ${USE_LATERAL('a', '$2::uuid')} where m.id = $1`, [mailId, projectId]);
}

/**
 * KI-Aktionen sind vorgesehen, aber nicht angebunden (KI ist das letzte Modul).
 * Jede läuft später als Vorschlag in der Freigabe-Liste; Ausführung durch den Worker.
 */
/** KI-Aktionen an einer Mail (Endpunkte unter /mail/mails/:mid/ai/…); Vorschläge werden erst nach Freigabe angewendet. */
export const AI_ACTIONS = [
  { key: 'summarize', target: 'mail', label: 'Zusammenfassen', mode: 'direct' },
  { key: 'essence_task', target: 'task', label: 'Essenz → Arbeitspaket (Vorschlag)', mode: 'proposal' },
  { key: 'essence_page', target: 'doc', label: 'Essenz → Seite (Vorschlag)', mode: 'proposal' }
] as const;

import type { Db } from '../db.js';

/** Markdown-Darstellung einer Mail für Doku und Aufgaben-Log (1:1, ohne KI). */
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

export async function loadMailRow(db: Db, mailId: string) {
  return db.maybeOne(`select m.*, a.type as account_type, a.owner_user_id from mails m join mail_accounts a on a.id = m.account_id where m.id = $1`, [mailId]);
}

/**
 * KI-Aktionen sind vorgesehen, aber nicht angebunden (KI ist das letzte Modul).
 * Jede läuft später als Vorschlag in der Freigabe-Liste; Ausführung durch den Worker.
 */
export const AI_ACTIONS = [
  { key: 'task_update_from_mail', target: 'task', label: 'Essenz übernehmen: Aufgabe und Log aktualisieren', mode: 'proposal' },
  { key: 'doc_merge_jf', target: 'doc', label: 'Essenz in Jour-fixe-Protokoll einpflegen', mode: 'proposal' },
  { key: 'doc_merge_report', target: 'doc', label: 'Essenz in Report einpflegen', mode: 'proposal' },
  { key: 'summarize', target: 'mail', label: 'Zusammenfassen', mode: 'direct' }
] as const;

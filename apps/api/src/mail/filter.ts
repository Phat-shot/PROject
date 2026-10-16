import type { MailViewFilter } from '@projekttool/shared';
import type { IncomingMessage, MessageEnvelope } from './types.js';

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase();

function addrMatches(addr: string, patterns: string[]): boolean {
  const a = norm(addr);
  return patterns.some((p) => {
    const q = norm(p).trim();
    if (!q) return false;
    if (q.startsWith('@')) return a.endsWith(q);
    if (q.includes('@')) return a === q;
    return a.includes(q);
  });
}

/** Kopfdaten-Filter: Ordner, Absender, Empfänger, Betreff, ab Datum. */
export function headerMatches(filter: MailViewFilter, env: MessageEnvelope): boolean {
  if (filter.folders?.length && !filter.folders.map(norm).includes(norm(env.folder))) return false;
  if (filter.from?.length && !addrMatches(env.from.address, filter.from)) return false;
  if (filter.to?.length && !env.to.concat(env.cc).some((t) => addrMatches(t, filter.to!))) return false;
  if (filter.subject?.length && !filter.subject.some((s) => norm(env.subject).includes(norm(s)))) return false;
  if (filter.since && env.date < new Date(filter.since)) return false;
  return true;
}

/** Vollständiger Filter inkl. Stichwort im Text. */
export function matches(filter: MailViewFilter, msg: IncomingMessage): boolean {
  if (!headerMatches(filter, msg)) return false;
  if (filter.keyword?.length) {
    const hay = norm(msg.subject) + '\n' + norm(msg.text ?? stripHtml(msg.html));
    if (!filter.keyword.some((k) => hay.includes(norm(k)))) return false;
  }
  return true;
}

export function stripHtml(html: string | null | undefined): string {
  return (html ?? '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function snippetOf(msg: { text: string | null; html: string | null }): string {
  const t = (msg.text ?? stripHtml(msg.html)).replace(/\s+/g, ' ').trim();
  return t.slice(0, 160);
}

/** Plus-Adresse: projekt-x+t<code>@firma.de → code */
export function taskCodeFromAddresses(addresses: string[]): string | null {
  for (const a of addresses) {
    const m = /\+t([0-9a-f]{6,12})@/i.exec(a);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export function plusAddress(address: string, code: string): string {
  const [local, domain] = address.split('@');
  return `${local}+t${code}@${domain}`;
}

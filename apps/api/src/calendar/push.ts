import { HttpError } from '../errors.js';
import { outboundUrlError } from '../netGuard.js';

/**
 * Termine in den Kalender einer Person schreiben: Microsoft Graph (persönliches OAuth-Konto im Graph-Modus),
 * Google Calendar (persönliches OAuth-Konto) oder CalDAV (Nextcloud, iCloud, Fastmail … mit App-Passwort).
 * Jede Funktion legt an oder aktualisiert (externalId) und liefert die Kennung des Eintrags.
 */
export interface PushEvent { uid: string; title: string; startsAt: Date; endsAt: Date; location: string | null; description: string | null; attendees: { email: string; name?: string | null }[] }

const fail = (what: string, r: Response, j: any) => { throw new HttpError(400, `${what}: ${j?.error?.message ?? j?.error?.errors?.[0]?.message ?? r.status}${r.status === 403 ? ' (Kalender-Berechtigung fehlt, Konto unter Konfiguration neu verbinden)' : ''}`); };

export async function pushGraph(fetchFn: typeof fetch, token: string, ev: PushEvent, externalId: string | null): Promise<string> {
  const body = {
    subject: ev.title, body: { contentType: 'text', content: ev.description ?? '' },
    start: { dateTime: ev.startsAt.toISOString().replace(/Z$/, ''), timeZone: 'UTC' }, end: { dateTime: ev.endsAt.toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
    location: ev.location ? { displayName: ev.location } : undefined,
    attendees: ev.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name ?? undefined }, type: 'required' })),
    transactionId: externalId ? undefined : ev.uid
  };
  const url = externalId ? `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(externalId)}` : 'https://graph.microsoft.com/v1.0/me/events';
  const r = await fetchFn(url, { method: externalId ? 'PATCH' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) fail('Microsoft 365', r, j);
  return String(j.id ?? externalId);
}

export async function pushGoogle(fetchFn: typeof fetch, token: string, ev: PushEvent, externalId: string | null): Promise<string> {
  const body = {
    summary: ev.title, description: ev.description ?? undefined, location: ev.location ?? undefined,
    start: { dateTime: ev.startsAt.toISOString() }, end: { dateTime: ev.endsAt.toISOString() },
    attendees: ev.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined }))
  };
  const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const r = await fetchFn(externalId ? `${base}/${encodeURIComponent(externalId)}` : base, { method: externalId ? 'PATCH' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) fail('Google Kalender', r, j);
  return String(j.id ?? externalId);
}

export interface CaldavCfg { url: string; user: string; password: string }
const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);

export function caldavIcs(ev: PushEvent, sequence: number): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PROject//CalDAV//DE', 'BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${icsStamp(new Date())}`, `SEQUENCE:${sequence}`, `DTSTART:${icsStamp(ev.startsAt)}`, `DTEND:${icsStamp(ev.endsAt)}`, `SUMMARY:${esc(ev.title)}`];
  if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${esc(ev.description)}`);
  for (const a of ev.attendees) lines.push(`ATTENDEE${a.name ? `;CN=${esc(a.name)}` : ''}:mailto:${a.email}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** PUT der VEVENT-Datei in die Kalendersammlung; die Datei heißt wie die UID, ein erneuter PUT aktualisiert. */
export async function pushCaldav(fetchFn: typeof fetch, cfg: CaldavCfg, ev: PushEvent, sequence: number): Promise<string> {
  const blocked = await outboundUrlError(cfg.url);
  if (blocked) throw new HttpError(400, `CalDAV: ${blocked}`);
  const href = `${cfg.url.replace(/\/$/, '')}/${encodeURIComponent(ev.uid)}.ics`;
  const r = await fetchFn(href, { method: 'PUT', headers: { authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64'), 'content-type': 'text/calendar; charset=utf-8' }, body: caldavIcs(ev, sequence) });
  if (!r.ok && r.status !== 204 && r.status !== 201) throw new HttpError(400, `CalDAV: ${r.status === 401 ? 'Anmeldung abgelehnt (App-Passwort prüfen)' : r.status === 404 ? 'Kalender-Adresse nicht gefunden' : `HTTP ${r.status}`}`);
  return href;
}

/** Prüft Zugang und Adresse per PROPFIND (Tiefe 0). */
export async function testCaldav(fetchFn: typeof fetch, cfg: CaldavCfg): Promise<{ ok: boolean; displayName?: string | null; error?: string }> {
  const blocked = await outboundUrlError(cfg.url);
  if (blocked) return { ok: false, error: blocked };
  try {
    const r = await fetchFn(cfg.url, { method: 'PROPFIND', headers: { authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64'), depth: '0', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>' });
    if (r.status === 401) return { ok: false, error: 'Anmeldung abgelehnt (App-Passwort prüfen)' };
    if (r.status === 404) return { ok: false, error: 'Adresse nicht gefunden' };
    if (!r.ok && r.status !== 207) return { ok: false, error: `HTTP ${r.status}` };
    const text = await r.text().catch(() => '');
    if (!/calendar/i.test(text)) return { ok: false, error: 'Adresse ist keine Kalendersammlung (die Adresse des einzelnen Kalenders eintragen, nicht die des Kontos)' };
    const name = text.match(/<d:displayname[^>]*>([^<]*)<\/d:displayname>/i)?.[1] ?? null;
    return { ok: true, displayName: name };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

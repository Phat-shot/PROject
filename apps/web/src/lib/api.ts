import { CHANGED } from './events';

/** Ereignis bei HTTP 401 außerhalb der Anmeldung: die Sitzung ist abgelaufen (lib/auth.tsx fängt es ab). */
export const UNAUTHORIZED = 'pt:unauthorized';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
  /** Feldbezogene Fehler aus `details` (Fastify-Validierung oder { feld: text }), leer wenn keine. */
  get fieldErrors(): Record<string, string> { return fieldErrorsOf(this.details); }
}

/**
 * Feldfehler aus den Details einer Fehlerantwort: Fastify-Validierung ([{ instancePath: '/email', message }]),
 * Listen [{ field, message }] oder ein Objekt { feld: text }. Schlüssel ist der Feldname ohne Pfadpräfix.
 */
export function fieldErrorsOf(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!details) return out;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (!d || typeof d !== 'object') continue;
      const x = d as { instancePath?: string; field?: string; message?: string; params?: { missingProperty?: string } };
      const key = (x.instancePath ? x.instancePath.replace(/^\//, '').split('/')[0] : x.params?.missingProperty ?? x.field) ?? '';
      if (key && !out[key]) out[key] = x.message ? humanize(x.message) : 'Ungültige Eingabe';
    }
    return out;
  }
  if (typeof details === 'object') {
    for (const [k, v] of Object.entries(details as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const AJV: [RegExp, string][] = [
  [/^must NOT have fewer than (\d+) characters$/, 'Mindestens $1 Zeichen'],
  [/^must NOT have more than (\d+) characters$/, 'Höchstens $1 Zeichen'],
  [/^must have required property '(.+)'$/, 'Pflichtfeld'],
  [/^must match format "email"$/, 'Keine gültige E-Mail-Adresse'],
  [/^must match format "(.+)"$/, 'Ungültiges Format ($1)'],
  [/^must be (string|number|integer|boolean|array|object)$/, 'Ungültiger Wert'],
  [/^must be equal to one of the allowed values$/, 'Nicht erlaubter Wert'],
  [/^must be >= (\S+)$/, 'Mindestens $1'],
  [/^must be <= (\S+)$/, 'Höchstens $1']
];
function humanize(msg: string): string {
  for (const [re, de] of AJV) if (re.test(msg)) return msg.replace(re, de);
  return msg;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers: body instanceof FormData || body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin'
    });
  } catch {
    throw new ApiError(0, 'Server nicht erreichbar. Bitte Netzverbindung prüfen und erneut versuchen.');
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    const ct = res.headers.get('content-type') ?? '';
    if (!/json/i.test(ct)) throw new ApiError(res.status, `Server nicht erreichbar oder antwortet unerwartet (HTTP ${res.status})`);
    try { data = JSON.parse(text); } catch { throw new ApiError(res.status, `Server antwortet unerwartet (HTTP ${res.status})`); }
  }
  if (res.status === 401 && !url.startsWith('/auth/') && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(UNAUTHORIZED, { detail: { url } }));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? (res.statusText || `HTTP ${res.status}`), data?.details);
  // Erfolgreiche Änderung: Zähler, Glocke und Listen frischen sich auf (useRefresh)
  if (method !== 'GET' && typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED));
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url)
};

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '';
  const x = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return x.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Tabelle als CSV-Text (Semikolon, UTF-8 mit BOM für Excel). */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [header, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
}

/** Tabelle als CSV herunterladen. */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const csv = toCsv(header, rows);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

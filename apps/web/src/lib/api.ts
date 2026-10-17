export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body instanceof FormData || body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.details);
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
  return '\ufeff' + [header, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
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

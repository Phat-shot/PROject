import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, fieldErrorsOf, UNAUTHORIZED } from './api';

const res = (status: number, body: string, type = 'application/json') => new Response(body, { status, headers: { 'content-type': type } });

describe('api.request: Fehler verständlich, 401 als Ereignis', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
  afterEach(() => vi.unstubAllGlobals());

  it('liefert JSON-Antworten und meldet erfolgreiche Änderungen', async () => {
    fetchMock.mockResolvedValue(res(200, '{"ok":true}'));
    await expect(api.get<{ ok: boolean }>('/x')).resolves.toEqual({ ok: true });
  });

  it('HTML-Fehlerseite (kein JSON) wird zur verständlichen Meldung statt „Unexpected token <“', async () => {
    fetchMock.mockResolvedValue(res(502, '<html>Bad Gateway</html>', 'text/html'));
    const err: any = await api.get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/Server nicht erreichbar oder antwortet unerwartet \(HTTP 502\)/);
  });

  it('Netzwerkfehler (fetch wirft) wird abgefangen', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err: any = await api.post('/x', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Server nicht erreichbar/);
  });

  it('401 außerhalb von /auth löst das globale Ereignis aus; /auth/me nicht', async () => {
    const h = vi.fn();
    window.addEventListener(UNAUTHORIZED, h);
    fetchMock.mockResolvedValue(res(401, '{"error":"Nicht angemeldet"}'));
    await expect(api.get('/projects')).rejects.toMatchObject({ status: 401, message: 'Nicht angemeldet' });
    expect(h).toHaveBeenCalledTimes(1);
    await api.get('/auth/me').catch(() => undefined);
    expect(h).toHaveBeenCalledTimes(1);
    window.removeEventListener(UNAUTHORIZED, h);
  });

  it('Feldfehler aus details (Fastify-Validierung und { feld: text })', async () => {
    fetchMock.mockResolvedValue(res(400, JSON.stringify({ error: 'Ungültige Eingabe', details: [{ instancePath: '/email', message: 'must match format "email"' }, { instancePath: '', params: { missingProperty: 'name' }, message: "must have required property 'name'" }] })));
    const err: any = await api.post('/x', {}).catch((e) => e);
    expect(err.fieldErrors).toEqual({ email: 'Keine gültige E-Mail-Adresse', name: 'Pflichtfeld' });
    expect(fieldErrorsOf({ password: 'zu kurz' })).toEqual({ password: 'zu kurz' });
    expect(fieldErrorsOf(undefined)).toEqual({});
  });
});

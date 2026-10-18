import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import type { AccountRow } from '../src/mail/types.js';

/** Gefälschter HTTP-Client: Microsoft-Token-Endpunkt, Graph und ein OIDC-Anbieter. */
const calls: { url: string; init?: RequestInit }[] = [];
let tokenCounter = 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.startsWith('https://login.microsoftonline.com/') && url.endsWith('/token')) {
    const b = new URLSearchParams(String(init?.body));
    if (b.get('grant_type') === 'authorization_code' && b.get('code') !== 'good') return json({ error: 'invalid_grant', error_description: 'Code ungültig' }, 400);
    tokenCounter++;
    return json({ access_token: `at-${tokenCounter}`, refresh_token: `rt-${tokenCounter}`, expires_in: 3600 });
  }
  if (url.startsWith('https://graph.microsoft.com/v1.0/me?')) return json({ mail: 'Petra@Contoso.com', userPrincipalName: 'petra@contoso.com', displayName: 'Petra Contoso' });
  if (url.includes('/mailFolders?')) return json({ value: [{ id: 'f-inbox', displayName: 'Posteingang', wellKnownName: 'inbox' }, { id: 'f-sent', displayName: 'Gesendete Elemente', wellKnownName: 'sentitems' }] });
  if (url.includes('/mailFolders/f-inbox/messages?')) return json({ value: [
    { id: 'm1', internetMessageId: '<m1@contoso>', subject: 'Angebot Modul X', from: { emailAddress: { address: 'Lieferant@Example.com', name: 'Lieferant' } }, toRecipients: [{ emailAddress: { address: 'petra@contoso.com' } }], receivedDateTime: '2026-10-17T08:00:00Z', hasAttachments: true, internetMessageHeaders: [{ name: 'In-Reply-To', value: '<x@y>' }] },
    { id: 'm2', internetMessageId: '<m2@contoso>', subject: 'Newsletter', from: { emailAddress: { address: 'news@example.com' } }, toRecipients: [], receivedDateTime: '2026-10-17T09:00:00Z', hasAttachments: false }
  ] });
  if (url.includes('/messages/m1?')) return json({ body: { contentType: 'html', content: '<p>Hallo</p>' } });
  if (url.endsWith('/sendMail')) return new Response(null, { status: 202 });
  if (url.endsWith('/messages/m1/move')) return json({ id: 'm1-moved' });
  if (url === 'https://idp.example/.well-known/openid-configuration') return json({ authorization_endpoint: 'https://idp.example/auth', token_endpoint: 'https://idp.example/token', userinfo_endpoint: 'https://idp.example/userinfo' });
  if (url === 'https://idp.example/token') return json({ access_token: 'idp-at' });
  if (url === 'https://idp.example/userinfo') return json(currentUserinfo);
  return json({ error: `unbekannt: ${url}` }, 404);
};
let currentUserinfo: Record<string, unknown> = { sub: 'sub-max', email: 'Max@demo.local', name: 'Max Keller', groups: ['PM-Team', 'Alle'] };

process.env.OAUTH_MS_CLIENT_ID = 'cid';
process.env.OAUTH_MS_CLIENT_SECRET = 'secret';
process.env.PUBLIC_URL = 'https://project.example';
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

test('OAuth2 Microsoft: Start prüft Rechte und leitet mit State weiter, Rückruf legt Graph-Konto an', async () => {
  const pl = await t.login('pl@demo.local');
  const providers = await t.api(pl).get('/oauth/providers');
  assert.deepEqual(providers.json().providers.map((p: any) => p.key), ['microsoft']);

  const noRights = await t.api(await t.login('max@demo.local')).get(`/oauth/start?provider=microsoft&type=project&projectId=${t.ids.projects.web}`);
  assert.equal(noRights.statusCode, 403, 'nur PL verbindet ein Projektkonto');

  const start = await t.api(pl).get(`/oauth/start?provider=microsoft&type=project&projectId=${t.ids.projects.web}&name=Projektpostfach`);
  assert.equal(start.statusCode, 302);
  const u = new URL(start.headers.location as string);
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://project.example/api/oauth/callback/microsoft');
  assert.match(u.searchParams.get('scope') ?? '', /Mail\.ReadWrite/);
  const state = u.searchParams.get('state')!;

  const bad = await t.app.inject({ method: 'GET', url: `/api/oauth/callback/microsoft?code=wrong&state=${state}` });
  assert.match(bad.headers.location as string, /oauthError=.*Code/);
  const again = await t.app.inject({ method: 'GET', url: `/api/oauth/callback/microsoft?code=good&state=${state}` });
  assert.match(again.headers.location as string, /oauthError=/, 'State ist nur einmal gültig');

  const start2 = await t.api(pl).get(`/oauth/start?provider=microsoft&type=project&projectId=${t.ids.projects.web}&name=Projektpostfach`);
  const state2 = new URL(start2.headers.location as string).searchParams.get('state')!;
  const cb = await t.app.inject({ method: 'GET', url: `/api/oauth/callback/microsoft?code=good&state=${state2}` });
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, 'https://project.example/einstellungen/konfiguration?connected=petra%40contoso.com');
  const acc = await t.db.one<AccountRow>(`select * from mail_accounts where address = 'petra@contoso.com'`);
  assert.equal(acc.provider, 'graph');
  assert.equal(acc.oauth_provider, 'microsoft');
  assert.equal(acc.name, 'Projektpostfach');
  assert.ok(acc.oauth_refresh_token);
  assert.equal(acc.project_id, t.ids.projects.web);
  const list = await t.api(pl).get('/mail/accounts');
  const shown = list.json().accounts.find((a: any) => a.address === 'petra@contoso.com');
  assert.equal(shown.oauthProvider, 'microsoft');
  assert.equal(shown.provider, 'graph');
  assert.equal(JSON.stringify(shown).includes('rt-'), false, 'Tokens verlassen die API nicht');

  // Erneut verbinden: kein zweites Konto, Tokens erneuert
  const start3 = await t.api(pl).get(`/oauth/start?provider=microsoft&type=project&projectId=${t.ids.projects.web}`);
  const state3 = new URL(start3.headers.location as string).searchParams.get('state')!;
  await t.app.inject({ method: 'GET', url: `/api/oauth/callback/microsoft?code=good&state=${state3}` });
  const n = await t.db.one(`select count(*)::int as c from mail_accounts where address = 'petra@contoso.com'`);
  assert.equal(n.c, 1);
});

test('Graph-Adapter: Ordner, neue Mails ab Cursor (Body nur für Treffer), Versand, Verschieben; Token wird bei Ablauf aufgefrischt', async () => {
  const acc = await t.db.one<AccountRow>(`select * from mail_accounts where address = 'petra@contoso.com'`);
  await t.db.query(`update mail_accounts set oauth_expires_at = now() - interval '1 minute' where id = $1`, [acc.id]);
  const stale = await t.db.one<AccountRow>(`select * from mail_accounts where id = $1`, [acc.id]);
  const before = calls.length;
  const p = t.mail.provider(stale);
  const folders = await p.listFolders(stale);
  assert.deepEqual(folders.map((f) => [f.path, f.specialUse]), [['f-inbox', 'inbox'], ['f-sent', 'sent']]);
  const refresh = calls.slice(before).find((c) => c.url.endsWith('/token'));
  assert.ok(refresh, 'Refresh-Token-Anfrage gestellt');
  assert.equal(new URLSearchParams(String(refresh!.init?.body)).get('grant_type'), 'refresh_token');
  const fresh = await t.db.one<AccountRow>(`select * from mail_accounts where id = $1`, [acc.id]);
  assert.notEqual(fresh.oauth_access_token, stale.oauth_access_token, 'neues Zugriffstoken gespeichert');
  assert.ok(new Date(fresh.oauth_expires_at as string).getTime() > Date.now());

  const r = await p.fetchNew(fresh, { folders: ['INBOX'], headerMatches: (e) => e.from.address === 'lieferant@example.com', needsBody: false });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].html, '<p>Hallo</p>');
  assert.equal(r.messages[0].inReplyTo, '<x@y>');
  assert.equal(r.messages[0].hasAttachments, true);
  assert.equal(r.cursor.INBOX, '2026-10-17T09:00:00Z', 'Cursor = letzter Zeitstempel, auch von Nichttreffern');
  assert.equal(calls.filter((c) => c.url.includes('/messages/m2?')).length, 0, 'Body des Nichttreffers nicht geladen');

  const sent = await p.send(fresh, { from: { address: fresh.address }, to: ['kunde@example.com'], subject: 'Hi', text: 'Text', attachments: [{ filename: 'a.txt', content: Buffer.from('abc'), contentType: 'text/plain' }] });
  assert.match(sent.messageId, /@graph\.contoso\.com>$/);
  const sendCall = calls.find((c) => c.url.endsWith('/sendMail'))!;
  const body = JSON.parse(String(sendCall.init?.body));
  assert.equal(body.message.toRecipients[0].emailAddress.address, 'kunde@example.com');
  assert.equal(body.message.attachments[0].contentBytes, Buffer.from('abc').toString('base64'));
  assert.deepEqual(await p.move(fresh, { folder: 'INBOX', uid: 'm1' }, 'f-sent'), { uid: 'm1-moved' });

  // Verbindungstest über die API nutzt den Graph-Adapter
  const pl = await t.login('pl@demo.local');
  const tr = await t.api(pl).post('/mail/accounts/test', { accountId: acc.id });
  assert.equal(tr.json().imap.ok, true);
  assert.deepEqual(tr.json().imap.folders, ['Posteingang', 'Gesendete Elemente']);
});

test('OIDC: Status zeigt Anbieter, Start leitet zum IdP, Rückruf meldet bekannten Benutzer per E-Mail an und merkt sich das Subject', async () => {
  process.env.OIDC_ISSUER = 'https://idp.example/';
  process.env.OIDC_CLIENT_ID = 'pt';
  process.env.OIDC_CLIENT_SECRET = 's';
  process.env.OIDC_LABEL = 'Firmen-Login';
  const status = await t.app.inject({ method: 'GET', url: '/api/setup/status' });
  assert.deepEqual(status.json().oidc, { label: 'Firmen-Login' });

  const start = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start?next=//evil.example' });
  assert.equal(start.statusCode, 302);
  const u = new URL(start.headers.location as string);
  assert.equal(u.origin + u.pathname, 'https://idp.example/auth');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://project.example/api/auth/oidc/callback');
  const state = u.searchParams.get('state')!;

  const cb = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=c&state=${state}` });
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, 'https://project.example/', 'kein Open Redirect');
  const cookie = cb.cookies.find((c) => c.name === 'pt_session');
  assert.ok(cookie, 'Sitzung angelegt');
  const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { pt_session: cookie!.value } });
  assert.equal(me.json().user.email, 'max@demo.local');
  const row = await t.db.one(`select oidc_subject from users where email = 'max@demo.local'`);
  assert.equal(row.oidc_subject, 'sub-max');

  // Gruppen aus dem Claim: nur Gruppen mit IdP-Zuordnung werden gesetzt bzw. entfernt
  const admin = await t.login('admin@demo.local');
  const g1 = (await t.api(admin).post('/groups', { name: 'Projektleitung', idpName: 'pm-team' })).json().group;
  const g2 = (await t.api(admin).post('/groups', { name: 'Controlling', idpName: 'Controlling', memberIds: [t.ids.users.max] })).json().group;
  const g3 = (await t.api(admin).post('/groups', { name: 'Manuell', memberIds: [t.ids.users.max] })).json().group;
  assert.equal(g1.idpName, 'pm-team');
  // Gruppen als Projektmitglied folgen dem Abgleich (Regel M)
  const plc = await t.login('pl@demo.local');
  const ssoProject = (await t.api(plc).post('/projects', { key: 'SSO', name: 'SSO-Projekt' })).json().project.id;
  const ctlProject = (await t.api(plc).post('/projects', { key: 'CTL', name: 'Controlling-Projekt' })).json().project.id;
  assert.equal((await t.api(plc).put(`/projects/${ssoProject}/groups/${g1.id}`, { role: 'reader' })).statusCode, 200);
  assert.equal((await t.api(plc).put(`/projects/${ctlProject}/groups/${g2.id}`, { role: 'member' })).statusCode, 200);
  const membership = (pid: string) => t.db.maybeOne(`select role, origin from project_members where project_id = $1 and user_id = $2`, [pid, t.ids.users.max]);
  assert.deepEqual(await membership(ctlProject), { role: 'member', origin: 'group' });
  assert.equal(await membership(ssoProject), null);
  const s1b = new URL((await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start' })).headers.location as string).searchParams.get('state')!;
  await t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=c&state=${s1b}` });
  assert.deepEqual(await membership(ssoProject), { role: 'reader', origin: 'group' }, 'über die SSO-Gruppe Leser im Projekt');
  assert.equal(await membership(ctlProject), null, 'aus der Gruppe entfernt → Projektzugang über die Gruppe entfällt');
  const groups = (await t.api(admin).get('/groups')).json().groups;
  assert.ok(groups.find((g: any) => g.id === g1.id).memberIds.includes(t.ids.users.max), 'aus Claim hinzugefügt (Groß-/Kleinschreibung egal)');
  assert.ok(!groups.find((g: any) => g.id === g2.id).memberIds.includes(t.ids.users.max), 'nicht im Claim → entfernt');
  assert.ok(groups.find((g: any) => g.id === g3.id).memberIds.includes(t.ids.users.max), 'Gruppe ohne IdP-Zuordnung bleibt manuell');
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'user.groups_synced' and object_id = $1`, [t.ids.users.max]));

  // Unbekannte Person ohne Auto-Anlage: Hinweis statt Konto
  currentUserinfo = { sub: 'sub-neu', email: 'neu@example.com', name: 'Neu Nutzer' };
  const s2 = new URL((await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start' })).headers.location as string).searchParams.get('state')!;
  const cb2 = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=c&state=${s2}` });
  assert.match(cb2.headers.location as string, /\/login\?oauthError=.*Kein%20Benutzer/);
  assert.equal(await t.db.maybeOne(`select 1 from users where email = 'neu@example.com'`), null);

  // Mit Auto-Anlage: Mitglied ohne Passwort, Anmeldung nur per SSO
  process.env.OIDC_AUTO_CREATE = 'true';
  const s3 = new URL((await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start?next=/portfolio' })).headers.location as string).searchParams.get('state')!;
  const cb3 = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=c&state=${s3}` });
  assert.equal(cb3.headers.location, 'https://project.example/portfolio');
  const created = await t.db.one(`select * from users where email = 'neu@example.com'`);
  assert.equal(created.global_role, 'user');
  assert.equal(created.oidc_subject, 'sub-neu');
  const pw = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'neu@example.com', password: 'irgendwas' } });
  assert.equal(pw.statusCode, 401);
  delete process.env.OIDC_ISSUER; delete process.env.OIDC_AUTO_CREATE;
});

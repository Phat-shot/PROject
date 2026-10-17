import { useState } from 'react';
import type { User, UserSettings } from '@projekttool/shared';
import { api } from '../lib/api';
import { applyTheme, useAuth } from '../lib/auth';
import { TopBar } from '../components/Layout';
import { useAsync } from '../components/ui';
import { useData } from '../lib/useData';
import QRCode from 'qrcode';
import { useEffect } from 'react';

/** Benutzereinstellungen: Name, Sprache, Theme, Passwort. Gilt nur für die eigene Person. */
export function UserSettingsPage() {
  const { user, setUser } = useAuth();
  const s: UserSettings = user?.settings ?? {};
  const [name, setName] = useState(user?.name ?? '');
  const [theme, setTheme] = useState<NonNullable<UserSettings['theme']>>(s.theme ?? 'system');
  const [language, setLanguage] = useState<NonNullable<UserSettings['language']>>(s.language ?? 'de');
  const [mailNotifications, setMailNotifications] = useState<NonNullable<UserSettings['mailNotifications']>>(s.mailNotifications ?? 'daily');
  const [pw, setPw] = useState({ current: '', next: '', repeat: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useAsync();
  const save = (body: Record<string, unknown>, text: string) => run(async () => {
    const r = await api.patch<{ user: User }>('/me', body);
    setUser(r.user);
    applyTheme(r.user.settings?.theme ?? 'system');
    setMsg(text);
  });
  return (
    <>
      <TopBar title="Benutzereinstellungen" />
      <div className="content">
        <div className="grid cols-2">
          <div className="card">
            <h2>Profil und Darstellung</h2>
            <div className="form">
              <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label className="field"><span>E-Mail (Anmeldung)</span><input type="text" value={user?.email ?? ''} readOnly /></label>
              <label className="field"><span>Theme</span>
                <select value={theme} onChange={(e) => { const v = e.target.value as NonNullable<UserSettings['theme']>; setTheme(v); applyTheme(v); }}>
                  <option value="system">wie System</option><option value="light">hell</option><option value="dark">dunkel</option>
                </select></label>
              <label className="field"><span>Sprache</span>
                <select value={language} onChange={(e) => setLanguage(e.target.value as NonNullable<UserSettings['language']>)}>
                  <option value="de">Deutsch</option><option value="en">English (Oberfläche folgt)</option>
                </select></label>
              <label className="field"><span>Meldungen per Mail</span>
                <select value={mailNotifications} onChange={(e) => setMailNotifications(e.target.value as NonNullable<UserSettings['mailNotifications']>)}>
                  <option value="daily">täglich als Digest (ab 7 Uhr)</option><option value="immediate">sofort, gesammelt pro Minute</option><option value="off">aus, nur in der App</option>
                </select>
                <span className="muted" style={{ fontWeight: 400 }}>Versand über das Org-Postfach; was in der App schon gelesen ist, wird nicht mehr verschickt.</span></label>
              {error && <div className="error">{error}</div>}
              {msg && <div className="muted small">{msg}</div>}
              <div><button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save({ name, settings: { theme, language, mailNotifications } }, 'Gespeichert.')}>Speichern</button></div>
            </div>
          </div>
          <TotpCard />
          <IcsCard />
          <div className="card">
            <h2>Passwort ändern</h2>
            <div className="form">
              <label className="field"><span>Aktuelles Passwort</span><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
              <label className="field"><span>Neues Passwort (mindestens 10 Zeichen)</span><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
              <label className="field"><span>Wiederholen</span><input type="password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} /></label>
              {pw.repeat && pw.next !== pw.repeat && <div className="small" style={{ color: 'var(--danger)' }}>Passwörter stimmen nicht überein.</div>}
              <div><button className="btn" disabled={busy || !pw.current || pw.next.length < 10 || pw.next !== pw.repeat} onClick={() => void save({ password: pw.next, currentPassword: pw.current }, 'Passwort geändert. Andere Sitzungen wurden abgemeldet.').then(() => setPw({ current: '', next: '', repeat: '' }))}>Passwort ändern</button></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}


/** Kalender-Abo: persönliche ICS-Adresse für Outlook, Google, Apple; neu erzeugen macht alte Abos ungültig. */
function IcsCard() {
  const d = useData<{ token: string | null; urls: { all: string } | null }>('/me/ics-token');
  const { busy, error, run } = useAsync();
  const [msg, setMsg] = useState<string | null>(null);
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); setMsg('Adresse kopiert.'); } catch { setMsg(s); } };
  return (
    <div className="card">
      <h2>Kalender-Abo</h2>
      <p className="muted small">Deadlines, Starts und Meilensteine deiner Projekte als Abo in Outlook, Google oder Apple Kalender. Die Adresse ist dein persönlicher Schlüssel, nicht weitergeben.</p>
      {d.data?.urls ? (
        <div className="stack">
          <code style={{ wordBreak: 'break-all' }}>{d.data.urls.all}</code>
          <div className="row"><button className="btn sm" onClick={() => void copy(d.data!.urls!.all)}>Adresse kopieren</button><button className="btn sm link" disabled={busy} onClick={() => void run(async () => { await api.post('/me/ics-token'); await d.reload(); setMsg('Neue Adresse erzeugt, alte Abos sind ungültig.'); })}>Neu erzeugen</button></div>
        </div>
      ) : <button className="btn sm primary" disabled={busy || !d.data} onClick={() => void run(async () => { await api.post('/me/ics-token'); await d.reload(); })}>Abo-Adresse erzeugen</button>}
      {error && <div className="error mt">{error}</div>}
      {msg && <div className="muted small mt">{msg}</div>}
    </div>
  );
}


/** Zweiter Faktor: QR-Code für die Authenticator-App, Bestätigung mit Code, Abschalten mit Passwort. */
function TotpCard() {
  const { user, setUser } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauth: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const { busy, error, run } = useAsync();
  const enabled = Boolean(user?.totpEnabled);
  useEffect(() => { setSetup(null); setCode(''); }, [enabled]);
  return (
    <div className="card">
      <h2>Zweiter Faktor (Authenticator-App) {enabled && <span className="badge ok">aktiv</span>}</h2>
      {!enabled && !setup && <>
        <p className="muted small">Beim Anmelden wird zusätzlich ein 6-stelliger Code aus einer App wie Microsoft Authenticator, Google Authenticator oder 1Password verlangt.</p>
        <button className="btn sm primary" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ secret: string; otpauth: string }>('/me/totp/setup'); setSetup({ ...r, qr: await QRCode.toDataURL(r.otpauth, { margin: 1, width: 180 }) }); })}>Einrichten</button>
      </>}
      {!enabled && setup && <div className="form">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <img src={setup.qr} alt="QR-Code für die Authenticator-App" width={180} height={180} style={{ borderRadius: 6, border: '1px solid var(--border)' }} />
          <div className="small stack"><span>1. QR-Code in der App scannen oder Schlüssel eingeben:</span><code style={{ wordBreak: 'break-all' }}>{setup.secret}</code><span>2. Den angezeigten Code hier bestätigen.</span></div>
        </div>
        <label className="field"><span>Code aus der App</span><input type="text" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ width: 120 }} /></label>
        <div className="row"><button className="btn sm primary" disabled={busy || code.length !== 6} onClick={() => void run(async () => { await api.post('/me/totp/enable', { code }); if (user) setUser({ ...user, totpEnabled: true }); })}>Aktivieren</button><button className="btn sm" onClick={() => setSetup(null)}>Abbrechen</button></div>
      </div>}
      {enabled && <div className="form">
        <p className="muted small">Zum Abschalten dein Passwort eingeben. Bei verlorenem Gerät kann der Org-Admin den zweiten Faktor in der Verwaltung zurücksetzen.</p>
        <div className="row"><input type="password" placeholder="Passwort" value={pw} autoComplete="current-password" onChange={(e) => setPw(e.target.value)} style={{ width: 200 }} /><button className="btn sm danger" disabled={busy || !pw} onClick={() => void run(async () => { await api.post('/me/totp/disable', { password: pw }); setPw(''); if (user) setUser({ ...user, totpEnabled: false }); })}>Abschalten</button></div>
      </div>}
      {error && <div className="error mt">{error}</div>}
    </div>
  );
}

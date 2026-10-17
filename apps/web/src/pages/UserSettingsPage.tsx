import { useState } from 'react';
import type { User, UserSettings } from '@projekttool/shared';
import { api } from '../lib/api';
import { applyTheme, useAuth } from '../lib/auth';
import { TopBar } from '../components/Layout';
import { useAsync } from '../components/ui';

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

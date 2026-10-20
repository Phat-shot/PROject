import { useEffect, useState } from 'react';
import type { Project, User, UserSettings } from '@projekttool/shared';
import { api } from '../lib/api';
import { applyTheme, useAuth } from '../lib/auth';
import { TopBar } from '../components/Layout';
import { useAsync } from '../components/ui';
import { useData } from '../lib/useData';
import { MyNotifyCard } from '../components/NotifyRules';
import { AbsencesCard } from '../components/Resources';
import { AccountsCard } from '../components/mail/Accounts';
import { SettingsCard, SettingsRoutes, settingsTabLinks, useFlash, type SettingsTab } from '../components/settings/Settings';
import QRCode from 'qrcode';

const BASE = '/einstellungen';

/**
 * Meine Einstellungen (Konzept Einstellungen 4.2): Allgemein (Profil, Darstellung, Chat, angeheftete Projekte), Mail (eigene Konten),
 * Benachrichtigungen, Kalender (Abo, CalDAV, Abwesenheiten), Sicherheit (Passwort, zweiter Faktor). Gilt nur für die eigene Person.
 */
export function UserSettingsPage() {
  const tabs: SettingsTab[] = [
    { key: 'allgemein', label: 'Allgemein', element: <><ProfileCard /><PinsCard /></> },
    { key: 'mail', label: 'Mail', element: <AccountsCard scope="personal" /> },
    { key: 'benachrichtigungen', label: 'Benachrichtigungen', element: <MyNotifyCard /> },
    { key: 'kalender', label: 'Kalender', element: <><IcsCard /><CaldavCard /><AbsencesCard /></> },
    { key: 'sicherheit', label: 'Sicherheit', element: <><PasswordCard /><TotpCard /></> }
  ];
  return (
    <>
      <TopBar title="Meine Einstellungen" tabs={settingsTabLinks(BASE, tabs)} />
      <SettingsRoutes tabs={tabs} />
    </>
  );
}

/** Name, Theme und Bestätigungskarten der Agenten im Chat; ein Formular, ein Speichern. */
function ProfileCard() {
  const { user, setUser } = useAuth();
  const s: UserSettings = user?.settings ?? {};
  const [name, setName] = useState(user?.name ?? '');
  const [theme, setTheme] = useState<NonNullable<UserSettings['theme']>>(s.theme ?? 'system');
  const [chatCards, setChatCards] = useState<NonNullable<UserSettings['chatCards']>>(s.chatCards ?? 'needed');
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash();
  const dirty = name !== (user?.name ?? '') || theme !== (s.theme ?? 'system') || chatCards !== (s.chatCards ?? 'needed');
  return (
    <SettingsCard title="Profil und Darstellung">
      <div className="form cols-2">
        <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>E-Mail (Anmeldung)</span><input type="text" value={user?.email ?? ''} readOnly /></label>
        <label className="field"><span>Theme</span>
          <select value={theme} onChange={(e) => { const v = e.target.value as NonNullable<UserSettings['theme']>; setTheme(v); applyTheme(v); }}>
            <option value="system">wie System</option><option value="light">hell</option><option value="dark">dunkel</option>
          </select></label>
        <label className="field"><span>Bestätigungskarten der Agenten im Chat</span>
          <select value={chatCards} onChange={(e) => setChatCards(e.target.value as NonNullable<UserSettings['chatCards']>)}>
            <option value="needed">nur wenn nötig (abgelehnt, angehalten, Auftrag, Bestätigung)</option><option value="all">auch für Kleinigkeiten (Notiz, Priorität …)</option>
          </select></label>
        {error && <div className="error full">{error}</div>}
        <div className="full row"><button className="btn primary sm" disabled={busy || !dirty || !name.trim()} onClick={() => void run(async () => {
          const r = await api.patch<{ user: User }>('/me', { name, settings: { theme, chatCards } });
          setUser(r.user); applyTheme(r.user.settings?.theme ?? 'system'); flash('Gespeichert.');
        })}>Speichern</button>{msg && <span className="muted small">{msg}</span>}</div>
      </div>
    </SettingsCard>
  );
}

const MAX_PINNED = 5;

/** Angeheftete Projekte der Seitenleiste (höchstens fünf, in dieser Reihenfolge); der Stern in der Leiste bleibt der schnelle Weg. */
function PinsCard() {
  const { user, setUser } = useAuth();
  const projects = useData<{ projects: Project[] }>('/projects');
  const { busy, error, run } = useAsync();
  const active = (projects.data?.projects ?? []).filter((p) => p.status === 'active');
  const ids = (user?.settings?.pinnedProjects ?? []).filter((id) => active.some((p) => p.id === id));
  const pinned = ids.map((id) => active.find((p) => p.id === id)!);
  const free = active.filter((p) => !ids.includes(p.id));
  const [add, setAdd] = useState('');
  const save = (next: string[]) => run(async () => { const r = await api.patch<{ user: User }>('/me', { settings: { pinnedProjects: next } }); setUser(r.user); });
  const move = (i: number, d: -1 | 1) => { const n = [...ids]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; void save(n); };
  return (
    <SettingsCard title="Angeheftete Projekte" hint={`Stehen immer oben in der Seitenleiste, höchstens ${MAX_PINNED}. Ohne Auswahl zeigt die Leiste die ersten ${MAX_PINNED} aktiven Projekte.`}>
      {error && <div className="error mb">{error}</div>}
      {pinned.length === 0 ? <div className="muted small mb">Nichts angeheftet.</div> : <table className="table mb"><tbody>
        {pinned.map((p, i) => <tr key={p.id}><td><span className="badge" style={{ marginRight: 6 }}>{p.key}</span>{p.name}</td>
          <td className="nowrap"><button className="btn sm link" disabled={busy || i === 0} aria-label={`${p.key} nach oben`} onClick={() => move(i, -1)}>↑</button><button className="btn sm link" disabled={busy || i === pinned.length - 1} aria-label={`${p.key} nach unten`} onClick={() => move(i, 1)}>↓</button><button className="btn sm link" disabled={busy} aria-label={`${p.key} lösen`} onClick={() => void save(ids.filter((x) => x !== p.id))}>✕</button></td></tr>)}
      </tbody></table>}
      {ids.length < MAX_PINNED && free.length > 0 && <div className="row small">
        <select aria-label="Projekt anheften" value={add} style={{ width: 'auto' }} onChange={(e) => setAdd(e.target.value)}><option value="">– Projekt –</option>{free.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</select>
        <button className="btn sm" disabled={busy || !add} onClick={() => { void save([...ids, add]); setAdd(''); }}>Anheften</button>
      </div>}
    </SettingsCard>
  );
}

/** Passwort ändern; danach sind andere Sitzungen abgemeldet. */
function PasswordCard() {
  const [pw, setPw] = useState({ current: '', next: '', repeat: '' });
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash(8000);
  return (
    <SettingsCard title="Passwort ändern">
      <div className="form">
        <label className="field"><span>Aktuelles Passwort</span><input type="password" value={pw.current} autoComplete="current-password" onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
        <label className="field"><span>Neues Passwort (mindestens 10 Zeichen)</span><input type="password" value={pw.next} autoComplete="new-password" onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
        <label className="field"><span>Wiederholen</span><input type="password" value={pw.repeat} autoComplete="new-password" onChange={(e) => setPw({ ...pw, repeat: e.target.value })} /></label>
        {pw.repeat && pw.next !== pw.repeat && <div className="small" style={{ color: 'var(--danger)' }}>Passwörter stimmen nicht überein.</div>}
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn sm" disabled={busy || !pw.current || pw.next.length < 10 || pw.next !== pw.repeat} onClick={() => void run(async () => { await api.patch('/me', { password: pw.next, currentPassword: pw.current }); setPw({ current: '', next: '', repeat: '' }); flash('Passwort geändert. Andere Sitzungen wurden abgemeldet.'); })}>Passwort ändern</button>{msg && <span className="muted small">{msg}</span>}</div>
      </div>
    </SettingsCard>
  );
}

/** Kalender-Abo: persönliche ICS-Adresse für Outlook, Google, Apple; neu erzeugen macht alte Abos ungültig. */
function IcsCard() {
  const d = useData<{ token: string | null; urls: { all: string } | null }>('/me/ics-token');
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash();
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); flash('Adresse kopiert.'); } catch { flash(s); } };
  return (
    <SettingsCard title="Kalender-Abo" hint="Deadlines, Starts und Meilensteine deiner Projekte als Abo in Outlook, Google oder Apple Kalender. Die Adresse ist dein persönlicher Schlüssel, nicht weitergeben.">
      {d.data?.urls ? (
        <div className="stack">
          <code style={{ wordBreak: 'break-all' }}>{d.data.urls.all}</code>
          <div className="row"><button className="btn sm" onClick={() => void copy(d.data!.urls!.all)}>Adresse kopieren</button><button className="btn sm link" disabled={busy} onClick={() => void run(async () => { await api.post('/me/ics-token'); await d.reload(); flash('Neue Adresse erzeugt, alte Abos sind ungültig.'); })}>Neu erzeugen</button></div>
        </div>
      ) : <button className="btn sm primary" disabled={busy || !d.data} onClick={() => void run(async () => { await api.post('/me/ics-token'); await d.reload(); })}>Abo-Adresse erzeugen</button>}
      {error && <div className="error mt">{error}</div>}
      {msg && <div className="muted small mt">{msg}</div>}
    </SettingsCard>
  );
}

/** CalDAV-Kalender (Nextcloud, iCloud, Fastmail …): Adresse des Kalenders, Benutzer, App-Passwort; Termine aus Besprechungen landen dort. */
function CaldavCard() {
  const d = useData<{ targets: { key: string; label: string }[]; caldav: { url: string; user: string } | null }>('/me/calendar-targets');
  const [f, setF] = useState({ url: '', user: '', password: '' });
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash(8000);
  useEffect(() => { if (d.data?.caldav) setF((x) => ({ ...x, url: d.data!.caldav!.url, user: d.data!.caldav!.user })); }, [d.data]);
  const oauth = (d.data?.targets ?? []).filter((t) => t.key !== 'caldav');
  return (
    <SettingsCard title="Kalender schreiben" hint="Besprechungen lassen sich mit einem Klick in deinen Kalender eintragen. Microsoft 365 und Google gehen über dein persönliches Mail-Konto (Reiter Mail › Mit Microsoft 365/Google verbinden, Kalender-Berechtigung muss enthalten sein). Für Nextcloud, iCloud, Fastmail und andere hier den CalDAV-Zugang eintragen: Adresse des einzelnen Kalenders, Benutzername und App-Passwort.">
      {oauth.length > 0 && <p className="small">Verbunden: {oauth.map((t) => <span key={t.key} className="badge ok" style={{ marginRight: 4 }}>{t.label}</span>)}</p>}
      <div className="form cols-2">
        <label className="field full"><span>CalDAV-Kalenderadresse</span><input type="url" value={f.url} placeholder="https://cloud.example.de/remote.php/dav/calendars/petra/personal/" onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
        <label className="field"><span>Benutzername</span><input type="text" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} /></label>
        <label className="field"><span>App-Passwort{d.data?.caldav && <span className="muted"> (leer = unverändert)</span>}</span><input type="password" value={f.password} autoComplete="new-password" onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {error && <div className="error full">{error}</div>}
        {msg && <div className="small full">{msg}</div>}
        <div className="full row">
          <button className="btn primary sm" disabled={busy || !f.url || !f.user || (!f.password && !d.data?.caldav)} onClick={() => void run(async () => { const r = await api.put<{ ok: boolean; test: { ok: boolean; displayName?: string | null; error?: string } }>('/me/caldav', f); flash(r.ok ? `Verbindung ok${r.test.displayName ? ` („${r.test.displayName}“)` : ''}.` : `Gespeichert, aber Prüfung fehlgeschlagen: ${r.test.error}`); setF({ ...f, password: '' }); await d.reload(); })}>Speichern und prüfen</button>
          {d.data?.caldav && <button className="btn sm danger" disabled={busy} onClick={() => void run(async () => { await api.del('/me/caldav'); setF({ url: '', user: '', password: '' }); flash('CalDAV entfernt.'); await d.reload(); })}>Entfernen</button>}
        </div>
      </div>
    </SettingsCard>
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
    <SettingsCard title={<>Zweiter Faktor (Authenticator-App) {enabled && <span className="badge ok">aktiv</span>}</>}>
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
    </SettingsCard>
  );
}

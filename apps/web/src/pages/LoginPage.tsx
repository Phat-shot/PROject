import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Button } from '../components/ui';

const DEMO = [
  ['pl@demo.local', 'Petra Lenz · PL Website-Relaunch'],
  ['anna@demo.local', 'Anna Berger · Stellvertretung, PL ERP'],
  ['max@demo.local', 'Max Keller · Mitglied'],
  ['leser@demo.local', 'Lea Reuter · Leser'],
  ['admin@demo.local', 'Alex Admin · Org-Admin, kein Projektmitglied']
];

/** Anmeldung; Demo-Zugänge nur, wenn Demodaten vorhanden sind. „Passwort vergessen“ schickt einen Link über das Org-Postfach. */
export function LoginPage() {
  const { login, loginTotp, sessionExpired } = useAuth();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [demo, setDemo] = useState(false);
  const [oidc, setOidc] = useState<{ label: string } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ demo?: boolean; oidc?: { label: string } | null }>('/setup/status').then((r) => { if (r.demo) { setDemo(true); /* nur vorbelegen, solange noch nichts eingegeben ist */ setEmail((e) => e || 'pl@demo.local'); setPassword((p) => p || 'demo1234'); } setOidc(r.oidc ?? null); }).catch(() => undefined);
    const err = new URLSearchParams(window.location.search).get('oauthError');
    if (err) setError(err);
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        await loginTotp(challenge, code);
      } else if (forgot) {
        const r = await api.post<{ sent: boolean; error?: string }>('/auth/forgot', { email });
        setSent(r.sent ? `Falls ein Konto für ${email} existiert, ist ein Link unterwegs (2 Stunden gültig).` : r.error ?? 'Nicht verschickt.');
      } else {
        const r = await login(email, password);
        if (r && r.mfaRequired && r.challenge) { setChallenge(r.challenge); setCode(''); }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>PROject</h1>
        <p className="muted">Arbeitspakete, Mail und Doku auf einem Datenmodell</p>
        {sessionExpired && <div className="notice mb" role="status">Deine Sitzung ist abgelaufen. Bitte melde dich erneut an; du landest danach wieder an der Stelle, an der du warst.</div>}
        {challenge ? (
          <div className="form">
            <p className="muted small">Zweiter Faktor: Code aus deiner Authenticator-App für {email}.</p>
            <label className="field"><span className="req">Code (6 Stellen)</span><input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={code} autoFocus required aria-required="true" onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
            {error && <div className="error" role="alert">{error}</div>}
            <div className="row"><Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>Anmelden</Button><Button variant="link" className="small right" onClick={() => { setChallenge(null); setError(null); }}>Zurück</Button></div>
          </div>
        ) : (
        <div className="form">
          <label className="field"><span className="req">E-Mail</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" required aria-required="true" /></label>
          {!forgot && <label className="field"><span className="req">Passwort</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required aria-required="true" /></label>}
          {error && <div className="error" role="alert">{error}</div>}
          {sent && <div className="success small" role="status">{sent}</div>}
          <div className="row">
            <Button type="submit" variant="primary" loading={busy} disabled={!email || (!forgot && !password)}>{forgot ? 'Link anfordern' : 'Anmelden'}</Button>
            <Button variant="link" className="small right" onClick={() => { setForgot(!forgot); setSent(null); setError(null); }}>{forgot ? 'Zurück zur Anmeldung' : 'Passwort vergessen?'}</Button>
          </div>
          {oidc && !forgot && <div className="row mt-1"><a className="btn oidc-btn" href="/api/auth/oidc/start">Anmelden mit {oidc.label}</a></div>}
        </div>
        )}
        {demo && (
          <div className="demo">
            Demo-Zugänge (Passwort <code>demo1234</code>):
            <ul className="demo-list">
              {DEMO.map(([m, l]) => <li key={m}><code onClick={() => { setEmail(m); setPassword('demo1234'); }}>{m}</code> – {l}</li>)}
            </ul>
          </div>
        )}
      </form>
    </div>
  );
}

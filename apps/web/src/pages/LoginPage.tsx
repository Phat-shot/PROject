import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';

const DEMO = [
  ['pl@demo.local', 'Petra Lenz · PL Website-Relaunch'],
  ['anna@demo.local', 'Anna Berger · Stellvertretung, PL ERP'],
  ['max@demo.local', 'Max Keller · Mitglied'],
  ['leser@demo.local', 'Lea Reuter · Leser'],
  ['admin@demo.local', 'Alex Admin · Org-Admin, kein Projektmitglied']
];

/** Anmeldung; Demo-Zugänge nur, wenn Demodaten vorhanden sind. „Passwort vergessen“ schickt einen Link über das Org-Postfach. */
export function LoginPage() {
  const { login } = useAuth();
  const [demo, setDemo] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => { api.get<{ demo?: boolean }>('/setup/status').then((r) => { if (r.demo) { setDemo(true); setEmail('pl@demo.local'); setPassword('demo1234'); } }).catch(() => undefined); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (forgot) {
        const r = await api.post<{ sent: boolean; error?: string }>('/auth/forgot', { email });
        setSent(r.sent ? `Falls ein Konto für ${email} existiert, ist ein Link unterwegs (2 Stunden gültig).` : r.error ?? 'Nicht verschickt.');
      } else {
        await login(email, password);
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
        <div className="form">
          <label className="field"><span>E-Mail</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" /></label>
          {!forgot && <label className="field"><span>Passwort</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>}
          {error && <div className="error">{error}</div>}
          {sent && <div className="success small">{sent}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy || !email || (!forgot && !password)}>{forgot ? 'Link anfordern' : 'Anmelden'}</button>
            <button type="button" className="btn link small right" onClick={() => { setForgot(!forgot); setSent(null); setError(null); }}>{forgot ? 'Zurück zur Anmeldung' : 'Passwort vergessen?'}</button>
          </div>
        </div>
        {demo && (
          <div className="demo">
            Demo-Zugänge (Passwort <code>demo1234</code>):
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {DEMO.map(([m, l]) => <li key={m}><code onClick={() => { setEmail(m); setPassword('demo1234'); }}>{m}</code> – {l}</li>)}
            </ul>
          </div>
        )}
      </form>
    </div>
  );
}

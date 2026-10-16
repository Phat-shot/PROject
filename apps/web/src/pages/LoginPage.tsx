import { useState } from 'react';
import { useAuth } from '../lib/auth';

const DEMO = [
  ['pl@demo.local', 'Petra Lenz · PL Website-Relaunch'],
  ['anna@demo.local', 'Anna Berger · Stellvertretung, PL ERP'],
  ['max@demo.local', 'Max Keller · Mitglied'],
  ['leser@demo.local', 'Lea Reuter · Leser'],
  ['admin@demo.local', 'Alex Admin · Org-Admin, kein Projektmitglied']
];

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('pl@demo.local');
  const [password, setPassword] = useState('demo1234');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Projekttool</h1>
        <p className="muted">Alpha · Aufgaben, Mail und Doku auf einem Datenmodell</p>
        <div className="form">
          <label className="field"><span>E-Mail</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
          <label className="field"><span>Passwort</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" disabled={busy}>Anmelden</button>
        </div>
        <div className="demo">
          Demo-Zugänge (Passwort <code>demo1234</code>):
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {DEMO.map(([m, l]) => <li key={m}><code onClick={() => setEmail(m)}>{m}</code> – {l}</li>)}
          </ul>
        </div>
      </form>
    </div>
  );
}

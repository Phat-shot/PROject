import { useState } from 'react';
import { api } from '../lib/api';

/** Ersteinrichtung: Mandant und Org-Admin anlegen, solange noch kein Benutzer existiert. */
export function SetupPage({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ orgName: '', name: '', email: '', password: '', password2: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.password !== f.password2) { setError('Passwörter stimmen nicht überein'); return; }
    setBusy(true); setError(null);
    try {
      await api.post('/setup', { orgName: f.orgName, name: f.name, email: f.email, password: f.password });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit} style={{ width: 420 }}>
        <h1>Ersteinrichtung</h1>
        <p className="muted">Noch kein Benutzer vorhanden. Lege den Mandanten und den ersten Org-Admin an. Danach ist diese Seite gesperrt.</p>
        <div className="form">
          <label className="field"><span>Firma / Mandant</span><input type="text" value={f.orgName} onChange={(e) => setF({ ...f, orgName: e.target.value })} autoFocus /></label>
          <label className="field"><span>Dein Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>E-Mail (Login)</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="field"><span>Passwort (mindestens 10 Zeichen)</span><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
          <label className="field"><span>Passwort wiederholen</span><input type="password" value={f.password2} onChange={(e) => setF({ ...f, password2: e.target.value })} /></label>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" disabled={busy || !f.orgName || !f.name || !f.email || !f.password}>Anlegen und anmelden</button>
        </div>
        <p className="muted small mt">Weitere Benutzer legst du danach unter „Verwaltung“ an; Projekte erstellen Projektersteller oder Org-Admins.</p>
      </form>
    </div>
  );
}

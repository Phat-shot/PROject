import { useState } from 'react';
import { api } from '../lib/api';
import { Button, FieldError, useAsync } from '../components/ui';

const MIN_PW = 10;

/** Ersteinrichtung: Mandant und Org-Admin anlegen, solange noch kein Benutzer existiert. */
export function SetupPage({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ orgName: '', name: '', email: '', password: '', password2: '' });
  const { busy, error, fieldErrors, run } = useAsync();
  const mismatch = f.password2.length > 0 && f.password !== f.password2;
  const tooShort = f.password.length > 0 && f.password.length < MIN_PW;
  const ok = f.orgName.trim() && f.name.trim() && f.email.trim() && f.password.length >= MIN_PW && f.password === f.password2;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    void run(async () => { await api.post('/setup', { orgName: f.orgName, name: f.name, email: f.email, password: f.password }); onDone(); });
  };
  const fe = (k: string) => fieldErrors[k];
  return (
    <div className="login">
      <form className="card setup-card" onSubmit={submit} noValidate>
        <h1>Ersteinrichtung</h1>
        <p className="muted">Noch kein Benutzer vorhanden. Lege den Mandanten und den ersten Org-Admin an. Danach ist diese Seite gesperrt.</p>
        <div className="form">
          <label className="field"><span className="req">Firma / Mandant</span><input type="text" value={f.orgName} required aria-required="true" aria-invalid={Boolean(fe('orgName')) || undefined} onChange={(e) => setF({ ...f, orgName: e.target.value })} autoFocus /><FieldError error={fe('orgName')} /></label>
          <label className="field"><span className="req">Dein Name</span><input type="text" value={f.name} required aria-required="true" aria-invalid={Boolean(fe('name')) || undefined} onChange={(e) => setF({ ...f, name: e.target.value })} /><FieldError error={fe('name')} /></label>
          <label className="field"><span className="req">E-Mail (Login)</span><input type="email" value={f.email} required aria-required="true" autoComplete="username" aria-invalid={Boolean(fe('email')) || undefined} onChange={(e) => setF({ ...f, email: e.target.value })} /><FieldError error={fe('email')} /></label>
          <label className="field"><span className="req">Passwort (mindestens {MIN_PW} Zeichen)</span><input type="password" value={f.password} required aria-required="true" minLength={MIN_PW} autoComplete="new-password" aria-invalid={tooShort || Boolean(fe('password')) || undefined} onChange={(e) => setF({ ...f, password: e.target.value })} /><FieldError error={fe('password') ?? (tooShort ? `Noch ${MIN_PW - f.password.length} Zeichen` : null)} /></label>
          <label className="field"><span className="req">Passwort wiederholen</span><input type="password" value={f.password2} required aria-required="true" autoComplete="new-password" aria-invalid={mismatch || undefined} onChange={(e) => setF({ ...f, password2: e.target.value })} /><FieldError error={mismatch ? 'Passwörter stimmen nicht überein.' : null} /></label>
          {error && !Object.keys(fieldErrors).length && <div className="error" role="alert">{error}</div>}
          <Button type="submit" variant="primary" loading={busy} disabled={!ok}>Anlegen und anmelden</Button>
        </div>
        <p className="muted small mt">Weitere Benutzer legst du danach unter „Verwaltung“ an; Projekte erstellen Projektersteller oder Org-Admins.</p>
      </form>
    </div>
  );
}

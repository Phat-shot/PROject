import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Button, FieldError, Loading, useAsync } from '../components/ui';

const MIN_PW = 10;

/** Öffentliche Seite: Einladung annehmen, Passwort setzen, danach direkt angemeldet. */
export function AcceptInvitePage({ token }: { token: string }) {
  const [inv, setInv] = useState<{ email: string; name: string; orgName: string } | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { busy, error, fieldErrors, run } = useAsync();
  useEffect(() => {
    api.get<{ email: string; name: string; orgName: string }>(`/invitations/accept/${token}`).then((r) => { setInv(r); setName(r.name); }).catch((e) => setNotFound(e.message));
  }, [token]);
  if (notFound) return <div className="login"><div className="card"><h1>PROject</h1><div className="error" role="alert">{notFound}</div><p className="muted small">Bitte beim Org-Admin eine neue Einladung anfordern.</p><a className="btn" href="/">Zur Anmeldung</a></div></div>;
  if (!inv) return <div className="login"><div className="card"><Loading /></div></div>;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const tooShort = pw.length > 0 && pw.length < MIN_PW;
  const ok = pw.length >= MIN_PW && pw === pw2 && name.trim();
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (!ok) return; void run(async () => { await api.post(`/invitations/accept/${token}`, { name, password: pw }); window.location.href = '/'; }); };
  return (
    <div className="login">
      <form className="card setup-card" onSubmit={submit} noValidate>
        <h1>PROject</h1>
        <p className="muted">{inv.orgName} · Einladung für <strong>{inv.email}</strong></p>
        <div className="form">
          <label className="field"><span className="req">Name</span><input type="text" value={name} required aria-required="true" aria-invalid={Boolean(fieldErrors.name) || undefined} onChange={(e) => setName(e.target.value)} /><FieldError error={fieldErrors.name} /></label>
          <label className="field"><span className="req">Passwort (mindestens {MIN_PW} Zeichen)</span><input type="password" value={pw} required aria-required="true" minLength={MIN_PW} autoComplete="new-password" aria-invalid={tooShort || Boolean(fieldErrors.password) || undefined} onChange={(e) => setPw(e.target.value)} autoFocus /><FieldError error={fieldErrors.password ?? (tooShort ? `Noch ${MIN_PW - pw.length} Zeichen` : null)} /></label>
          <label className="field"><span className="req">Passwort wiederholen</span><input type="password" value={pw2} required aria-required="true" autoComplete="new-password" aria-invalid={mismatch || undefined} onChange={(e) => setPw2(e.target.value)} /><FieldError error={mismatch ? 'Passwörter stimmen nicht überein.' : null} /></label>
          {error && !Object.keys(fieldErrors).length && <div className="error" role="alert">{error}</div>}
          <div><Button type="submit" variant="primary" loading={busy} disabled={!ok}>Konto anlegen und anmelden</Button></div>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Button, FieldError } from '../components/ui';

const MIN_PW = 10;

/** Öffentliche Seite /passwort/:token: neues Passwort setzen, danach angemeldet (mit zweitem Faktor: danach normal anmelden). */
export function ResetPasswordPage({ token }: { token: string }) {
  const [info, setInfo] = useState<{ email: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pw, setPw] = useState({ next: '', repeat: '' });
  const [busy, setBusy] = useState(false);
  const [mfaDone, setMfaDone] = useState(false);
  useEffect(() => { api.get<{ email: string; name: string }>(`/auth/reset/${token}`).then(setInfo).catch((e) => setError(e.message)); }, [token]);
  const mismatch = pw.repeat.length > 0 && pw.next !== pw.repeat;
  const tooShort = pw.next.length > 0 && pw.next.length < MIN_PW;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ mfaRequired?: boolean }>(`/auth/reset/${token}`, { password: pw.next });
      if (r?.mfaRequired) { setMfaDone(true); setBusy(false); } else window.location.href = '/';
    }
    catch (err: any) { setError(err.message); setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit} noValidate>
        <h1>Neues Passwort</h1>
        {error && !info && <><div className="error mb" role="alert">{error}</div><a href="/">Zur Anmeldung</a></>}
        {mfaDone && <><p>Passwort gesetzt. Bitte jetzt mit dem neuen Passwort und dem Code aus der Authenticator-App anmelden.</p><a className="btn primary" href="/">Zur Anmeldung</a></>}
        {info && !mfaDone && (
          <div className="form">
            <p className="muted">Für {info.name} ({info.email}).</p>
            <label className="field"><span className="req">Neues Passwort (mindestens {MIN_PW} Zeichen)</span><input type="password" value={pw.next} autoFocus required aria-required="true" minLength={MIN_PW} autoComplete="new-password" aria-invalid={tooShort || undefined} onChange={(e) => setPw({ ...pw, next: e.target.value })} /><FieldError error={tooShort ? `Noch ${MIN_PW - pw.next.length} Zeichen` : null} /></label>
            <label className="field"><span className="req">Wiederholen</span><input type="password" value={pw.repeat} required aria-required="true" autoComplete="new-password" aria-invalid={mismatch || undefined} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} /><FieldError error={mismatch ? 'Passwörter stimmen nicht überein.' : null} /></label>
            {error && <div className="error" role="alert">{error}</div>}
            <Button type="submit" variant="primary" loading={busy} disabled={pw.next.length < MIN_PW || pw.next !== pw.repeat}>Passwort setzen und anmelden</Button>
          </div>
        )}
      </form>
    </div>
  );
}

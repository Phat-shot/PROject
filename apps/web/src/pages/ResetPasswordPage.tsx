import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/** Öffentliche Seite /passwort/:token: neues Passwort setzen, danach angemeldet. */
export function ResetPasswordPage({ token }: { token: string }) {
  const [info, setInfo] = useState<{ email: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pw, setPw] = useState({ next: '', repeat: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<{ email: string; name: string }>(`/auth/reset/${token}`).then(setInfo).catch((e) => setError(e.message)); }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post(`/auth/reset/${token}`, { password: pw.next }); window.location.href = '/'; }
    catch (err: any) { setError(err.message); setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Neues Passwort</h1>
        {error && !info && <><div className="error mb">{error}</div><a href="/">Zur Anmeldung</a></>}
        {info && (
          <div className="form">
            <p className="muted">Für {info.name} ({info.email}).</p>
            <label className="field"><span>Neues Passwort (mindestens 10 Zeichen)</span><input type="password" value={pw.next} autoFocus onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
            <label className="field"><span>Wiederholen</span><input type="password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} /></label>
            {pw.repeat && pw.next !== pw.repeat && <div className="small" style={{ color: 'var(--danger)' }}>Passwörter stimmen nicht überein.</div>}
            {error && <div className="error">{error}</div>}
            <button className="btn primary" disabled={busy || pw.next.length < 10 || pw.next !== pw.repeat}>Passwort setzen und anmelden</button>
          </div>
        )}
      </form>
    </div>
  );
}

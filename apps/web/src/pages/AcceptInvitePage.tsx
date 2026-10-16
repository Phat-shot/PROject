import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../components/ui';

/** Öffentliche Seite: Einladung annehmen, Passwort setzen, danach direkt angemeldet. */
export function AcceptInvitePage({ token }: { token: string }) {
  const [inv, setInv] = useState<{ email: string; name: string; orgName: string } | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { busy, error, run } = useAsync();
  useEffect(() => {
    api.get<{ email: string; name: string; orgName: string }>(`/invitations/accept/${token}`).then((r) => { setInv(r); setName(r.name); }).catch((e) => setNotFound(e.message));
  }, [token]);
  if (notFound) return <div className="login"><div className="card"><h1>PROject</h1><div className="error">{notFound}</div><p className="muted small">Bitte beim Org-Admin eine neue Einladung anfordern.</p><a className="btn" href="/">Zur Anmeldung</a></div></div>;
  if (!inv) return <div className="login"><div className="card muted">Lade …</div></div>;
  const ok = pw.length >= 10 && pw === pw2 && name.trim();
  return (
    <div className="login">
      <div className="card" style={{ width: 420 }}>
        <h1>PROject</h1>
        <p className="muted">{inv.orgName} · Einladung für <strong>{inv.email}</strong></p>
        <div className="form">
          <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Passwort (mindestens 10 Zeichen)</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
          <label className="field"><span>Passwort wiederholen</span><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
          {pw2 && pw !== pw2 && <div className="small" style={{ color: 'var(--danger)' }}>Passwörter stimmen nicht überein.</div>}
          {error && <div className="error">{error}</div>}
          <div><button className="btn primary" disabled={busy || !ok} onClick={() => void run(async () => { await api.post(`/invitations/accept/${token}`, { name, password: pw }); window.location.href = '/'; })}>Konto anlegen und anmelden</button></div>
        </div>
      </div>
    </div>
  );
}

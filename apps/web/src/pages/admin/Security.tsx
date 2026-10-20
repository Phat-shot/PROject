import { useData } from '../../lib/useData';
import { SettingsCard } from '../../components/settings/Settings';

/** Anmeldung: Single Sign-on (OIDC) und OAuth2 für Mail-Konten kommen aus der Umgebung des Servers; hier nur der Stand mit den Rücksprungadressen. */
export function SsoCard() {
  const d = useData<{ oidc: { label: string; redirectUri: string } | null; mailRedirects: { key: string; redirectUri: string }[] }>('/auth/oidc/info');
  return (
    <SettingsCard title="Anmeldung und Single Sign-on" hint="Konfiguriert über Umgebungsvariablen des Servers (OIDC_*, OAUTH_MS_*, OAUTH_GOOGLE_*). Benutzer mit SSO-Gruppen pflegt die Verwaltung unter Personen › Gruppen.">
      {!d.data ? <p className="muted small">Lade …</p> : <dl className="kv">
        <dt>Single Sign-on</dt><dd>{d.data.oidc ? <>aktiv: {d.data.oidc.label}<div className="muted small">Rücksprung: <code>{d.data.oidc.redirectUri}</code></div></> : <span className="muted">nicht eingerichtet (Anmeldung mit Passwort, optional zweiter Faktor)</span>}</dd>
        <dt>Mail per OAuth2</dt><dd>{d.data.mailRedirects.length === 0 ? <span className="muted">kein Anbieter eingerichtet</span> : d.data.mailRedirects.map((m) => <div key={m.key} className="small">{m.key === 'microsoft' ? 'Microsoft 365' : 'Google'}: <code>{m.redirectUri}</code></div>)}</dd>
      </dl>}
    </SettingsCard>
  );
}

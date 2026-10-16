import { useState } from 'react';
import type { MailAccount, Project } from '@projekttool/shared';
import { api, fmtDateTime } from '../lib/api';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { Modal, useAsync } from '../components/ui';

export function MailAccountsPage() {
  const accounts = useData<{ accounts: MailAccount[] }>('/mail/accounts');
  const projects = useData<{ projects: Project[] }>('/projects');
  const [create, setCreate] = useState(false);
  const { error, run, busy } = useAsync();
  return (
    <>
      <TopBar title="Mail-Konten"><button className="btn primary" onClick={() => setCreate(true)}>Konto anbinden</button></TopBar>
      <div className="content">
        <div className="card">
          <p className="muted small">Persönliche Konten gehören dir und werden nie als Ganzes geteilt, nur gefilterte Ansichten mit eigenen Rechten. Projektkonten bindet der PL an. Gespeichert werden nur Treffer einer Ansicht.</p>
          {error && <div className="error mb">{error}</div>}
          <table className="table"><thead><tr><th>Konto</th><th>Typ</th><th>Anbindung</th><th>Letzter Sync</th><th /></tr></thead><tbody>
            {accounts.data?.accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.name}<div className="muted small">{a.address}</div></td>
                <td>{a.type === 'personal' ? 'persönlich' : <>Projektkonto <span className="badge">{projects.data?.projects.find((p) => p.id === a.projectId)?.key}</span></>}</td>
                <td className="small">{a.provider === 'dev' ? 'Dev-Postfach (im Speicher)' : `IMAP ${a.imapHost} / SMTP ${a.smtpHost}`}</td>
                <td className="small">{a.syncError ? <span className="badge warn" title={a.syncError}>Sync unterbrochen</span> : fmtDateTime(a.lastSyncAt) || '–'}</td>
                <td className="nowrap"><button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.post(`/mail/accounts/${a.id}/sync`); await accounts.reload(); })}>Jetzt synchronisieren</button> <button className="btn sm danger" onClick={() => { if (confirm('Konto trennen? Alle Ansichten daraus verschwinden aus den Projekten.')) void run(async () => { await api.del(`/mail/accounts/${a.id}`); await accounts.reload(); }); }}>Trennen</button></td>
              </tr>
            ))}
          </tbody></table>
          {accounts.data?.accounts.length === 0 && <div className="empty">Noch kein Konto.</div>}
        </div>
      </div>
      {create && <AccountForm projects={(projects.data?.projects ?? []).filter((p) => p.myRole === 'pl')} onClose={() => setCreate(false)} onCreated={async () => { setCreate(false); await accounts.reload(); }} />}
    </>
  );
}

function AccountForm({ projects, onClose, onCreated }: { projects: Project[]; onClose: () => void; onCreated: () => Promise<void> }) {
  const [f, setF] = useState({ type: 'personal', projectId: projects[0]?.id ?? '', name: '', address: '', provider: 'imap', imapHost: '', imapPort: 993, imapUser: '', imapPassword: '', smtpHost: '', smtpPort: 587, smtpUser: '', smtpPassword: '' });
  const { busy, error, run } = useAsync();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title="Mail-Konto anbinden" onClose={onClose}>
      <div className="form cols-2">
        <label className="field"><span>Typ</span><select value={f.type} onChange={(e) => set('type', e.target.value)}><option value="personal">Persönlich (nur ich teile Ansichten)</option><option value="project" disabled={!projects.length}>Projektkonto (als PL)</option></select></label>
        {f.type === 'project' && <label className="field"><span>Projekt</span><select value={f.projectId} onChange={(e) => set('projectId', e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.key} – {p.name}</option>)}</select></label>}
        <label className="field"><span>Anzeigename</span><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field"><span>Adresse</span><input type="email" value={f.address} onChange={(e) => set('address', e.target.value)} /></label>
        <label className="field full"><span>Anbindung</span><select value={f.provider} onChange={(e) => set('provider', e.target.value)}><option value="imap">IMAP/SMTP (Passwort; OAuth2 für M365/Google folgt)</option><option value="dev">Dev-Postfach (zum Testen, im Speicher)</option></select></label>
        {f.provider === 'imap' && <>
          <label className="field"><span>IMAP-Host</span><input type="text" value={f.imapHost} onChange={(e) => set('imapHost', e.target.value)} placeholder="imap.firma.de" /></label>
          <label className="field"><span>IMAP-Port</span><input type="number" value={f.imapPort} onChange={(e) => set('imapPort', Number(e.target.value))} /></label>
          <label className="field"><span>IMAP-Benutzer</span><input type="text" value={f.imapUser} onChange={(e) => set('imapUser', e.target.value)} /></label>
          <label className="field"><span>IMAP-Passwort</span><input type="password" value={f.imapPassword} onChange={(e) => set('imapPassword', e.target.value)} /></label>
          <label className="field"><span>SMTP-Host</span><input type="text" value={f.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} /></label>
          <label className="field"><span>SMTP-Port</span><input type="number" value={f.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} /></label>
          <label className="field"><span>SMTP-Benutzer</span><input type="text" value={f.smtpUser} onChange={(e) => set('smtpUser', e.target.value)} /></label>
          <label className="field"><span>SMTP-Passwort</span><input type="password" value={f.smtpPassword} onChange={(e) => set('smtpPassword', e.target.value)} /></label>
        </>}
        {error && <div className="error full">{error}</div>}
        <div className="full"><button className="btn primary" disabled={busy || !f.name || !f.address} onClick={() => void run(async () => { await api.post('/mail/accounts', f); await onCreated(); })}>Anbinden</button></div>
      </div>
    </Modal>
  );
}

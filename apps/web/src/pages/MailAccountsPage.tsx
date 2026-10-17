import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MailAccount, Project } from '@projekttool/shared';
import { api, fmtDateTime } from '../lib/api';
import { useData } from '../lib/useData';
import { useAuth } from '../lib/auth';
import { TopBar } from '../components/Layout';
import { Modal, useAsync, useDialog } from '../components/ui';

interface TestResult { imap: { ok: boolean; error?: string; folders?: string[] }; smtp: { ok: boolean; error?: string } }

export function MailAccountsPage() {
  const accounts = useData<{ accounts: MailAccount[] }>('/mail/accounts');
  const projects = useData<{ projects: Project[] }>('/projects');
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<MailAccount | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const { error, run, busy } = useAsync();
  const dialog = useDialog();
  const sync = (a: MailAccount) => run(async () => {
    const r = await api.post<{ result: { fetched: number; stored: number; error?: string }; viewCount: number; hint: string | null }>(`/mail/accounts/${a.id}/sync`);
    if (r.result.error) setMsg({ kind: 'err', text: `Sync fehlgeschlagen: ${r.result.error}` });
    else if (r.hint) setMsg({ kind: 'warn', text: r.hint });
    else setMsg({ kind: 'ok', text: `Sync fertig: ${r.result.fetched} neue Mails geprüft, ${r.result.stored} als Treffer gespeichert.` });
    await accounts.reload();
  });
  const test = (a: MailAccount) => run(async () => {
    const r = await api.post<TestResult>('/mail/accounts/test', { accountId: a.id });
    setMsg({ kind: r.imap.ok && r.smtp.ok ? 'ok' : 'err', text: `IMAP: ${r.imap.ok ? `ok (${r.imap.folders?.length ?? 0} Ordner)` : r.imap.error} · SMTP: ${r.smtp.ok ? 'ok' : r.smtp.error}` });
  });
  return (
    <>
      <TopBar title="Mail-Konten"><button className="btn primary" onClick={() => setCreate(true)}>Konto anbinden</button></TopBar>
      <div className="content">
        <div className="card">
          <p className="muted small">Persönliche Konten gehören dir und werden nie als Ganzes geteilt, nur gefilterte Ansichten mit eigenen Rechten. Projektkonten bindet der PL an; ihre Adresse wird zur Projekt-Mailadresse. Gespeichert werden nur Treffer einer Ansicht.</p>
          {error && <div className="error mb">{error}</div>}
          {msg && <div className={`${msg.kind === 'ok' ? 'success' : msg.kind === 'warn' ? 'notice' : 'error'} mb`}>{msg.text}</div>}
          <table className="table"><thead><tr><th>Konto</th><th>Typ</th><th>Anbindung</th><th>Ansichten</th><th>Letzter Sync</th><th /></tr></thead><tbody>
            {accounts.data?.accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.name}<div className="muted small">{a.address}</div></td>
                <td>{a.type === 'personal' ? 'persönlich' : a.type === 'org' ? 'Org-Postfach' : <>Projektkonto <span className="badge">{projects.data?.projects.find((p) => p.id === a.projectId)?.key}</span></>}</td>
                <td className="small">{a.provider === 'dev' ? 'Dev-Postfach (im Speicher)' : <>IMAP {a.imapHost}:{a.imapPort ?? 993}{a.imapSecure === false ? '' : ' SSL'}<br />SMTP {a.smtpHost}:{a.smtpPort ?? 587}{a.smtpSecure ? ' SSL' : ' STARTTLS'}</>}</td>
                <td className="small">{a.viewCount ?? 0}{(a.viewCount ?? 0) === 0 && <div className="muted">noch keine</div>}</td>
                <td className="small">{a.syncError ? <span className="badge warn" title={a.syncError}>Sync unterbrochen</span> : fmtDateTime(a.lastSyncAt) || '–'}{a.syncError && <div className="muted" style={{ maxWidth: 260 }}>{a.syncError}</div>}</td>
                <td className="nowrap">
                  {a.provider === 'imap' && <button className="btn sm" disabled={busy} onClick={() => void test(a)}>Verbindung testen</button>}{' '}
                  <button className="btn sm" disabled={busy} onClick={() => void sync(a)}>Jetzt synchronisieren</button>{' '}
                  <button className="btn sm" onClick={() => setEdit(a)}>Bearbeiten</button>{' '}
                  <button className="btn sm danger" onClick={() => void dialog.confirm({ title: 'Konto trennen', text: `„${a.name}“ trennen? Alle Ansichten aus diesem Konto verschwinden aus den Projekten, Kopien in Arbeitspaketen bleiben.`, confirmLabel: 'Trennen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/mail/accounts/${a.id}`); await accounts.reload(); }); })}>Trennen</button>
                </td>
              </tr>
            ))}
          </tbody></table>
          {accounts.data?.accounts.length === 0 && <div className="empty">Noch kein Konto.</div>}
        </div>
      </div>
      {create && <AccountForm projects={(projects.data?.projects ?? []).filter((p) => p.myRole === 'pl')} onClose={() => setCreate(false)} onSaved={async () => { setCreate(false); await accounts.reload(); }} />}
      {edit && <AccountForm existing={edit} projects={(projects.data?.projects ?? []).filter((p) => p.myRole === 'pl')} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await accounts.reload(); }} />}
    </>
  );
}

function AccountForm({ existing, projects, onClose, onSaved }: { existing?: MailAccount; projects: Project[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { user } = useAuth();
  const isAdmin = user?.globalRole === 'org_admin';
  const [f, setF] = useState({
    type: existing?.type ?? 'personal' as MailAccount['type'], projectId: existing?.projectId ?? projects[0]?.id ?? '', name: existing?.name ?? '', address: existing?.address ?? '', provider: existing?.provider ?? 'imap',
    imapHost: existing?.imapHost ?? '', imapPort: existing?.imapPort ?? 993, imapUser: existing?.imapUser ?? '', imapPassword: '', imapSecure: existing?.imapSecure ?? true,
    smtpHost: existing?.smtpHost ?? '', smtpPort: existing?.smtpPort ?? 587, smtpUser: existing?.smtpUser ?? '', smtpPassword: '', smtpSecure: existing?.smtpSecure ?? false
  });
  const [test, setTest] = useState<TestResult | null>(null);
  const { busy, error, run } = useAsync();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const payload = () => ({ ...f, imapUser: f.imapUser || f.address, smtpUser: f.smtpUser || f.imapUser || f.address, imapPassword: f.imapPassword || undefined, smtpPassword: f.smtpPassword || f.imapPassword || undefined });
  return (
    <Modal title={existing ? `Konto bearbeiten: ${existing.name}` : 'Mail-Konto anbinden'} onClose={onClose}>
      <div className="form cols-2">
        {!existing && <label className="field"><span>Typ</span><select value={f.type} onChange={(e) => set('type', e.target.value)}><option value="personal">Persönlich (nur ich teile Ansichten)</option><option value="project" disabled={!projects.length}>Projektkonto (als PL)</option>{isAdmin && <option value="org">Org-Postfach (Systemmails: Einladungen)</option>}</select></label>}
        {!existing && f.type === 'project' && <label className="field"><span>Projekt</span><select value={f.projectId} onChange={(e) => set('projectId', e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.key} – {p.name}</option>)}</select></label>}
        <label className="field"><span>Anzeigename</span><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field"><span>Adresse</span><input type="email" value={f.address} onChange={(e) => set('address', e.target.value)} /></label>
        {!existing && <label className="field full"><span>Anbindung</span><select value={f.provider} onChange={(e) => set('provider', e.target.value)}><option value="imap">IMAP/SMTP (Passwort oder App-Passwort; OAuth2 für M365/Google folgt)</option><option value="dev">Dev-Postfach (zum Testen, im Speicher)</option></select></label>}
        {f.provider === 'imap' && <>
          <label className="field"><span>IMAP-Host</span><input type="text" value={f.imapHost} onChange={(e) => set('imapHost', e.target.value)} placeholder="imap.one.com" /></label>
          <div className="row"><label className="field" style={{ flex: 1 }}><span>IMAP-Port</span><input type="number" value={f.imapPort} onChange={(e) => set('imapPort', Number(e.target.value))} /></label><label className="check" style={{ marginTop: 18 }}><input type="checkbox" checked={Boolean(f.imapSecure)} onChange={(e) => set('imapSecure', e.target.checked)} /> SSL/TLS (993)</label></div>
          <label className="field"><span>IMAP-Benutzer (leer = Adresse)</span><input type="text" value={f.imapUser} onChange={(e) => set('imapUser', e.target.value)} /></label>
          <label className="field"><span>IMAP-Passwort{existing?.hasImapPassword && <span className="muted"> (leer = unverändert)</span>}</span><input type="password" value={f.imapPassword} onChange={(e) => set('imapPassword', e.target.value)} autoComplete="new-password" /></label>
          <label className="field"><span>SMTP-Host</span><input type="text" value={f.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} placeholder="send.one.com" /></label>
          <div className="row"><label className="field" style={{ flex: 1 }}><span>SMTP-Port</span><input type="number" value={f.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} /></label><label className="check" style={{ marginTop: 18 }}><input type="checkbox" checked={Boolean(f.smtpSecure)} onChange={(e) => set('smtpSecure', e.target.checked)} /> SSL (465), sonst STARTTLS (587)</label></div>
          <label className="field"><span>SMTP-Benutzer (leer = wie IMAP)</span><input type="text" value={f.smtpUser} onChange={(e) => set('smtpUser', e.target.value)} /></label>
          <label className="field"><span>SMTP-Passwort (leer = wie IMAP{existing?.hasSmtpPassword ? ' bzw. unverändert' : ''})</span><input type="password" value={f.smtpPassword} onChange={(e) => set('smtpPassword', e.target.value)} autoComplete="new-password" /></label>
        </>}
        {test && <div className={`full ${test.imap.ok && test.smtp.ok ? 'success' : 'error'}`}>
          <div>IMAP: {test.imap.ok ? `ok, ${test.imap.folders?.length ?? 0} Ordner (${test.imap.folders?.slice(0, 6).join(', ')})` : test.imap.error}</div>
          <div>SMTP: {test.smtp.ok ? 'ok' : test.smtp.error}</div>
        </div>}
        {error && <div className="error full">{error}</div>}
        <div className="full row">
          {f.provider === 'imap' && <button className="btn" disabled={busy || !f.imapHost || !f.smtpHost} onClick={() => void run(async () => setTest(await api.post<TestResult>('/mail/accounts/test', { ...payload(), accountId: existing?.id })))}>Verbindung testen</button>}
          <button className="btn primary" disabled={busy || !f.name || !f.address} onClick={() => void run(async () => { if (existing) await api.patch(`/mail/accounts/${existing.id}`, payload()); else await api.post('/mail/accounts', payload()); await onSaved(); })}>{existing ? 'Speichern' : 'Anbinden'}</button>
        </div>
        <p className="muted small full">Nach dem Anbinden im Projekt unter Mail eine Ansicht anlegen (Filter nach Absender, Betreff, Ordner). Erst dann werden Mails geladen; gespeichert werden nur Treffer. Bei one.com: IMAP imap.one.com:993 SSL, SMTP send.one.com:587 STARTTLS, Benutzer = volle Adresse.</p>
      </div>
    </Modal>
  );
}

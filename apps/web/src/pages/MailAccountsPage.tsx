import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { MailAccount, MailAccountUse, Project } from '@projekttool/shared';
import { api, fmtDateTime } from '../lib/api';
import { useData } from '../lib/useData';
import { useAuth } from '../lib/auth';
import { TopBar } from '../components/Layout';
import { Modal, useAsync, useDialog } from '../components/ui';

interface TestResult { imap: { ok: boolean; error?: string; folders?: string[] }; smtp: { ok: boolean; error?: string } }
interface OAuthProvider { key: 'microsoft' | 'google'; label: string; mailProvider: 'graph' | 'imap' }
const OAUTH_LABEL = { microsoft: 'Microsoft 365', google: 'Google' } as const;

/** Verwalter in einem Wort (Person: „ich“ oder „Person“, Projekt mit Kürzel, sonst Organisation). */
export function managerLabel(a: MailAccount, me: string | undefined, projects: Project[]): string {
  const m = a.managedBy;
  if (!m || m.kind === 'org') return 'Organisation (Org-Admin)';
  if (m.kind === 'user') return m.userId === me ? 'ich' : 'eine Person';
  const p = projects.find((x) => x.id === m.projectId);
  return p ? `Projekt ${p.key}` : 'ein Projekt';
}
export const useLabel = (u: { use: MailAccountUse; projectLabel?: string | null; isDefault?: boolean }) =>
  u.use === 'org' ? 'Org-Postfach' : u.use === 'personal' ? 'persönlich' : `Projekt ${u.projectLabel ?? ''}${u.isDefault ? ' (Standard)' : ''}`;
export const managedByParam = (a: MailAccount) => (a.managedBy?.kind === 'user' ? 'me' : a.managedBy?.kind === 'project' ? `project&projectId=${a.managedBy.projectId}` : 'org');

export function MailAccountsPage() {
  const { user } = useAuth();
  const accounts = useData<{ accounts: MailAccount[] }>('/mail/accounts');
  const projects = useData<{ projects: Project[] }>('/projects');
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<MailAccount | null>(null);
  const [useFor, setUseFor] = useState<MailAccount | null>(null);
  const [managerFor, setManagerFor] = useState<MailAccount | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const { error, run, busy } = useAsync();
  const dialog = useDialog();
  const oauth = useData<{ providers: OAuthProvider[] }>('/oauth/providers');
  const [oauthStart, setOauthStart] = useState<OAuthProvider | null>(null);
  const [params, setParams] = useSearchParams();
  // Rückkehr von Microsoft/Google: Ergebnis einmal anzeigen, Parameter entfernen
  useEffect(() => {
    const ok = params.get('connected'); const err = params.get('oauthError');
    if (ok) setMsg({ kind: 'ok', text: `${ok} verbunden. Jetzt im Projekt unter Mail eine Ansicht anlegen.` });
    if (err) setMsg({ kind: 'err', text: `Verbindung fehlgeschlagen: ${err}` });
    if (ok || err) { params.delete('connected'); params.delete('oauthError'); setParams(params, { replace: true }); }
  }, []);
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
      <TopBar title="Mail-Konten">
        {oauth.data?.providers.map((p) => <button key={p.key} className="btn" onClick={() => setOauthStart(p)}>Mit {p.label} verbinden</button>)}
        <button className="btn primary" onClick={() => setCreate(true)}>Konto anbinden</button>
      </TopBar>
      <div className="content">
        <div className="card">
          <p className="muted small">Ein Konto hat einen Verwalter (du, ein Projekt über seine PL oder der Org-Admin) und Verwendungen: persönlich („Meine Konten“, Ansichten teilst nur du), Projektkonto (Antwortadresse, Absender für Agenten, Einladungen, Berichte; je Projekt eines als Standard) oder Org-Postfach (Systemmails, nur der Org-Admin). Ein Konto kann mehrere Verwendungen haben; Konten werden nie als Ganzes geteilt, nur gefilterte Ansichten mit eigenen Rechten. Gespeichert werden nur Treffer einer Ansicht.</p>
          {error && <div className="error mb">{error}</div>}
          {msg && <div className={`${msg.kind === 'ok' ? 'success' : msg.kind === 'warn' ? 'notice' : 'error'} mb`}>{msg.text}</div>}
          <table className="table"><thead><tr><th>Konto</th><th>Verwalter</th><th>Verwendungen</th><th>Anbindung</th><th>Ansichten</th><th>Letzter Sync</th><th /></tr></thead><tbody>
            {accounts.data?.accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.name}<div className="muted small">{a.address}</div></td>
                <td className="small">{managerLabel(a, user?.id, projects.data?.projects ?? [])}{user?.globalRole === 'org_admin' && <div><button className="btn sm link" onClick={() => setManagerFor(a)}>ändern</button></div>}</td>
                <td className="small">{(a.uses ?? []).map((u) => <span key={u.id} className="badge" style={{ marginRight: 4, marginBottom: 2 }} title={u.use === 'project' ? 'Projektkonto: Antwortadresse, Absender für Agenten und Berichte' : u.use === 'org' ? 'Systemmails: Einladungen, Digest, Passwort' : 'Meine Konten: Ansichten teilst nur du'}>{useLabel(u)} <button className="btn sm link" title="Verwendung lösen (Ansichten darüber verschwinden)" disabled={busy} onClick={() => void dialog.confirm({ title: 'Verwendung lösen', text: `„${useLabel(u)}“ für ${a.address} lösen? Ansichten über diese Verwendung verschwinden, Kopien in Arbeitspaketen bleiben.`, confirmLabel: 'Lösen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/mail/accounts/${a.id}/uses/${u.id}`); await accounts.reload(); }); })}>✕</button></span>)}<div><button className="btn sm link" onClick={() => setUseFor(a)}>+ Verwendung</button></div></td>
                <td className="small">{a.provider === 'dev' ? 'Dev-Postfach (im Speicher)' : a.provider === 'graph' ? <>Microsoft 365 (Graph, OAuth2)</> : a.oauthProvider ? <>{OAUTH_LABEL[a.oauthProvider]} (IMAP/SMTP, OAuth2)<br />{a.imapHost}</> : <>IMAP {a.imapHost}:{a.imapPort ?? 993}{a.imapSecure === false ? '' : ' SSL'}<br />SMTP {a.smtpHost}:{a.smtpPort ?? 587}{a.smtpSecure ? ' SSL' : ' STARTTLS'}</>}</td>
                <td className="small">{a.viewCount ?? 0}{(a.viewCount ?? 0) === 0 && <div className="muted">noch keine</div>}</td>
                <td className="small">{a.syncError ? <span className="badge warn" title={a.syncError}>Sync unterbrochen</span> : fmtDateTime(a.lastSyncAt) || '–'}{a.syncError && <div className="muted" style={{ maxWidth: 260 }}>{a.syncError}</div>}</td>
                <td className="nowrap">
                  {a.provider !== 'dev' && <button className="btn sm" disabled={busy} onClick={() => void test(a)}>Verbindung testen</button>}{' '}
                  {a.oauthProvider && <a className="btn sm" href={`/api/oauth/start?provider=${a.oauthProvider}&managedBy=${managedByParam(a)}`} title="Zustimmung erneuern, wenn der Sync mit Token-Fehler steht">Neu verbinden</a>}{' '}
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
      {oauthStart && <OAuthStartDialog provider={oauthStart} projects={(projects.data?.projects ?? []).filter((p) => p.myRole === 'pl')} onClose={() => setOauthStart(null)} />}
      {create && <AccountForm projects={(projects.data?.projects ?? []).filter((p) => p.myRole === 'pl')} onClose={() => setCreate(false)} onSaved={async () => { setCreate(false); await accounts.reload(); }} />}
      {edit && <AccountForm existing={edit} projects={(projects.data?.projects ?? []).filter((p) => p.myRole === 'pl')} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await accounts.reload(); }} />}
      {useFor && <UseDialog account={useFor} projects={projects.data?.projects ?? []} onClose={() => setUseFor(null)} onSaved={async () => { setUseFor(null); await accounts.reload(); }} />}
      {managerFor && <ManagerDialog account={managerFor} projects={projects.data?.projects ?? []} onClose={() => setManagerFor(null)} onSaved={async () => { setManagerFor(null); await accounts.reload(); }} />}
    </>
  );
}

/** Verwendung hinzufügen: persönlich (für mich), Projektkonto (als PL; der Org-Admin bietet seine Konten jedem Projekt an) oder Org-Postfach (Org-Admin). */
export function UseDialog({ account, projects, onClose, onSaved }: { account: MailAccount; projects: Project[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { user } = useAuth();
  const isAdmin = user?.globalRole === 'org_admin';
  // Org-Admin: alle Projekte des Mandanten (persönliche nur als „persönlich (Name)“); sonst die Projekte, deren PL man ist
  const all = useData<{ projects: { id: string; label: string }[] }>(isAdmin && account.managedBy?.kind === 'org' ? '/ai/release-projects' : null);
  const options = isAdmin && account.managedBy?.kind === 'org' ? (all.data?.projects ?? []) : projects.filter((p) => p.myRole === 'pl').map((p) => ({ id: p.id, label: `${p.key} ${p.name}` }));
  const bound = new Set((account.uses ?? []).filter((u) => u.use === 'project').map((u) => u.projectId));
  const free = options.filter((p) => !bound.has(p.id));
  const hasPersonal = (account.uses ?? []).some((u) => u.use === 'personal' && u.userId === user?.id);
  const [use, setUse] = useState<MailAccountUse>(hasPersonal ? 'project' : 'personal');
  const [projectId, setProjectId] = useState(free[0]?.id ?? '');
  const { busy, error, run } = useAsync();
  return (
    <Modal title={`Verwendung hinzufügen: ${account.address}`} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Verwendung</span><select value={use} onChange={(e) => setUse(e.target.value as MailAccountUse)}>
          <option value="personal" disabled={hasPersonal}>Persönlich (unter „Meine Konten“, Ansichten teile nur ich)</option>
          <option value="project">Projektkonto (Antwortadresse, Absender für Agenten und Berichte)</option>
          {isAdmin && <option value="org">Org-Postfach (Systemmails: Einladungen, Digest, Passwort)</option>}
        </select></label>
        {use === 'project' && <label className="field"><span>Projekt</span><select value={projectId || (free[0]?.id ?? '')} onChange={(e) => setProjectId(e.target.value)}>{free.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}
        {use === 'project' && free.length === 0 && <p className="notice small">Kein Projekt verfügbar: Projektkonten bindet die PL an ihr Projekt; Konten der Organisation bietet der Org-Admin an.</p>}
        {use === 'project' && account.managedBy?.kind === 'org' && <p className="muted small">Angebotene Konten der Organisation werden im Projekt nie automatisch Standard; die PL wählt den Standard in den Projekteinstellungen.</p>}
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || (use === 'project' && !(projectId || free[0]?.id))} onClick={() => void run(async () => { await api.post(`/mail/accounts/${account.id}/uses`, { use, projectId: use === 'project' ? projectId || free[0]?.id : undefined }); await onSaved(); })}>Hinzufügen</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/** Verwalter wechseln (Org-Admin): zu mir, zur Organisation oder zu einem Projekt. */
export function ManagerDialog({ account, projects, onClose, onSaved }: { account: MailAccount; projects: Project[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const all = useData<{ projects: { id: string; label: string }[] }>('/ai/release-projects');
  const options = (all.data?.projects ?? projects.map((p) => ({ id: p.id, label: `${p.key} ${p.name}` })));
  const [kind, setKind] = useState<'me' | 'org' | 'project'>(account.managedBy?.kind === 'project' ? 'project' : account.managedBy?.kind === 'user' ? 'me' : 'org');
  const [projectId, setProjectId] = useState(account.managedBy?.kind === 'project' ? account.managedBy.projectId : options[0]?.id ?? '');
  const { busy, error, run } = useAsync();
  return (
    <Modal title={`Verwalter: ${account.address}`} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Verwalter</span><select value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="org">Organisation (Org-Admin)</option><option value="project">Projekt (seine PL)</option><option value="me">ich</option></select></label>
        {kind === 'project' && <label className="field"><span>Projekt</span><select value={projectId || (options[0]?.id ?? '')} onChange={(e) => setProjectId(e.target.value)}>{options.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}
        <p className="muted small">Der Verwalter pflegt Zugangsdaten und Ordner und löscht das Konto. Verwendungen bleiben beim Wechsel bestehen.</p>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.put(`/mail/accounts/${account.id}/manager`, { managedBy: kind, projectId: kind === 'project' ? projectId || options[0]?.id : undefined }); await onSaved(); })}>Speichern</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/** OAuth2-Start: Typ und Projekt wählen, dann Weiterleitung zu Microsoft/Google; das Konto entsteht beim Rückruf. */
export function OAuthStartDialog({ provider, projects, onClose, fixedProject }: { provider: OAuthProvider; projects: Project[]; onClose: () => void; fixedProject?: Project }) {
  const { user } = useAuth();
  const [type, setType] = useState<'me' | 'project' | 'org'>(fixedProject ? 'project' : 'me');
  const [projectId, setProjectId] = useState(fixedProject?.id ?? projects[0]?.id ?? '');
  const [name, setName] = useState('');
  const href = `/api/oauth/start?provider=${provider.key}&managedBy=${type}${type === 'project' ? `&projectId=${projectId}` : ''}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
  return (
    <Modal title={`Mit ${provider.label} verbinden`} onClose={onClose}>
      <div className="form">
        {fixedProject ? <div className="field"><span>Projektkonto für</span><span><span className="badge">{fixedProject.key}</span> {fixedProject.name}</span></div> : (
          <label className="field"><span>Verwalter und erste Verwendung</span><select value={type} onChange={(e) => setType(e.target.value as any)}><option value="me">Ich: eigenes Konto (persönlich)</option><option value="project" disabled={!projects.length}>Projekt: Projektkonto (als PL)</option>{user?.globalRole === 'org_admin' && <option value="org">Organisation: Org-Postfach (Systemmails)</option>}</select></label>
        )}
        {!fixedProject && type === 'project' && <label className="field"><span>Projekt</span><select value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.key} – {p.name}</option>)}</select></label>}
        <label className="field"><span>Anzeigename (leer = Name aus dem Konto)</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <p className="muted small">Du wirst zu {provider.label} weitergeleitet und meldest dich dort an. Die Adresse des angemeldeten Kontos wird übernommen{provider.mailProvider === 'graph' ? ', der Zugriff läuft über Microsoft Graph' : ', der Zugriff läuft über IMAP/SMTP mit OAuth2'}. Es wird kein Passwort gespeichert.</p>
        <div className="row"><a className="btn primary" href={href}>Weiter zu {provider.label}</a><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/** Konto anbinden/bearbeiten; mit fixedProject nur als Projektkonto dieses Projekts (aus den Projekteinstellungen). */
export function AccountForm({ existing, projects, onClose, onSaved, fixedProject }: { existing?: MailAccount; projects: Project[]; onClose: () => void; onSaved: () => Promise<void>; fixedProject?: Project }) {
  const { user } = useAuth();
  const isAdmin = user?.globalRole === 'org_admin';
  const [f, setF] = useState({
    managedBy: (fixedProject ? 'project' : 'me') as 'me' | 'project' | 'org', projectId: fixedProject?.id ?? projects[0]?.id ?? '', name: existing?.name ?? '', address: existing?.address ?? '', provider: existing?.provider ?? 'imap',
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
        {!existing && fixedProject && <div className="field full"><span>Projektkonto für</span><span><span className="badge">{fixedProject.key}</span> {fixedProject.name} · das erste Projektkonto wird Standard, seine Adresse Projekt-Mailadresse</span></div>}
        {!existing && !fixedProject && <label className="field"><span>Verwalter und erste Verwendung</span><select value={f.managedBy} onChange={(e) => set('managedBy', e.target.value)}><option value="me">Ich: eigenes Konto (persönlich)</option><option value="project" disabled={!projects.length}>Projekt: Projektkonto (als PL)</option>{isAdmin && <option value="org">Organisation: Org-Postfach (Systemmails: Einladungen)</option>}</select></label>}
        {!existing && !fixedProject && f.managedBy === 'project' && <label className="field"><span>Projekt</span><select value={f.projectId} onChange={(e) => set('projectId', e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.key} – {p.name}</option>)}</select></label>}
        <label className="field"><span>Anzeigename</span><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field"><span>Adresse</span><input type="email" value={f.address} onChange={(e) => set('address', e.target.value)} /></label>
        {!existing && <label className="field full"><span>Anbindung</span><select value={f.provider} onChange={(e) => set('provider', e.target.value)}><option value="imap">IMAP/SMTP (Passwort oder App-Passwort)</option><option value="dev">Dev-Postfach (zum Testen, im Speicher)</option></select></label>}
        {existing?.oauthProvider && <p className="muted small full">OAuth2-Konto ({OAUTH_LABEL[existing.oauthProvider]}): Zugangsdaten verwaltet der Anbieter. Zum Erneuern der Zustimmung „Neu verbinden“ in der Liste.</p>}
        {f.provider === 'imap' && !existing?.oauthProvider && <>
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
          {f.provider === 'imap' && !existing?.oauthProvider && <button className="btn" disabled={busy || !f.imapHost || !f.smtpHost} onClick={() => void run(async () => setTest(await api.post<TestResult>('/mail/accounts/test', { ...payload(), accountId: existing?.id })))}>Verbindung testen</button>}
          <button className="btn primary" disabled={busy || !f.name || !f.address} onClick={() => void run(async () => { if (existing) await api.patch(`/mail/accounts/${existing.id}`, payload()); else await api.post('/mail/accounts', payload()); await onSaved(); })}>{existing ? 'Speichern' : 'Anbinden'}</button>
        </div>
        <p className="muted small full">Nach dem Anbinden im Projekt unter Mail eine Ansicht anlegen (Filter nach Absender, Betreff, Ordner). Erst dann werden Mails geladen; gespeichert werden nur Treffer. Bei one.com: IMAP imap.one.com:993 SSL, SMTP send.one.com:587 STARTTLS, Benutzer = volle Adresse.</p>
      </div>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { MailAccount, MailAccountUse, Project } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useAuth } from '../../lib/auth';
import { Modal, useAsync, useDialog } from '../ui';

interface TestResult { imap: { ok: boolean; error?: string; folders?: string[] }; smtp: { ok: boolean; error?: string } }
export interface OAuthProvider { key: 'microsoft' | 'google'; label: string; mailProvider: 'graph' | 'imap' }
export type AccountKind = 'personal' | 'project' | 'central' | 'org';
/** Geltungsbereich der Kontenliste: eigene Konten (Meine Einstellungen › Mail), Konten der Organisation (Verwaltung › Mail) oder alle (Übersicht des Org-Admins). */
export type AccountsScope = 'personal' | 'org' | 'all';
const SCOPE_KINDS: Record<AccountsScope, AccountKind[]> = { personal: ['personal'], org: ['central', 'org'], all: [] };
const SCOPE_TITLE: Record<AccountsScope, string> = { personal: 'Meine Konten', org: 'Postfächer der Organisation', all: 'Alle Konten des Mandanten' };
const SCOPE_HINT: Record<AccountsScope, string> = {
  personal: 'Eigene Konten (IMAP oder Microsoft 365/Google). Ansichten darauf teilst nur du; als PL holst du ein Konto in dein Projekt. Konten werden nie als Ganzes geteilt, nur gefilterte Ansichten.',
  org: 'Das Org-Postfach (genau eines; Systemmails wie Einladungen, Digest, Passwort; keine Projekte) und zentrale Postfächer für mehrere Projekte: der Org-Admin pflegt sie und bietet sie Projekten an oder gibt sie für alle Projekte frei, dann holt die PL sie selbst ins Projekt.',
  all: 'Übersicht aller Konten: Projektpostfächer pflegt die PL in den Projekteinstellungen, persönliche Konten die Person. Art und Verwalter ändert nur der Org-Admin.'
};
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
  u.use === 'org' ? 'Org-Postfach' : u.use === 'personal' ? 'Meine Konten' : `${u.projectLabel?.startsWith('persönlich') ? `persönliches Projekt ${u.projectLabel.slice('persönlich '.length)}` : u.projectLabel ?? ''}${u.isDefault ? ' (Standard)' : ''}`;
/** Art des Postfachs: Org-Postfach (Systemmails), zentral (Organisation, mehrere Projekte), Projektpostfach (PL), persönlich. */
export function kindLabel(a: MailAccount, me: string | undefined, projects: Project[]): string {
  if (a.kind === 'org') return 'Org-Postfach';
  if (a.kind === 'central') return 'Zentrales Postfach';
  if (a.kind === 'project') { const pid = a.managedBy?.kind === 'project' ? a.managedBy.projectId : ''; const p = projects.find((x) => x.id === pid); return p ? `Projektpostfach ${p.key}` : 'Projektpostfach'; }
  return a.managedBy?.kind === 'user' && a.managedBy.userId === me ? 'Persönlich (ich)' : 'Persönlich';
}
export const KIND_HINT: Record<string, string> = {
  org: 'Systemmails der Organisation: Einladungen, Digest, Passwort. Keine Projekte, keine Ansichten.',
  central: 'Konto der Organisation für mehrere Projekte; der Org-Admin pflegt es und bietet es Projekten an oder gibt es für alle frei.',
  project: 'Gehört genau einem Projekt; die PL pflegt Zugangsdaten, Ordner und Ansichten.',
  personal: 'Eigenes Konto der Person („Meine Konten“); sie kann es als PL in ihr Projekt holen.'
};
export const managedByParam = (a: MailAccount) => (a.managedBy?.kind === 'user' ? 'me' : a.managedBy?.kind === 'project' ? `project&projectId=${a.managedBy.projectId}` : 'org');

/** Kontenliste mit Anlegen, OAuth, Testen, Sync, Bindungen; welche Konten erscheinen und welche Arten sich anlegen lassen, bestimmt der Geltungsbereich. */
export function AccountsCard({ scope }: { scope: AccountsScope }) {
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
    if (ok) setMsg({ kind: 'ok', text: `${ok} verbunden. Ansichten legst du in den Projekteinstellungen unter Mail an.` });
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
  const me = user?.id;
  const inScope = (a: MailAccount) => scope === 'all' ? true : scope === 'org' ? a.kind === 'org' || a.kind === 'central' : (a.managedBy?.kind === 'user' && a.managedBy.userId === me) || (a.uses ?? []).some((u) => u.use === 'personal' && u.userId === me);
  const list = (accounts.data?.accounts ?? []).filter(inScope);
  const kinds = SCOPE_KINDS[scope];
  return (
    <>
        <div className="card">
          <div className="row between mb"><h2 style={{ margin: 0 }}>{SCOPE_TITLE[scope]}</h2>{kinds.length > 0 && <span className="row">
            {oauth.data?.providers.map((p) => <button key={p.key} className="btn sm" onClick={() => setOauthStart(p)}>Mit {p.label} verbinden</button>)}
            <button className="btn primary sm" onClick={() => setCreate(true)}>Konto anbinden</button>
          </span>}</div>
          <p className="muted small">{SCOPE_HINT[scope]}</p>
          {error && <div className="error mb">{error}</div>}
          {msg && <div className={`${msg.kind === 'ok' ? 'success' : msg.kind === 'warn' ? 'notice' : 'error'} mb`}>{msg.text}</div>}
          <table className="table"><thead><tr><th>Konto</th><th>Art</th><th>Projekte</th><th>Anbindung</th><th>Ansichten</th><th>Letzter Sync</th><th /></tr></thead><tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td>{a.name}<div className="muted small">{a.address}</div></td>
                <td className="small"><span title={KIND_HINT[a.kind ?? 'personal']}>{kindLabel(a, user?.id, projects.data?.projects ?? [])}</span>
                  {a.kind === 'central' && user?.globalRole === 'org_admin' && <div><label className="check small" title="Jede PL darf dieses Postfach in ihr Projekt holen (nicht in persönliche Projekte)"><input type="checkbox" checked={Boolean(a.offeredToAll)} disabled={busy} onChange={(e) => void run(async () => { await api.patch(`/mail/accounts/${a.id}`, { offeredToAll: e.target.checked }); await accounts.reload(); })} /> für alle Projekte wählbar</label></div>}
                  {user?.globalRole === 'org_admin' && a.kind !== 'org' && <div><button className="btn sm link" onClick={() => setManagerFor(a)}>Art oder Verwalter ändern</button></div>}</td>
                <td className="small">{a.kind === 'org' ? <span className="muted">keine (nur Systemmails)</span> : <>{(a.uses ?? []).filter((u) => u.use !== 'org').map((u) => <span key={u.id} className="badge" style={{ marginRight: 4, marginBottom: 2 }} title={u.use === 'project' ? 'Im Projekt nutzbar: Antwortadresse, Absender für Agenten und Berichte, Ansichten' : 'Meine Konten: Ansichten teilst nur du'}>{useLabel(u)} <button className="btn sm link" title="Bindung lösen (Ansichten darüber verschwinden)" disabled={busy} onClick={() => void dialog.confirm({ title: 'Bindung lösen', text: `${a.address}: „${useLabel(u)}“ lösen? Ansichten darüber verschwinden, Kopien in Arbeitspaketen bleiben.`, confirmLabel: 'Lösen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/mail/accounts/${a.id}/uses/${u.id}`); await accounts.reload(); }); })}>×</button></span>)}{(a.kind !== 'project' || !(a.uses ?? []).some((u) => u.use === 'project')) && <div><button className="btn sm link" onClick={() => setUseFor(a)}>+ Projekt</button></div>}</>}</td>
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
          {accounts.data && list.length === 0 && <div className="empty">Noch kein Konto.</div>}
        </div>
      {oauthStart && <OAuthStartDialog provider={oauthStart} kinds={kinds} projects={(projects.data?.projects ?? []).filter((p) => p.myRole === 'pl')} onClose={() => setOauthStart(null)} />}
      {create && <AccountForm kinds={kinds} hasOrgMailbox={(accounts.data?.accounts ?? []).some((a) => a.kind === 'org')} projects={(projects.data?.projects ?? []).filter((p) => p.myRole === 'pl')} onClose={() => setCreate(false)} onSaved={async () => { setCreate(false); await accounts.reload(); }} />}
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
  const [use, setUse] = useState<MailAccountUse>('project');
  const [projectId, setProjectId] = useState(free[0]?.id ?? '');
  const { busy, error, run } = useAsync();
  return (
    <Modal title={`Projekt hinzufügen: ${account.address}`} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Verwendung</span><select value={use} onChange={(e) => setUse(e.target.value as MailAccountUse)}>
          <option value="project">Im Projekt nutzen (Antwortadresse, Absender für Agenten und Berichte, Ansichten)</option>
          <option value="personal" disabled={hasPersonal}>Unter „Meine Konten“ (Ansichten teile nur ich)</option>
        </select></label>
        {use === 'project' && <label className="field"><span>Projekt</span><select value={projectId || (free[0]?.id ?? '')} onChange={(e) => setProjectId(e.target.value)}>{free.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}
        {use === 'project' && free.length === 0 && <p className="notice small">Kein Projekt verfügbar: Projektpostfächer gehören genau einem Projekt, persönliche Konten holt die PL in ihre Projekte; zentrale Postfächer bietet der Org-Admin an oder gibt sie für alle Projekte frei.</p>}
        {use === 'project' && account.kind === 'central' && <p className="muted small">Zentrale Postfächer werden im Projekt nie automatisch Standard; die PL wählt den Standard in den Projekteinstellungen.</p>}
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
        <p className="muted small">Organisation = zentrales Postfach (mehrere Projekte), Projekt = Projektpostfach (gehört nur diesem Projekt, Bindungen an andere Projekte lösen sich), Person = persönliches Konto. Der Verwalter pflegt Zugangsdaten und Ordner und löscht das Konto.</p>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.put(`/mail/accounts/${account.id}/manager`, { managedBy: kind, projectId: kind === 'project' ? projectId || options[0]?.id : undefined }); await onSaved(); })}>Speichern</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/** OAuth2-Start: Typ und Projekt wählen, dann Weiterleitung zu Microsoft/Google; das Konto entsteht beim Rückruf. */
export function OAuthStartDialog({ provider, projects, onClose, fixedProject, kinds }: { provider: OAuthProvider; projects: Project[]; onClose: () => void; fixedProject?: Project; /** anlegbare Arten (Standard: alle, die der Rolle offenstehen) */ kinds?: AccountKind[] }) {
  const { user } = useAuth();
  const allowed = (k: AccountKind) => !kinds || kinds.length === 0 || kinds.includes(k);
  const first: 'me' | 'project' | 'central' | 'org' = fixedProject ? 'project' : allowed('personal') ? 'me' : allowed('central') ? 'central' : allowed('org') ? 'org' : 'project';
  const [type, setType] = useState<'me' | 'project' | 'central' | 'org'>(first);
  const [projectId, setProjectId] = useState(fixedProject?.id ?? projects[0]?.id ?? '');
  const [name, setName] = useState('');
  const href = `/api/oauth/start?provider=${provider.key}&managedBy=${type === 'central' ? 'org' : type}&kind=${type === 'me' ? 'personal' : type}${type === 'project' ? `&projectId=${projectId}` : ''}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
  return (
    <Modal title={`Mit ${provider.label} verbinden`} onClose={onClose}>
      <div className="form">
        {fixedProject ? <div className="field"><span>Projektkonto für</span><span><span className="badge">{fixedProject.key}</span> {fixedProject.name}</span></div> : (
          <label className="field"><span>Art des Postfachs</span><select value={type} onChange={(e) => setType(e.target.value as any)}>{allowed('personal') && <option value="me">Persönlich: eigenes Konto (Meine Konten)</option>}{allowed('project') && <option value="project" disabled={!projects.length}>Projektpostfach: gehört einem Projekt, die PL pflegt es</option>}{user?.globalRole === 'org_admin' && allowed('central') && <option value="central">Zentrales Postfach: Organisation, für mehrere Projekte</option>}{user?.globalRole === 'org_admin' && allowed('org') && <option value="org">Org-Postfach: Systemmails (Einladungen, Digest, Passwort)</option>}</select></label>
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
export function AccountForm({ existing, projects, onClose, onSaved, fixedProject, hasOrgMailbox = false, kinds }: { existing?: MailAccount; projects: Project[]; onClose: () => void; onSaved: () => Promise<void>; fixedProject?: Project; hasOrgMailbox?: boolean; /** anlegbare Arten (Standard: alle, die der Rolle offenstehen) */ kinds?: AccountKind[] }) {
  const { user } = useAuth();
  const isAdmin = user?.globalRole === 'org_admin';
  const allowed = (k: AccountKind) => !kinds || kinds.length === 0 || kinds.includes(k);
  const firstKind: AccountKind = fixedProject ? 'project' : allowed('personal') ? 'personal' : allowed('central') ? 'central' : allowed('org') ? 'org' : 'project';
  const [f, setF] = useState({
    kind: firstKind, offeredToAll: true, projectId: fixedProject?.id ?? projects[0]?.id ?? '', name: existing?.name ?? '', address: existing?.address ?? '', provider: existing?.provider ?? 'imap',
    imapHost: existing?.imapHost ?? '', imapPort: existing?.imapPort ?? 993, imapUser: existing?.imapUser ?? '', imapPassword: '', imapSecure: existing?.imapSecure ?? true,
    smtpHost: existing?.smtpHost ?? '', smtpPort: existing?.smtpPort ?? 587, smtpUser: existing?.smtpUser ?? '', smtpPassword: '', smtpSecure: existing?.smtpSecure ?? false
  });
  const [test, setTest] = useState<TestResult | null>(null);
  const { busy, error, run } = useAsync();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const payload = () => ({ ...f, managedBy: f.kind === 'personal' ? 'me' : f.kind === 'project' ? 'project' : 'org', imapUser: f.imapUser || f.address, smtpUser: f.smtpUser || f.imapUser || f.address, imapPassword: f.imapPassword || undefined, smtpPassword: f.smtpPassword || f.imapPassword || undefined });
  return (
    <Modal title={existing ? `Konto bearbeiten: ${existing.name}` : 'Mail-Konto anbinden'} onClose={onClose}>
      <div className="form cols-2">
        {!existing && fixedProject && <div className="field full"><span>Projektpostfach für</span><span><span className="badge">{fixedProject.key}</span> {fixedProject.name} · das erste Projektpostfach wird Standard, seine Adresse Projekt-Mailadresse</span></div>}
        {!existing && !fixedProject && (kinds?.length ?? 2) > 1 && <label className="field"><span>Art des Postfachs</span><select value={f.kind} onChange={(e) => set('kind', e.target.value)}>{allowed('personal') && <option value="personal">Persönlich: eigenes Konto (Meine Konten)</option>}{allowed('project') && <option value="project" disabled={!projects.length}>Projektpostfach: gehört einem Projekt, die PL pflegt es</option>}{isAdmin && allowed('central') && <option value="central">Zentrales Postfach: Organisation, für mehrere Projekte</option>}{isAdmin && allowed('org') && <option value="org" disabled={hasOrgMailbox}>Org-Postfach: Systemmails (Einladungen, Digest, Passwort){hasOrgMailbox ? ' · gibt es schon' : ''}</option>}</select></label>}
        {!existing && !fixedProject && f.kind === 'central' && <label className="check full" title="Jede PL darf das Postfach in ihr Projekt holen (nicht in persönliche Projekte); sonst bietet der Org-Admin es einzelnen Projekten an"><input type="checkbox" checked={f.offeredToAll} onChange={(e) => set('offeredToAll', e.target.checked)} /> für alle Projekte wählbar</label>}
        {!existing && !fixedProject && f.kind === 'project' && <label className="field"><span>Projekt</span><select value={f.projectId} onChange={(e) => set('projectId', e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.key} – {p.name}</option>)}</select></label>}
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
        <p className="muted small full">Nach dem Anbinden im Projekt unter Einstellungen › Mail eine Ansicht anlegen (Filter nach Absender, Betreff, Ordner). Erst dann werden Mails geladen; gespeichert werden nur Treffer. Bei one.com: IMAP imap.one.com:993 SSL, SMTP send.one.com:587 STARTTLS, Benutzer = volle Adresse.</p>
      </div>
    </Modal>
  );
}

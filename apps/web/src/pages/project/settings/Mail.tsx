import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../lib/api';
import { useAsync, useDialog } from '../../../components/ui';
import { AccountForm, OAuthStartDialog, kindLabel, useLabel } from '../../../components/mail/Accounts';
import { useAiStatus } from '../../../lib/useAi';
import type { MailAccount, MailInquiryMode } from '@projekttool/shared';
import { useProject } from '../../ProjectPage';
import { useData } from '../../../lib/useData';
import { useAuth } from '../../../lib/auth';
import { FilterEditor, NewView, RightsEditor, type ViewRow } from '../MailView';
import { AiFolderDialog } from '../MailAi';
import { SettingsCard, InheritSelect, ReadOnlyNote, useFlash } from '../../../components/settings/Settings';

/** Konten des Projekts: Projektbindungen mit Standard-Ausgangskonto, angebotene Konten der Organisation, Anbinden eigener oder verwalteter Konten. */
export function ProjectAccountsCard() {
  const { detail, reload } = useProject();
  const [account, setAccount] = useState(false);
  const oauth = useData<{ providers: { key: 'microsoft' | 'google'; label: string; mailProvider: 'graph' | 'imap' }[] }>('/oauth/providers');
  const [oauthStart, setOauthStart] = useState<{ key: 'microsoft' | 'google'; label: string; mailProvider: 'graph' | 'imap' } | null>(null);
  const providers = oauth.data?.providers ?? [];
  const { user } = useAuth();
  const isPl = detail.project.myMembership.role === 'pl';
  const data = useData<{ accounts: MailAccount[]; bindable: MailAccount[] }>(`/projects/${detail.project.id}/mail/accounts`);
  const [bindId, setBindId] = useState('');
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const refresh = async () => { await data.reload(); await reload(); };
  const accounts = data.data?.accounts ?? [];
  const bindable = data.data?.bindable ?? [];
  return (
    <div className="card" id="konten">
      <h2>Postfächer des Projekts</h2>
      <p className="muted small">Antwortadresse (Plus-Code), Absender für Agenten, Einladungen, Erinnerungen, Berichte und Workflows. Genau eines ist Standard für ausgehende Mails. Die PL legt ein <strong>Projektpostfach</strong> an oder holt ein <strong>zentrales Postfach</strong> der Organisation (vom Org-Admin angeboten oder für alle Projekte freigegeben) bzw. ein eigenes Konto ins Projekt; das Org-Postfach bleibt den Systemmails vorbehalten.</p>
      {error && <div className="error small">{error}</div>}
      {accounts.length === 0 && <p className="notice small">Kein Projektkonto: Nachfragen, Erinnerungen, PDF-Versand und Reporting brauchen eines.</p>}
      {accounts.length > 0 && <table className="table"><thead><tr><th>Standard</th><th>Konto</th><th>Art</th><th /></tr></thead><tbody>
        {accounts.map((a) => <tr key={a.id}>
          <td><input type="radio" name="default-account" checked={Boolean(a.isDefault)} disabled={!isPl || busy} title={isPl ? 'Als Standard für ausgehende Mails setzen' : 'Standard-Ausgangskonto'} onChange={() => void run(async () => { await api.put(`/projects/${detail.project.id}/mail/default-account`, { accountId: a.id }); await refresh(); })} /></td>
          <td>{a.name}<div className="muted small">{a.address}{a.offered && <span className="badge" style={{ marginLeft: 6 }} title="Vom Org-Admin angeboten; wird nie automatisch Standard">angeboten</span>}</div></td>
          <td className="small">{kindLabel(a, user?.id, [detail.project])}</td>
          <td className="nowrap">{isPl && <button className="btn sm link" disabled={busy} onClick={() => { const u = a.uses?.find((x) => x.use === 'project' && x.projectId === detail.project.id); if (u) void dialog.confirm({ title: 'Projektbindung lösen', text: `${a.address} nicht mehr als Projektkonto nutzen? Ansichten darüber verschwinden, Kopien in Arbeitspaketen bleiben.`, confirmLabel: 'Lösen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/mail/accounts/${a.id}/uses/${u.id}`); await refresh(); }); }); }}>Bindung lösen</button>}</td>
        </tr>)}
      </tbody></table>}
      {isPl && <div className="row mt">
        <button className="btn sm primary" onClick={() => setAccount(true)}>Neues Projektpostfach anbinden</button>
        {providers.map((p) => <button key={p.key} className="btn sm" onClick={() => setOauthStart(p)}>Mit {p.label} verbinden</button>)}
        {bindable.length > 0 && <>
          <select value={bindId} onChange={(e) => setBindId(e.target.value)} style={{ width: 'auto' }}><option value="">– vorhandenes Postfach ins Projekt holen –</option>{bindable.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.address}) · {kindLabel(a, user?.id, [detail.project])}{(a.uses ?? []).filter((u) => u.use === 'project').length ? ` · in ${(a.uses ?? []).filter((u) => u.use === 'project').map(useLabel).join(', ')}` : ''}</option>)}</select>
          <button className="btn sm" disabled={!bindId || busy} onClick={() => void run(async () => { await api.post(`/mail/accounts/${bindId}/uses`, { use: 'project', projectId: detail.project.id }); setBindId(''); await refresh(); })}>Binden</button>
        </>}
      </div>}
      {oauthStart && <OAuthStartDialog provider={oauthStart} projects={[detail.project]} fixedProject={detail.project} onClose={() => setOauthStart(null)} />}
      {account && <AccountForm projects={[detail.project]} fixedProject={detail.project} onClose={() => setAccount(false)} onSaved={async () => { setAccount(false); await refresh(); }} />}
    </div>
  );
}

export function MailViewsCard() {
  const { detail } = useProject();
  const { user } = useAuth();
  const accts = useData<{ accounts: MailAccount[] }>(`/projects/${detail.project.id}/mail/accounts`);
  const kindOf = (accountId: string) => { const a = accts.data?.accounts.find((x) => x.id === accountId); return a ? kindLabel(a, user?.id, [detail.project]) : null; };
  const isPl = detail.project.myMembership.role === 'pl';
  const views = useData<{ views: ViewRow[] }>(`/projects/${detail.project.id}/mail/views`);
  const [newView, setNewView] = useState(false);
  const [rightsFor, setRightsFor] = useState<ViewRow | null>(null);
  const [filterFor, setFilterFor] = useState<ViewRow | null>(null);
  const [aiFolder, setAiFolder] = useState(false);
  const { busy, error, run } = useAsync();
  const agents = detail.members.filter((m) => m.kind === 'agent');
  const setAi = (v: ViewRow, body: { aiProcess?: boolean; agentUserId?: string | null }) => run(async () => { await api.patch(`/mail/views/${v.id}`, body); await views.reload(); });
  const f = (v: ViewRow) => { const x = v.filter; return [x.folders?.length && `Ordner ${x.folders.join(', ')}`, x.from?.length && `Von ${x.from.join(', ')}`, x.to?.length && `An ${x.to.join(', ')}`, x.subject?.length && `Betreff ${x.subject.join(', ')}`, x.keyword?.length && `Stichwort ${x.keyword.join(', ')}`, x.since && `ab ${x.since}`].filter(Boolean).join(' · ') || 'alle Mails des Kontos'; };
  return (
    <div>
      <p className="muted small">Eine Ansicht ist ein Filter auf ein Konto. Nur Treffer werden gespeichert. Rechte (Lesen, Entwurf, Senden, Arbeitspaket erzeugen) hängen an der Ansicht: je Person, Rolle oder Gruppe.</p>
      {views.data && views.data.views.length === 0 && <div className="empty">Noch keine Ansicht. Ohne Ansicht werden keine Mails geladen.</div>}
      {error && <div className="error small">{error}</div>}
      {views.data && views.data.views.length > 0 && <table className="table"><thead><tr><th>Ansicht</th><th>Konto</th><th>Filter</th><th title="Ein Agent bearbeitet neue Mails der Ansicht: als stellvertretende PL direkt, als Mitglied Vorschläge; „Ordner“ heißt: jede Mail dort sofort">Agent</th><th /></tr></thead><tbody>
        {views.data.views.map((v) => <tr key={v.id}><td>{v.name}</td><td className="small">{v.accountAddress}<div className="muted">{kindOf(v.accountId) ?? (v.accountType === 'personal' ? 'persönlich' : v.accountType === 'org' ? 'Organisation' : 'Projektkonto')}</div></td><td className="small muted">{f(v)}</td>
          <td className="small">{(() => {
            const may = v.canManage && (v.accountType === 'personal' || isPl);
            const projectAgent = v.accountType === 'project' && detail.project.agentUserId && detail.project.agentMail !== 'off' ? agents.find((a) => a.userId === detail.project.agentUserId) : null;
            const label = (a: { name: string; role: string }) => `${a.name} (${a.role === 'pl' ? 'stellv. PL: legt direkt an' : 'Mitglied: schlägt vor'})`;
            if (!may) return <span className="muted">{v.agentName ? `${v.agentName}${v.aiProcess ? ' · Ordner' : ''}` : projectAgent ? `Projektagent ${projectAgent.name}` : '–'}</span>;
            return <>
              <select value={v.agentUserId ?? ''} disabled={busy} style={{ width: 'auto' }} onChange={(e) => void setAi(v, { agentUserId: e.target.value || null })}><option value="">{projectAgent ? `– Projektagent ${projectAgent.name} –` : '– kein Agent –'}</option>{agents.map((a) => <option key={a.userId} value={a.userId}>{label(a)}</option>)}</select>
              <label className="check" title="Jede Mail, die in diesem Ordner landet, bearbeitet der Agent sofort (Ordner „KI Bearbeiten“)"><input type="checkbox" checked={Boolean(v.aiProcess)} disabled={busy || (!v.aiProcess && !v.agentUserId && !projectAgent)} onChange={(e) => void setAi(v, { aiProcess: e.target.checked })} /> Ordner: sofort bearbeiten</label>
            </>;
          })()}</td>
          <td className="nowrap">{v.canManage && <><button className="btn sm link" onClick={() => setFilterFor(v)}>Filter</button><button className="btn sm link" onClick={() => setRightsFor(v)}>Rechte</button></>}</td></tr>)}
      </tbody></table>}
      <div className="row mt"><button className="btn sm" onClick={() => setNewView(true)}>+ Ansicht</button><button className="btn sm" disabled={agents.length === 0} title={agents.length ? 'Ordner im Konto, dessen Mails ein Agent sofort bearbeitet (als stellv. PL direkt, als Mitglied Vorschläge)' : 'Erst einen KI-Agenten als Mitglied aufnehmen'} onClick={() => setAiFolder(true)}>Ordner „KI Bearbeiten“ einrichten</button></div>
      {aiFolder && <AiFolderDialog onClose={() => setAiFolder(false)} onDone={() => { setAiFolder(false); void views.reload(); }} />}
      {newView && <NewView onClose={() => setNewView(false)} onCreated={() => { setNewView(false); void views.reload(); }} />}
      {rightsFor && <RightsEditor view={rightsFor} onClose={() => setRightsFor(null)} onChanged={() => void views.reload()} />}
      {filterFor && <FilterEditor view={filterFor} onClose={() => setFilterFor(null)} onSaved={() => { setFilterFor(null); void views.reload(); }} />}
    </div>
  );
}

function ReminderForm() {
  const { detail, reload } = useProject();
  const me = detail.project.myMembership;
  const p = detail.project.reminders!;
  const [f, setF] = useState({ enabled: p.enabled, daysBefore: p.daysBefore.join(', '), overdueEveryDays: p.overdueEveryDays ?? '', includeInternal: p.includeInternal });
  const { busy, error, run } = useAsync();
  if (me.role !== 'pl') return <p className="small muted">{p.enabled ? `Externe Zuständige werden ${p.daysBefore.map((d) => d === 0 ? 'am Fälligkeitstag' : `${d} Tage vorher`).join(', ')}${p.overdueEveryDays ? ` und bei Verzug alle ${p.overdueEveryDays} Tage` : ''} per Mail erinnert.` : 'Keine automatischen Erinnerungen.'}</p>;
  return (
    <div className="form">
      <p className="muted small">Mail über das Projektkonto an externe Zuständige (Arbeitspaket mit Mail-Adresse); die Antwort landet über die Antwortadresse im Arbeitspaket. Je Arbeitspaket und Tag höchstens eine Mail.{!detail.project.mailAddress && <span style={{ color: 'var(--warn)' }}> Ohne Projektkonto wird nichts verschickt.</span>}</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Erinnerungen aktiv</label>
      <div className="row small"><span>Tage vor Fälligkeit</span><input type="text" value={f.daysBefore} onChange={(e) => setF({ ...f, daysBefore: e.target.value })} placeholder="3, 0" style={{ width: 90 }} /><span>(0 = am Tag selbst)</span></div>
      <div className="row small"><span>Bei Verzug alle</span><input type="number" min={1} max={30} value={f.overdueEveryDays} onChange={(e) => setF({ ...f, overdueEveryDays: e.target.value })} placeholder="–" style={{ width: 60 }} /><span>Tage (leer = nicht)</span></div>
      <label className="check"><input type="checkbox" checked={f.includeInternal} onChange={(e) => setF({ ...f, includeInternal: e.target.checked })} /> auch interne Zuständige per Mail erinnern</label>
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { reminders: { enabled: f.enabled, daysBefore: f.daysBefore.split(/[,;\s]+/).filter(Boolean).map(Number), overdueEveryDays: f.overdueEveryDays === '' ? null : Number(f.overdueEveryDays), includeInternal: f.includeInternal } }); await reload(); })}>Speichern</button></div>
    </div>
  );
}

const INQUIRY_OPTIONS = [
  { key: 'ask_pl', label: 'PL fragen (Karte: klar / im Projekt fragen / beim Absender rückfragen)' },
  { key: 'ask_project', label: 'im Projekt fragen' },
  { key: 'ask_sender', label: 'beim Absender rückfragen' },
  { key: 'off', label: 'aus (offene Punkte nur im Log)' }
] as const;

/** Mail-Rückfrage (Konzept 5): wie der Projektagent mit offenen Punkten aus neuen Mails umgeht; erbt die Vorgabe des Mandanten (Verwaltung › Mail). */
export function MailInquiryCard() {
  const { detail, reload } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  const { busy, error, run } = useAsync();
  const v = detail.project.mailInquiry ?? { mode: 'ask_pl' as MailInquiryMode, waitHours: 48, inherited: true };
  const own = v.inherited ? undefined : v.mode;
  const [hours, setHours] = useState<string | null>(null);
  const save = (body: unknown) => run(async () => { await api.patch(`/projects/${detail.project.id}`, { mailInquiry: body }); setHours(null); await reload(); });
  return (
    <SettingsCard title="Mail-Rückfrage" hint="Nennt die Mail-KI zu einer neuen Mail offene Punkte, fragt der Projektagent nach, statt zu raten. Ohne Projektagent stehen sie im Log des Arbeitspakets. Ohne eigenen Wert gilt die Vorgabe des Mandanten.">
      {!isPl && <ReadOnlyNote who="PL" />}
      <div className="row small" style={{ flexWrap: 'wrap' }}>
        <InheritSelect ariaLabel="Mail-Rückfrage" value={own} effective={{ value: v.mode, origin: 'Mandant' }} options={INQUIRY_OPTIONS} disabled={!isPl || busy} onChange={(mode) => void save(mode ? { mode, waitHours: v.waitHours } : null)} />
        {v.mode !== 'off' && <label className="row small" style={{ gap: 4 }}>Frist <input type="number" min={1} max={720} value={hours ?? String(v.waitHours)} disabled={!isPl || busy || v.inherited} title={v.inherited ? 'Frist aus der Vorgabe des Mandanten; für eine eigene Frist zuerst einen eigenen Modus wählen' : 'Stunden, nach denen eine Rückfrage im Projekt weitergegeben wird'} style={{ width: 70 }} onChange={(e) => setHours(e.target.value)} onBlur={() => { const h = Number(hours); if (hours !== null && Number.isInteger(h) && h >= 1 && h <= 720 && h !== v.waitHours) void save({ mode: v.mode, waitHours: h }); else setHours(null); }} /> h{v.inherited && <span className="muted">(Mandant)</span>}</label>}
      </div>
      {error && <div className="error small mt">{error}</div>}
    </SettingsCard>
  );
}

/**
 * Außenkommunikation (Informationsgrenze für Externe): externes Profil, das Externe über das Projekt erfahren dürfen (Name nach außen,
 * Adresse, Zufahrt). Ansprechpartner für Externe sind Projektkontakte mit Kennzeichen „nach außen“ (Reiter Personen); die Prüfstufe setzt der Mandant.
 */
export function ExternalCard() {
  const { detail, reload } = useProject();
  const ai = useAiStatus();
  const isPl = detail.project.myMembership.role === 'pl';
  const p = detail.project.externalProfile ?? {};
  const [f, setF] = useState({ name: p.name ?? '', address: p.address ?? '', access: p.access ?? '' });
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash();
  const guard = ai?.externalGuard === 'check' ? 'nur prüfen (ohne Neuformulierung)' : 'neu formulieren und prüfen';
  const dirty = f.name !== (p.name ?? '') || f.address !== (p.address ?? '') || f.access !== (p.access ?? '');
  const contacts = p.contacts?.length ? p.contacts.map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}${c.email ? ` <${c.email}>` : ''}`).join('; ') : 'keiner (Verweis an „die Projektleitung“)';
  return (
    <SettingsCard title="Außenkommunikation" hint={<>KI-Agenten schreiben Externen nur, was zu deren Aufgabe gehört: Außenbeschreibung des AP, Log-Einträge „für Externe sichtbar“, freigegebene Seiten und dieses Profil. Prüfstufe (<Link to="/verwaltung/mail">Verwaltung › Mail</Link>): <strong>{guard}</strong>. Der erste Kontakt zu einer Adresse ohne Bezug zum AP geht immer als Entwurf; Angehaltenes steht unter <Link to={`/projekte/${detail.project.id}/mail/freigaben`}>Mail › Freigaben</Link>.</>}>
      {!isPl && <ReadOnlyNote who="PL" />}
      {!isPl ? <dl className="kv"><dt>Name nach außen</dt><dd>{p.name || '–'}</dd><dt>Adresse</dt><dd>{p.address || '–'}</dd><dt>Zufahrt, Hinweise</dt><dd>{p.access || '–'}</dd><dt>Ansprechpartner</dt><dd>{contacts}</dd></dl> : (
        <div className="form">
          <label className="field"><span>Name nach außen (statt des internen Projektnamens)</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Neubau Firmensitz" /></label>
          <label className="field"><span>Adresse</span><input type="text" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
          <label className="field"><span>Zufahrt und Hinweise für Externe</span><textarea value={f.access} onChange={(e) => setF({ ...f, access: e.target.value })} /></label>
          <div className="field"><span>Ansprechpartner für Externe</span><span className="small">{contacts} · <Link to={`/projekte/${detail.project.id}/einstellungen/personen`}>Kontakte mit „nach außen“ pflegen</Link></span></div>
          {error && <div className="error">{error}</div>}
          <div className="row"><button className="btn primary sm" disabled={busy || !dirty} onClick={() => void run(async () => { await api.put(`/projects/${detail.project.id}/external-profile`, f); await reload(); flash('Gespeichert.'); })}>Speichern</button>{msg && <span className="muted small">{msg}</span>}</div>
        </div>
      )}
    </SettingsCard>
  );
}

/** Projekt › Einstellungen › Mail: Postfächer, Ansichten und Filter, Mail-Rückfrage, Außenkommunikation, Erinnerungen an Externe. */
export function MailTab() {
  const { detail } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  return (
    <>
      <ProjectAccountsCard />
      <SettingsCard title="Ansichten und Filter"><MailViewsCard /></SettingsCard>
      <MailInquiryCard />
      <ExternalCard />
      <SettingsCard title="Erinnerungen an Externe">{!isPl && <ReadOnlyNote who="PL" />}<ReminderForm /></SettingsCard>
    </>
  );
}

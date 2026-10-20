import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EffectiveNotifyRule, Group, NotificationRule, NotifyChat, NotifyEvent, NotifyEvery, NotifyField, NotifyLevel, NotifyMail, Project, User } from '@projekttool/shared';
import { NOTIFY_EVENTS, NOTIFY_LEVEL_FIELDS, NOTIFY_LEVEL_LABEL, NOTIFY_ROLES } from '@projekttool/shared';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { Modal, useAsync } from './ui';

/**
 * Benachrichtigungsregeln (Regel N) in der Oberfläche: dieselbe Matrix für Org (Verwaltung), Projekt (Einstellungen),
 * Benutzer (Benutzereinstellungen, je Projekt) und den Berichtswunsch am AP. Geerbte Werte stehen grau mit Herkunft,
 * gesperrte Felder sind deaktiviert (🔒 mit Ebene); Org und Projekt sperren Felder für die Ebenen darunter.
 */
type Level = Exclude<NotifyLevel, 'code'>;
export interface RuleItem { event: string; recipients?: string[] | null; channels?: NotificationRule['channels']; timing?: NotificationRule['timing']; locked?: NotifyField[] }
export interface RulesListing { rules: NotificationRule[]; effective: EffectiveNotifyRule[] }
export interface RuleTargets { groups: { id: string; name: string }[]; users: { id: string; name: string }[] }

export const CHAT_LABEL: Record<NotifyChat, string> = { off: 'aus', thread: 'Thread', project: 'Projektkanal' };
export const MAIL_LABEL: Record<NotifyMail, string> = { off: 'aus', now: 'sofort', digest: 'Digest' };
export const EVERY_LABEL: Record<NotifyEvery, string> = { each: 'jeder Zwischenstand', milestones: 'Meilensteine', daily: 'einmal am Tag', done: 'nur Abschluss' };
const ABOVE: Record<Level, Level[]> = { org: [], project: ['org'], task: ['org', 'project'], user: ['org'], user_project: ['org', 'project'], user_task: ['org', 'project'] };

export function recipientsLabel(list: string[], t?: RuleTargets): string {
  if (!list.length) return 'niemand';
  const one = (r: string) => NOTIFY_ROLES.find((x) => x.key === r)?.label
    ?? (r.startsWith('group:') ? `Gruppe ${t?.groups.find((g) => `group:${g.id}` === r)?.name ?? '?'}` : r.startsWith('user:') ? t?.users.find((u) => `user:${u.id}` === r)?.name ?? 'Person' : r);
  return list.map((e) => e.split('|').map(one).join(', sonst ')).join(' · ');
}

/**
 * Regelzeile als Eingabe für PUT (alle gesetzten Angaben der Ebene); Änderungen setzen bzw. entfernen einzelne Angaben.
 * Die gespeicherte Doku-Seite geht als „an“ zurück (der Server löst die Seite des Projekts auf, auch nach dem Löschen).
 */
function itemOf(row: NotificationRule | undefined, event: string): RuleItem {
  const channels = { ...(row?.channels ?? {}) };
  if (typeof channels.doc === 'string') channels.doc = true as unknown as string;
  return { event, recipients: row?.recipients ?? null, channels, timing: { ...(row?.timing ?? {}) }, locked: [...(row?.locked ?? [])] };
}

export function RulesMatrix({ level, data, canEdit, onSave, events, targets }: { level: Level; data: RulesListing; canEdit: boolean; onSave: (items: RuleItem[]) => Promise<unknown>; events?: NotifyEvent[]; targets?: RuleTargets }) {
  const [rec, setRec] = useState<{ event: string; label: string; list: string[] } | null>(null);
  const fields = NOTIFY_LEVEL_FIELDS[level];
  const userLevel = level.startsWith('user');
  const canLock = canEdit && (level === 'org' || level === 'project');
  const rowAt = (e: string) => data.rules.find((r) => r.event === e);
  const effOf = (e: string) => data.effective.find((x) => x.event === e);
  const save = (e: string, change: (it: RuleItem) => void) => { const it = itemOf(rowAt(e), e); change(it); return onSave([it]); };
  const lockedAbove = (e: string, f: NotifyField) => { const l = effOf(e)?.locked[f]; return l && ABOVE[level].includes(l) ? l : null; };
  const ownLock = (e: string, f: NotifyField) => Boolean(rowAt(e)?.locked.includes(f));
  const inherited = (e: string, f: NotifyField, text: (v: any) => string) => {
    const eff = effOf(e);
    if (!eff || eff.value[f] === undefined) return 'erbt';
    return `erbt: ${text(eff.value[f])} (${NOTIFY_LEVEL_LABEL[eff.origin[f] ?? 'code']})`;
  };
  const Lock = ({ e, f }: { e: string; f: NotifyField }) => canLock && !lockedAbove(e, f)
    ? <button className={`btn sm link lock ${ownLock(e, f) ? 'on' : ''}`} title={ownLock(e, f) ? 'Gesperrt für die Ebenen darunter (Klick hebt auf)' : 'Für die Ebenen darunter sperren'} aria-label={`${f} sperren`} aria-pressed={ownLock(e, f)} onClick={() => void save(e, (it) => { it.locked = ownLock(e, f) ? it.locked!.filter((x) => x !== f) : [...it.locked!, f]; })}>{ownLock(e, f) ? '🔒' : '🔓'}</button>
    : null;
  const lockNote = (e: string, f: NotifyField) => { const l = lockedAbove(e, f); return l ? <span className="muted small" title="Gesperrt auf einer Ebene darüber">🔒 {NOTIFY_LEVEL_LABEL[l]}</span> : null; };
  const channelSelect = (e: string, f: 'chat' | 'mail' | 'log', options: [string, string][], text: (v: any) => string) => {
    const own = (rowAt(e)?.channels as any)?.[f];
    const locked = lockedAbove(e, f);
    return (
      <span className="row nowrap" style={{ gap: 2 }}>
        <select aria-label={`${e} ${f}`} className={own === undefined ? 'inherited' : ''} disabled={!canEdit || Boolean(locked)} value={own === undefined ? '' : String(own)}
          onChange={(x) => void save(e, (it) => { const v = x.target.value; if (v === '') delete (it.channels as any)[f]; else (it.channels as any)[f] = f === 'log' ? v === 'true' : v; })}>
          <option value="">{e === '*' ? 'erbt' : inherited(e, f, text)}</option>
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <Lock e={e} f={f} />{lockNote(e, f)}
      </span>
    );
  };
  const rows = [{ key: '*', label: 'Alle Klassen', fixedChat: false, noChat: false, timing: false, types: 'Standard für jede Klasse ohne eigene Zeile' }, ...NOTIFY_EVENTS.filter((x) => !events || events.includes(x.key))];
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table notify-matrix"><thead><tr>
        <th>Klasse</th>
        {fields.includes('recipients') && <th>Empfänger</th>}
        <th>Chat</th><th>Mail</th>
        {fields.includes('log') && <th>Log</th>}
        {fields.includes('doc') && <th title="Seite „Entscheidungen und Meldungen“">Doku</th>}
        {fields.includes('remindH') && <th>Fristen</th>}
        {level === 'user_task' && <th>Zwischenstände</th>}
      </tr></thead><tbody>
        {rows.map((ev) => {
          const e = ev.key;
          const own = rowAt(e);
          const eff = effOf(e);
          return (
            <tr key={e}>
              <td className="small"><strong>{ev.label}</strong><div className="muted">{ev.types}</div></td>
              {fields.includes('recipients') && <td className="small">
                <span className={own?.recipients ? '' : 'muted'}>{own?.recipients ? recipientsLabel(own.recipients, targets) : e === '*' ? 'erbt' : `${recipientsLabel(eff?.value.recipients ?? [], targets)} (${NOTIFY_LEVEL_LABEL[eff?.origin.recipients ?? 'code']})`}</span>
                {canEdit && !lockedAbove(e, 'recipients') && <button className="btn sm link" onClick={() => setRec({ event: e, label: ev.label, list: own?.recipients ?? eff?.value.recipients ?? [] })}>ändern</button>}
                <Lock e={e} f="recipients" />{lockNote(e, 'recipients')}
              </td>}
              <td>{ev.fixedChat ? <span className="muted small" title="Bei Fragen ist der Chat die Frage selbst">Thread (fest)</span> : ev.noChat ? <span className="muted small">–</span>
                : channelSelect(e, 'chat', (userLevel ? ['off', 'thread'] : ['off', 'thread', 'project']).map((v) => [v, CHAT_LABEL[v as NotifyChat]]), (v) => CHAT_LABEL[v as NotifyChat])}</td>
              <td>{channelSelect(e, 'mail', (['now', 'digest', 'off'] as NotifyMail[]).map((v) => [v, MAIL_LABEL[v]]), (v) => MAIL_LABEL[v as NotifyMail])}</td>
              {fields.includes('log') && <td>{channelSelect(e, 'log', [['true', 'an'], ['false', 'aus']], (v) => (v ? 'an' : 'aus'))}</td>}
              {fields.includes('doc') && <td>{e === '*' ? null : <label className="check small"><input type="checkbox" aria-label={`${e} Doku`} disabled={!canEdit} checked={Boolean(eff?.value.doc)} onChange={(x) => void save(e, (it) => { it.channels!.doc = x.target.checked ? (true as unknown as string) : false; })} /> Seite</label>}</td>}
              {fields.includes('remindH') && <td className="small">{ev.timing && e !== 'progress' ? <span className="row nowrap" style={{ gap: 4 }}>
                {(['remindH', 'escalateH', 'expireH'] as const).filter((f) => fields.includes(f)).map((f) => <input key={f} type="number" min={1} max={2000} aria-label={`${e} ${f}`} title={f === 'remindH' ? 'Erinnern nach Stunden' : f === 'escalateH' ? 'Weitergeben nach Stunden' : 'Verfällt nach Stunden'} disabled={!canEdit || Boolean(lockedAbove(e, f))} style={{ width: 64 }}
                  defaultValue={own?.timing[f] ?? ''} placeholder={eff?.value[f] ? `${eff.value[f]} h` : '–'} onBlur={(x) => { const v = x.target.value ? Number(x.target.value) : undefined; if (v !== own?.timing[f]) void save(e, (it) => { if (v === undefined) delete it.timing![f]; else it.timing![f] = v; }); }} />)}
              </span> : e === 'progress' ? <EverySelect value={own?.timing.every} inheritedText={inherited(e, 'every', (v) => EVERY_LABEL[v as NotifyEvery])} disabled={!canEdit || Boolean(lockedAbove(e, 'every'))} onChange={(v) => void save(e, (it) => { if (v) it.timing!.every = v; else delete it.timing!.every; })} /> : null}</td>}
              {level === 'user_task' && <td>{e === 'progress' ? <EverySelect value={own?.timing.every} inheritedText={inherited(e, 'every', (v) => EVERY_LABEL[v as NotifyEvery])} disabled={!canEdit} onChange={(v) => void save(e, (it) => { if (v) it.timing!.every = v; else delete it.timing!.every; })} /> : null}</td>}
            </tr>
          );
        })}
      </tbody></table>
      {rec && <RecipientsDialog label={rec.label} value={rec.list} targets={targets} inherit={rec.event !== '*' || Boolean(rowAt('*')?.recipients)} onClose={() => setRec(null)} onSave={(list) => void save(rec.event, (it) => { it.recipients = list; }).then(() => setRec(null))} />}
    </div>
  );
}

function EverySelect({ value, inheritedText, disabled, onChange }: { value?: NotifyEvery; inheritedText: string; disabled: boolean; onChange: (v: NotifyEvery | null) => void }) {
  return (
    <select aria-label="Zwischenstände" className={value ? '' : 'inherited'} disabled={disabled} value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as NotifyEvery | null)}>
      <option value="">{inheritedText}</option>
      {(Object.keys(EVERY_LABEL) as NotifyEvery[]).map((k) => <option key={k} value={k}>{EVERY_LABEL[k]}</option>)}
    </select>
  );
}

/** Empfänger einer Klasse: geordnete Rollenliste, Gruppen und Personen; „sonst“ hängt eine Rolle als Ersatz an den letzten Eintrag. */
function RecipientsDialog({ label, value, targets, inherit, onClose, onSave }: { label: string; value: string[]; targets?: RuleTargets; inherit: boolean; onClose: () => void; onSave: (list: string[] | null) => void }) {
  const [list, setList] = useState<string[]>(value);
  const [add, setAdd] = useState('');
  const [alt, setAlt] = useState(false);
  const push = () => {
    if (!add) return;
    setList(alt && list.length ? [...list.slice(0, -1), `${list[list.length - 1]}|${add}`] : [...list, add]);
    setAdd(''); setAlt(false);
  };
  return (
    <Modal title={`Empfänger: ${label}`} onClose={onClose}>
      <div className="form">
        <p className="muted small">Agenten, Inaktive, wer das Ereignis auslöst, und Personen ohne Sicht auf das AP bekommen nie eine Meldung. Gruppen zählen nur mit Projektzugriff.</p>
        {list.length === 0 && <div className="muted small">Niemand (nur die Empfänger der jeweiligen Stelle, z. B. Eskalationsstufen).</div>}
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{list.map((r, i) => <li key={`${r}-${i}`}>{recipientsLabel([r], targets)} <button className="btn sm link" aria-label={`${r} entfernen`} onClick={() => setList(list.filter((_, j) => j !== i))}>✕</button></li>)}</ul>
        <div className="row small" style={{ flexWrap: 'wrap' }}>
          <select aria-label="Empfänger hinzufügen" value={add} onChange={(e) => setAdd(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Rolle, Gruppe oder Person …</option>
            <optgroup label="Rollen">{NOTIFY_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</optgroup>
            {targets?.groups.length ? <optgroup label="Gruppen">{targets.groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}</optgroup> : null}
            {targets?.users.length ? <optgroup label="Personen">{targets.users.map((u) => <option key={u.id} value={`user:${u.id}`}>{u.name}</option>)}</optgroup> : null}
          </select>
          {list.length > 0 && <label className="check"><input type="checkbox" checked={alt} onChange={(e) => setAlt(e.target.checked)} /> nur als Ersatz für den letzten Eintrag („sonst“)</label>}
          <button className="btn sm" disabled={!add} onClick={push}>Hinzufügen</button>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => onSave(list)}>Speichern</button>
          {inherit && <button className="btn" onClick={() => onSave(null)}>Erben</button>}
          <button className="btn" onClick={onClose}>Abbrechen</button>
        </div>
      </div>
    </Modal>
  );
}

/** Verwaltung › Benachrichtigungen: Tages-Digest und Regeln der Org mit Schlössern und die Stunde des Tages-Digests (Europe/Berlin). */
export function OrgNotifyCard() {
  const d = useData<RulesListing & { digestHour: number }>('/org/notification-rules');
  const groups = useData<{ groups: Group[] }>('/groups');
  const users = useData<{ users: User[] }>('/users');
  const { busy, error, run } = useAsync();
  if (!d.data) return null;
  const targets: RuleTargets = { groups: groups.data?.groups ?? [], users: (users.data?.users ?? []).filter((u) => u.kind !== 'agent') };
  const put = (body: Record<string, unknown>) => run(async () => d.setData(await api.put<RulesListing & { digestHour: number }>('/org/notification-rules', body)));
  return (
    <>
      <div className="card">
        <h2>Tages-Digest</h2>
        <p className="muted small">Meldungen mit Mail-Modus „Digest“ gehen einmal täglich zu dieser Stunde (Europe/Berlin) über das Org-Postfach; gilt für alle Personen des Mandanten.</p>
        {error && <div className="error mb">{error}</div>}
        <label className="row small">Tages-Digest um
          <select aria-label="Digest-Stunde" value={d.data.digestHour} disabled={busy} onChange={(e) => void put({ digestHour: Number(e.target.value) })} style={{ width: 'auto' }}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select> Uhr</label>
      </div>
      <div className="card">
        <h2>Benachrichtigungsregeln</h2>
        <p className="muted small">Wer bei welchem Ereignis benachrichtigt wird und wie: In der App immer, dazu Chat, Mail (sofort, Digest oder aus) und Log. Projekte, Arbeitspakete und Personen erben und dürfen abweichen; ein Schloss sperrt das Feld für alle Ebenen darunter. Innerhalb einer Ebene geht die Zeile einer Klasse der Zeile „Alle Klassen“ vor.</p>
        <RulesMatrix level="org" data={d.data} canEdit={!busy} targets={targets} onSave={(rules) => put({ rules })} />
      </div>
    </>
  );
}

/** Projekt › Einstellungen › Benachrichtigungen: Regeln des Projekts (erbt von der Org, Sperren sichtbar), Doku-Seite und Vorschau „Wer bekommt was?“. */
export function ProjectNotifyCard({ projectId, members }: { projectId: string; members: { userId: string; name: string; kind?: string }[] }) {
  const d = useData<RulesListing & { canEdit: boolean }>(`/projects/${projectId}/notification-rules`, [projectId]);
  const groups = useData<{ groups: Group[] }>(d.data?.canEdit ? '/groups' : null, [d.data?.canEdit]);
  const [preview, setPreview] = useState(false);
  const { busy, error, run } = useAsync();
  if (!d.data) return null;
  const targets: RuleTargets = { groups: groups.data?.groups ?? [], users: members.filter((m) => m.kind !== 'agent').map((m) => ({ id: m.userId, name: m.name })) };
  const save = (rules: RuleItem[]) => run(async () => d.setData(await api.put<RulesListing & { canEdit: boolean }>(`/projects/${projectId}/notification-rules`, { rules })));
  const docPage = d.data.effective.map((e) => e.value.doc).find((x): x is string => typeof x === 'string') ?? null;
  const docOn = (e: string): RuleItem => { const it = itemOf(d.data!.rules.find((r) => r.event === e), e); it.channels!.doc = true as unknown as string; return it; };
  return (
    <>
      <p className="muted small">Erbt von der Org (<Link to="/verwaltung/benachrichtigungen">Verwaltung › Benachrichtigungen</Link>); 🔒 Org heißt gesperrt. Als PL weichst du für dieses Projekt ab und sperrst Felder für Arbeitspakete und Personen. Chat „Projektkanal“ gilt nie bei eingeschränkten Teilprojekten.</p>
      {error && <div className="error mb">{error}</div>}
      <RulesMatrix level="project" data={d.data} canEdit={d.data.canEdit && !busy} targets={targets} onSave={save} />
      <div className="row mt small" style={{ flexWrap: 'wrap' }}>
        {docPage ? <Link to={`/projekte/${projectId}/doku/${docPage}`}>Seite „Entscheidungen und Meldungen“</Link>
          : d.data.canEdit && <button className="btn sm" disabled={busy} title="Legt die Seite an; Entscheidungen und Eskalationen werden dort eingetragen" onClick={() => void save([docOn('decision'), docOn('escalation')])}>Doku-Seite „Entscheidungen und Meldungen“ einschalten</button>}
        {d.data.canEdit && <button className="btn sm" aria-expanded={preview} onClick={() => setPreview(!preview)}>Wer bekommt was?</button>}
      </div>
      {preview && <NotifyPreview projectId={projectId} targets={targets} />}
    </>
  );
}

interface PreviewEvent { event: NotifyEvent; label: string; rule: EffectiveNotifyRule; people: { id: string; name: string; roleLabel: string; mail: NotifyMail; chat: NotifyChat }[]; projectChannel: boolean; perEvent: string[]; caller: string | null }

/** Vorschau: je Klasse die Personen mit Rolle und Mail-Modus, dazu Kanäle und was erst am Ereignis feststeht. */
export function NotifyPreview({ projectId, taskId, targets }: { projectId: string; taskId?: string; targets?: RuleTargets }) {
  const d = useData<{ events: PreviewEvent[] }>(`/projects/${projectId}/notification-rules/effective${taskId ? `?taskId=${taskId}` : ''}`, [projectId, taskId]);
  if (d.error) return <div className="error small mt">{d.error}</div>;
  if (!d.data) return null;
  return (
    <table className="table mt notify-preview"><thead><tr><th>Klasse</th><th>Bekommt</th><th>Kanäle</th></tr></thead><tbody>
      {d.data.events.map((e) => (
        <tr key={e.event}>
          <td className="small"><strong>{e.label}</strong><div className="muted">{recipientsLabel(e.rule.value.recipients, targets)}</div></td>
          <td className="small">
            {e.people.map((p) => <div key={p.id}>{p.name} <span className="muted">({p.roleLabel}) · Mail {MAIL_LABEL[p.mail]}</span></div>)}
            {e.perEvent.length > 0 && <div className="muted">je Ereignis: {e.perEvent.join(', ')}</div>}
            {e.caller && <div className="muted">{e.caller}</div>}
            {!e.people.length && !e.perEvent.length && !e.caller && <span className="muted">niemand</span>}
          </td>
          <td className="small">In-App{e.rule.value.chat !== 'off' ? ` · Chat ${CHAT_LABEL[e.rule.value.chat]}` : ''}{e.projectChannel ? ' (Projektkanal)' : ''}{e.rule.value.log ? ' · Log' : ''}{e.rule.value.doc ? ' · Doku' : ''}</td>
        </tr>
      ))}
    </tbody></table>
  );
}

/** Meine Einstellungen › Benachrichtigungen: eigene Regeln für alle Projekte oder ein Projekt (nur Chat und Mail), Projekt stummschalten. */
export function MyNotifyCard() {
  const projects = useData<{ projects: Project[] }>('/projects');
  const [projectId, setProjectId] = useState('');
  const url = `/me/notification-rules${projectId ? `?projectId=${projectId}` : ''}`;
  const d = useData<RulesListing & { level: Level }>(url, [url]);
  const { busy, error, run } = useAsync();
  const save = (rules: RuleItem[]) => run(async () => d.setData(await api.put<RulesListing & { level: Level }>(url, { rules })));
  const star = d.data?.rules.find((r) => r.event === '*');
  const muted = Boolean(projectId && star?.channels.mail === 'off' && star?.channels.chat === 'off');
  const list = (projects.data?.projects ?? []).filter((p) => p.status === 'active');
  return (
    <div className="card full">
      <div className="row between"><h2 style={{ margin: 0 }}>Benachrichtigungen</h2>
        <select aria-label="Geltungsbereich" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>
          <option value="">alle Projekte</option>
          {list.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
        </select>
      </div>
      <p className="muted small">In der App erscheint jede Meldung. Hier legst du fest, was zusätzlich per Mail (sofort oder im Tages-Digest) und als Systembeitrag im Chat kommt; für ein Projekt kannst du abweichen. Was die Org oder die PL sperrt (🔒), gilt trotzdem. Zwischenstände einzelner Arbeitspakete wählst du im Arbeitspaket (Berichtswunsch).</p>
      {projectId && <div className="row mb small">
        {muted ? <><span className="badge warn">stummgeschaltet</span><button className="btn sm" disabled={busy} onClick={() => void save([{ event: '*' }])}>Stummschaltung aufheben</button></>
          : <button className="btn sm" disabled={busy} title="Für dieses Projekt keine Mails und keine Chat-Beiträge mehr, nur noch In-App (Sperren der Org oder PL gelten weiter)" onClick={() => void save([{ event: '*', channels: { mail: 'off', chat: 'off' } }])}>Projekt stummschalten</button>}
      </div>}
      {error && <div className="error mb">{error}</div>}
      {d.data && <RulesMatrix level={projectId ? 'user_project' : 'user'} data={d.data} canEdit={!busy} onSave={save} />}
    </div>
  );
}

interface TaskRules extends RulesListing { canEdit: boolean; canEditProgress: boolean; mine: NotificationRule[]; myEffective: EffectiveNotifyRule }

/**
 * Berichtswunsch am AP: Zwischenstände für mich (Ebene Benutzer am AP, der spezifischste Wunsch gewinnt) und als PL bzw.
 * zuständige Person für das AP (Empfänger und Häufigkeit).
 */
export function ReportWish({ taskId }: { taskId: string }) {
  const d = useData<TaskRules>(`/tasks/${taskId}/notification-rules`, [taskId]);
  const { busy, error, run } = useAsync();
  if (!d.data) return null;
  const mine = d.data.mine.find((r) => r.event === 'progress');
  const ap = d.data.rules.find((r) => r.event === 'progress');
  const eff = d.data.effective.find((e) => e.event === 'progress')!;
  const setMine = (every: string, mail: string) => run(async () => {
    await api.put(`/me/notification-rules?taskId=${taskId}`, { rules: [every ? { event: 'progress', channels: { mail }, timing: { every } } : { event: 'progress' }] });
    await d.reload();
  });
  const recipients = ap?.recipients ?? eff.value.recipients;
  const setAp = (list: string[] | null, every: string | undefined) => run(async () => {
    await api.put(`/tasks/${taskId}/notification-rules`, { rules: [{ event: 'progress', recipients: list, channels: ap?.channels ?? {}, timing: every ? { every } : {} }] });
    await d.reload();
  });
  const toggle = (role: string, on: boolean) => setAp(on ? [...recipients.filter((r) => r !== role), role] : recipients.filter((r) => r !== role), ap?.timing.every);
  return (
    <>
      <h3 className="mt">Berichtswunsch</h3>
      <div className="form cols-2">
        <label className="field"><span>Zwischenstände für mich</span>
          <select aria-label="Zwischenstände für mich" value={mine?.timing.every ?? ''} disabled={busy} onChange={(e) => void setMine(e.target.value, mine?.channels.mail ?? 'now')}>
            <option value="">kein eigener Wunsch</option>
            {(Object.keys(EVERY_LABEL) as NotifyEvery[]).map((k) => <option key={k} value={k}>{EVERY_LABEL[k]}</option>)}
          </select></label>
        {mine && <label className="field"><span>per Mail</span>
          <select aria-label="Zwischenstände per Mail" value={mine.channels.mail ?? 'now'} disabled={busy} onChange={(e) => void setMine(mine.timing.every ?? 'milestones', e.target.value)}>
            {(['now', 'digest', 'off'] as NotifyMail[]).map((k) => <option key={k} value={k}>{MAIL_LABEL[k]}</option>)}
          </select></label>}
        {d.data.canEditProgress && <>
          <div className="field"><span>Für das AP an</span><span className="row small" style={{ flexWrap: 'wrap' }}>
            {[['responsible', 'Zuständige(r)'], ['pl', 'verantwortliche PL'], ['requester', 'Auftraggeber']].map(([k, l]) => <label key={k} className="check"><input type="checkbox" disabled={busy} checked={recipients.includes(k)} onChange={(e) => void toggle(k, e.target.checked)} /> {l}</label>)}
          </span></div>
          <label className="field"><span>Häufigkeit am AP</span>
            <EverySelect value={ap?.timing.every} inheritedText={`erbt: ${EVERY_LABEL[eff.value.every ?? 'milestones']} (${NOTIFY_LEVEL_LABEL[eff.origin.every ?? 'code']})`} disabled={busy} onChange={(v) => void setAp(ap?.recipients ?? null, v ?? undefined)} /></label>
        </>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>Zwischenstände schreibt das System aus den Läufen des KI-Agenten an diesem AP (ausgeführte Aktionen und Notiz).</p>
      {error && <div className="error small">{error}</div>}
    </>
  );
}

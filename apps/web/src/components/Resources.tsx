import { useEffect, useMemo, useState } from 'react';
import { RESOURCE_KINDS, type Availability, type Group, type Resource, type ResourceBooking, type ResourceKind } from '@projekttool/shared';
import { api, ApiError, fmtDate, fmtDateTime, today } from '../lib/api';
import { Modal, useAsync, useDialog } from './ui';
import { useData } from '../lib/useData';

/**
 * Ressourcen und Personen im Kalender (Konzept 10): Buchungsformular mit Verfügbarkeitsampel und Konfliktbehandlung (409 → vorläufig
 * anfragen oder, mit Planrecht, übersteuern), Modus „Belegung“ (Zeilen je Ressource oder Person, Spalten je Tag), Ressourcenliste
 * (Pool und Projekt) und Abwesenheiten der eigenen Person.
 */
export const kindLabel = (k: ResourceKind | string | null | undefined) => RESOURCE_KINDS.find((x) => x.key === k)?.label ?? String(k ?? '');
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const localDay = (isoTs: string) => iso(new Date(isoTs));
/** letzter Tag einer Belegung (Ende exklusiv bei ganztägigen) */
const lastDay = (b: ResourceBooking) => iso(new Date(new Date(b.endsAt).getTime() - (b.allDay ? 1 : 0)));
export const spanText = (b: ResourceBooking) => b.allDay ? (localDay(b.startsAt) === lastDay(b) ? fmtDate(b.startsAt) : `${fmtDate(b.startsAt)} – ${fmtDate(new Date(new Date(b.endsAt).getTime() - 1).toISOString())}`) : `${fmtDateTime(b.startsAt)} – ${new Date(b.endsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
export const bookingTitle = (b: ResourceBooking) => b.masked ? b.title ?? 'belegt' : `${b.title ?? b.taskTitle ?? (b.kind === 'absence' ? 'Abwesenheit' : b.kind === 'block' ? 'Sperrzeit' : 'Belegung')}${b.taskRef ? ` · ${b.taskRef}` : ''}`;

export type BookingTarget = { resourceId: string; name: string } | { userId: string; name: string };
export interface BookingFormProps {
  projectId: string | null;
  /** feste Ressource bzw. Person oder Auswahl aus diesen Listen */
  target?: BookingTarget | null;
  resources?: Resource[];
  persons?: { id: string; name: string }[];
  taskId?: string | null;
  /** Vorgabe aus dem Arbeitspaket (ganztägig, folgt dem AP) */
  taskDates?: { startDate: string | null; dueDate: string | null } | null;
  canForce?: boolean;
  /** Sperrzeit (ohne Projekt) bzw. Abwesenheit */
  mode?: 'booking' | 'block' | 'absence';
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}
export function BookingForm(p: BookingFormProps) {
  const [t, setT] = useState<string>(p.target ? ('resourceId' in p.target ? `r:${p.target.resourceId}` : `u:${p.target.userId}`) : '');
  const [allDay, setAllDay] = useState(p.mode === 'absence' || Boolean(p.taskId));
  const [startDate, setStartDate] = useState(p.taskDates?.startDate ?? p.taskDates?.dueDate ?? today());
  const [dueDate, setDueDate] = useState(p.taskDates?.dueDate ?? p.taskDates?.startDate ?? today());
  const [startsAt, setStartsAt] = useState(() => { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return `${iso(d)}T${String(d.getHours()).padStart(2, '0')}:00`; });
  const [endsAt, setEndsAt] = useState(() => { const d = new Date(); d.setHours(d.getHours() + 2, 0, 0, 0); return `${iso(d)}T${String(d.getHours()).padStart(2, '0')}:00`; });
  const [title, setTitle] = useState(p.mode === 'absence' ? 'Abwesenheit' : p.mode === 'block' ? 'Sperrzeit' : '');
  const [note, setNote] = useState('');
  const [tentative, setTentative] = useState(false);
  const [followTask, setFollowTask] = useState(Boolean(p.taskId && p.taskDates && (p.taskDates.startDate || p.taskDates.dueDate)));
  const [conflicts, setConflicts] = useState<ResourceBooking[] | null>(null);
  const [warnings, setWarnings] = useState<ResourceBooking[]>([]);
  const [avail, setAvail] = useState<Availability | null>(null);
  const { busy, error, run } = useAsync();
  const timeBody = allDay ? { startDate, dueDate } : { startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() };
  const targetBody = t.startsWith('r:') ? { resourceId: t.slice(2) } : t.startsWith('u:') ? { userId: t.slice(2) } : {};
  // Ampel: Verfügbarkeit des Ziels im gewählten Zeitraum
  useEffect(() => {
    if (!t || p.mode === 'absence') { setAvail(null); return; }
    const s = allDay ? new Date(`${startDate}T00:00`) : new Date(startsAt); const e = allDay ? addDays(new Date(`${dueDate}T00:00`), 1) : new Date(endsAt);
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) { setAvail(null); return; }
    const q = `${t.startsWith('r:') ? `resourceId=${t.slice(2)}` : `userId=${t.slice(2)}`}&startsAt=${s.toISOString()}&endsAt=${e.toISOString()}`;
    let alive = true;
    api.get<Availability>(`/availability?${q}`).then((a) => { if (alive) setAvail(a); }).catch(() => { if (alive) setAvail(null); });
    return () => { alive = false; };
  }, [t, allDay, startDate, dueDate, startsAt, endsAt, p.mode]);
  const save = (force = false, asTentative = tentative) => run(async () => {
    setConflicts(null);
    try {
      if (p.mode === 'absence') await api.post('/absences', { ...timeBody, title, note });
      else if (p.mode === 'block') await api.post(`/resources/${t.slice(2)}/blocks`, { ...timeBody, title, note });
      else {
        const r = await api.post<{ warnings: ResourceBooking[]; requested: boolean }>(`/projects/${p.projectId}/bookings`, { ...targetBody, ...timeBody, title, note, taskId: p.taskId ?? null, followTask: allDay && followTask, tentative: asTentative, force });
        if (r.warnings.length && !force) setWarnings(r.warnings);
      }
      await p.onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { const c = (e as any).conflicts ?? null; setConflicts(c ?? []); return; }
      throw e;
    }
  });
  const ampel = avail ? { free: ['ok', 'frei'], tentative: ['warn', 'vorläufig belegt'], busy: ['danger', 'belegt'] }[avail.status] : null;
  return (
    <Modal title={p.mode === 'absence' ? 'Abwesenheit eintragen' : p.mode === 'block' ? 'Sperrzeit setzen' : 'Buchen'} onClose={p.onClose}>
      <div className="form">
        {p.mode !== 'absence' && !p.target && <label className="field"><span>Ressource oder Person</span>
          <select value={t} onChange={(e) => setT(e.target.value)}>
            <option value="">bitte wählen</option>
            {(p.resources ?? []).map((r) => <option key={r.id} value={`r:${r.id}`}>{r.name} ({kindLabel(r.kind)}{r.projectId ? '' : ', Pool'})</option>)}
            {(p.persons ?? []).length > 0 && <optgroup label="Personen">{(p.persons ?? []).map((u) => <option key={u.id} value={`u:${u.id}`}>{u.name}</option>)}</optgroup>}
          </select></label>}
        {p.target && <div className="field"><span>{'resourceId' in p.target ? 'Ressource' : 'Person'}</span><strong>{p.target.name}</strong></div>}
        <label className="check"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> ganztägig</label>
        {allDay ? <div className="row"><label className="field"><span>Von</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label><label className="field"><span>Bis (einschließlich)</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label></div>
          : <div className="row"><label className="field"><span>Beginn</span><input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></label><label className="field"><span>Ende</span><input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></label></div>}
        {p.taskId && allDay && <label className="check" title="Die Belegung folgt Start und Termin des Arbeitspakets, wenn sie verschoben werden"><input type="checkbox" checked={followTask} onChange={(e) => setFollowTask(e.target.checked)} /> folgt dem Arbeitspaket</label>}
        <label className="field"><span>Titel</span><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={p.taskId ? 'leer = Titel des Arbeitspakets' : 'z. B. Fassade einrüsten'} /></label>
        <label className="field"><span>Notiz</span><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {p.mode !== 'absence' && p.mode !== 'block' && <label className="check" title="Vorläufige Belegungen dürfen sich überschneiden und werden später bestätigt"><input type="checkbox" checked={tentative} onChange={(e) => setTentative(e.target.checked)} /> vorläufig</label>}
        {ampel && <div className="small row" style={{ gap: 6 }}><span className={`badge ${ampel[0]}`}>{ampel[1]}</span>{avail!.conflicts.length > 0 && <span className="muted">{avail!.conflicts.map((c) => `${bookingTitle(c)} ${spanText(c)}`).join('; ')}</span>}</div>}
        {conflicts && <div className="notice small">
          <strong>Belegt:</strong> {conflicts.map((c) => `${bookingTitle(c)} ${spanText(c)}`).join('; ') || 'bestätigte Überschneidung'}.
          <div className="row mt" style={{ gap: 6 }}>
            <button className="btn sm" disabled={busy} onClick={() => void save(false, true)}>Trotzdem vorläufig anfragen</button>
            {p.canForce && <button className="btn sm danger" disabled={busy} onClick={() => void save(true, false)} title="Nur PL oder „Projektplan ändern“; wird festgehalten und den Betroffenen gemeldet">Übersteuern</button>}
          </div>
        </div>}
        {warnings.length > 0 && <div className="muted small">Hinweis: überschneidet sich mit vorläufigen Belegungen ({warnings.map((c) => `${bookingTitle(c)} ${spanText(c)}`).join('; ')}).</div>}
        {error && <div className="error small">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || (p.mode !== 'absence' && !t)} onClick={() => void save()}>{p.mode === 'absence' ? 'Eintragen' : p.mode === 'block' ? 'Sperren' : 'Buchen'}</button><button className="btn" onClick={p.onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

/** Modus „Belegung“: Zeilen je Ressource oder Person, Spalten je Tag (14 Tage); vorläufig gestrichelt, Konflikt rot, maskiert grau. */
export function Occupancy({ bookings, rows, start, onPick, onBook }: { bookings: ResourceBooking[]; rows: { key: string; label: string; kind?: string; match: (b: ResourceBooking) => boolean }[]; start?: string | null; onPick?: (b: ResourceBooking) => void; onBook?: (row: { key: string; label: string }) => void }) {
  const [cursor, setCursor] = useState(() => { const d = start ? new Date(`${start}T00:00`) : new Date(); d.setHours(0, 0, 0, 0); return addDays(d, -((d.getDay() + 6) % 7)); });
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(cursor, i)), [cursor]);
  const t = today();
  const cell = (row: { match: (b: ResourceBooking) => boolean }, day: string) => bookings.filter((b) => row.match(b) && localDay(b.startsAt) <= day && lastDay(b) >= day);
  return (
    <div className="occupancy">
      <div className="row mb">
        <button className="btn sm" onClick={() => setCursor(addDays(cursor, -7))}>‹</button>
        <strong>{fmtDate(iso(days[0]))} – {fmtDate(iso(days[13]))}</strong>
        <button className="btn sm" onClick={() => setCursor(addDays(cursor, 7))}>›</button>
        <button className="btn sm" onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setCursor(addDays(d, -((d.getDay() + 6) % 7))); }}>Heute</button>
        <span className="muted small">vorläufig gestrichelt · Konflikt rot · fremde Projekte nur „belegt“</span>
      </div>
      <div className="occ-grid" style={{ gridTemplateColumns: `180px repeat(14, minmax(0, 1fr))` }}>
        <div className="hd" />
        {days.map((d) => <div key={iso(d)} className={`hd ${iso(d) === t ? 'today' : ''} ${d.getDay() === 0 || d.getDay() === 6 ? 'we' : ''}`}>{d.toLocaleDateString('de-DE', { weekday: 'short' })} {d.getDate()}.</div>)}
        {rows.length === 0 && <div className="empty" style={{ gridColumn: '1 / -1' }}>Keine Ressourcen oder Personen zum Anzeigen.</div>}
        {rows.map((r) => <>
          <div key={`${r.key}-l`} className="rl"><span title={r.kind ? kindLabel(r.kind) : undefined}>{r.label}</span>{onBook && <button className="btn sm link" title="Buchen" onClick={() => onBook(r)}>+</button>}</div>
          {days.map((d) => { const k = iso(d); const bs = cell(r, k); return (
            <div key={`${r.key}-${k}`} className={`c ${k === t ? 'today' : ''} ${d.getDay() === 0 || d.getDay() === 6 ? 'we' : ''}`}>
              {bs.map((b) => <span key={b.id} className={`bk ${b.tentative ? 'tent' : ''} ${b.conflict ? 'conf' : ''} ${b.masked ? 'mask' : ''} ${b.kind}`} title={`${bookingTitle(b)} · ${spanText(b)}${b.projectKey ? ` · ${b.projectKey}` : ''}${b.tentative ? ' · vorläufig' : ''}${b.conflict ? ' · Konflikt' : ''}`} onClick={() => onPick?.(b)}>{b.allDay ? '' : `${new Date(b.startsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} `}{bookingTitle(b)}</span>)}
            </div>
          ); })}
        </>)}
      </div>
    </div>
  );
}

/** Zeile einer Belegung mit Aktionen (bestätigen, ablehnen, löschen). */
export function BookingRow({ b, canDecide, canDelete, onChanged }: { b: ResourceBooking; canDecide: boolean; canDelete: boolean; onChanged: () => void | Promise<void> }) {
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const decide = (decision: 'confirm' | 'decline') => run(async () => { await api.post(`/bookings/${b.id}/decide`, { decision }); await onChanged(); });
  return <li>
    <strong>{b.resourceName ?? b.userName}</strong> {spanText(b)} <span className="muted">· {bookingTitle(b)}{b.createdByName ? ` · von ${b.createdByName}` : ''}</span>
    {b.tentative && <span className="badge warn" style={{ marginLeft: 4 }}>vorläufig</span>}{b.conflict && <span className="badge danger" style={{ marginLeft: 4 }} title="überschneidet sich mit einer anderen Belegung">Konflikt</span>}{b.followTask && <span className="badge" style={{ marginLeft: 4 }} title="folgt Start und Termin des Arbeitspakets">folgt AP</span>}
    {(canDecide && b.tentative) || canDelete ? <span className="row" style={{ gap: 4, display: 'inline-flex', marginLeft: 6 }}>
      {canDecide && b.tentative && <><button className="btn sm" disabled={busy} onClick={() => void decide('confirm')}>Bestätigen</button><button className="btn sm" disabled={busy} onClick={() => void decide('decline')}>Ablehnen</button></>}
      {canDelete && !b.tentative && <button className="btn sm link" disabled={busy} onClick={() => void dialog.confirm({ title: 'Belegung löschen', text: `${b.resourceName ?? b.userName} ${spanText(b)} löschen?`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/bookings/${b.id}`); await onChanged(); }); })}>✕</button>}
    </span> : null}
    {error && <div className="error small">{error}</div>}
  </li>;
}

/** Ressourcenliste (Pool oder Projekt): anlegen, ändern, deaktivieren oder löschen; im Pool mit Freigabegruppe und Sperrzeiten. */
export function ResourcesTable({ projectId, canEdit, canDelete, groups }: { projectId: string | null; canEdit: boolean; canDelete: boolean; groups?: Group[] }) {
  const d = useData<{ resources: Resource[] }>(`/resources?${projectId ? `projectId=${projectId}&` : ''}all=1`, [projectId]);
  const list = (d.data?.resources ?? []).filter((r) => (projectId ? r.projectId === projectId : r.projectId === null));
  const empty = { kind: 'room' as ResourceKind, name: '', location: '', email: '', trade: '', organization: '', approvalGroupId: '' };
  const [f, setF] = useState(empty);
  const [block, setBlock] = useState<Resource | null>(null);
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const save = (r: Resource, body: Record<string, unknown>) => run(async () => { await api.patch(`/resources/${r.id}`, body); await d.reload(); });
  return <div>
    {error && <div className="error mb">{error}</div>}
    <table className="table"><thead><tr><th>Name</th><th>Art</th><th>Ort / Kontakt</th>{!projectId && <th>Freigabegruppe</th>}<th>Belegungen</th><th /></tr></thead><tbody>
      {list.map((r) => <tr key={r.id} style={r.active ? undefined : { opacity: 0.6 }}>
        <td>{r.name}{!r.active && <span className="badge" style={{ marginLeft: 4 }}>inaktiv</span>}{r.trade && <div className="muted small">{r.trade}{r.organization ? ` · ${r.organization}` : ''}</div>}</td>
        <td className="small">{kindLabel(r.kind)}</td>
        <td className="small">{r.location}{r.email && <div><a href={`mailto:${r.email}`}>{r.email}</a></div>}</td>
        {!projectId && <td className="small">{canEdit ? <select value={r.approvalGroupId ?? ''} style={{ width: 'auto' }} onChange={(e) => void save(r, { approvalGroupId: e.target.value || null })}><option value="">keine (jedes Mitglied bestätigt)</option>{(groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select> : r.approvalGroupName ?? '–'}</td>}
        <td className="small">{r.futureBookings ?? 0} künftig</td>
        <td className="nowrap">{canEdit && <>
          <button className="btn sm" title="Sperrzeit setzen" onClick={() => setBlock(r)}>Sperrzeit</button>
          <button className="btn sm" onClick={() => void save(r, { active: !r.active })}>{r.active ? 'Deaktivieren' : 'Aktivieren'}</button>
          {canDelete && <button className="btn sm link" title="Löschen (mit künftigen Belegungen nur deaktivieren)" onClick={() => void dialog.confirm({ title: 'Ressource löschen', text: `„${r.name}“ löschen? Mit künftigen Belegungen wird sie nur deaktiviert.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/resources/${r.id}`); await d.reload(); }); })}>✕</button>}
        </>}</td>
      </tr>)}
      {d.data && list.length === 0 && <tr><td colSpan={6} className="muted small">Noch keine Ressourcen.</td></tr>}
    </tbody></table>
    {canEdit && <form className="row mt" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.post('/resources', { ...f, projectId, approvalGroupId: f.approvalGroupId || null }); setF(empty); await d.reload(); }); }}>
      <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as ResourceKind })} style={{ width: 'auto' }}>{RESOURCE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select>
      <input type="text" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ width: 180 }} required />
      <input type="text" placeholder={f.kind === 'person' ? 'Gewerk' : 'Ort'} value={f.kind === 'person' ? f.trade : f.location} onChange={(e) => setF(f.kind === 'person' ? { ...f, trade: e.target.value } : { ...f, location: e.target.value })} style={{ width: 140 }} />
      <input type="email" placeholder={f.kind === 'person' ? 'E-Mail der Person' : 'Postfach (optional)'} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={{ width: 200 }} />
      {f.kind === 'person' && <input type="text" placeholder="Firma" value={f.organization} onChange={(e) => setF({ ...f, organization: e.target.value })} style={{ width: 140 }} />}
      {!projectId && (groups ?? []).length > 0 && <select value={f.approvalGroupId} onChange={(e) => setF({ ...f, approvalGroupId: e.target.value })} style={{ width: 'auto' }}><option value="">ohne Freigabegruppe</option>{(groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}
      <button className="btn sm" disabled={busy || !f.name.trim()}>Anlegen</button>
    </form>}
    {block && <BookingForm projectId={null} mode="block" target={{ resourceId: block.id, name: block.name }} onClose={() => setBlock(null)} onSaved={async () => { setBlock(null); await d.reload(); }} />}
  </div>;
}

/** Abwesenheiten der eigenen Person (Urlaub, Schulung): zählen als Belegt-Zeit; andere sehen nur „abwesend“. */
export function AbsencesCard() {
  const d = useData<{ absences: ResourceBooking[] }>('/me/absences');
  const [add, setAdd] = useState(false);
  const { error, run } = useAsync();
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>Abwesenheiten</h2><button className="btn sm" onClick={() => setAdd(true)}>+ Abwesenheit</button></div>
      <p className="muted small">Urlaub, Schulung, Krankheit: zählt als belegt, wenn jemand dich einplant oder ein Agent Termine vorschlägt. Andere sehen nur „abwesend“.</p>
      <ul className="small">{(d.data?.absences ?? []).map((a) => <li key={a.id}>{spanText(a)} · {a.title ?? 'Abwesenheit'} <button className="btn sm link" onClick={() => void run(async () => { await api.del(`/bookings/${a.id}`); await d.reload(); })}>✕</button></li>)}</ul>
      {d.data && d.data.absences.length === 0 && <div className="muted small">Keine Abwesenheiten eingetragen.</div>}
      {error && <div className="error small">{error}</div>}
      {add && <BookingForm projectId={null} mode="absence" onClose={() => setAdd(false)} onSaved={async () => { setAdd(false); await d.reload(); }} />}
    </div>
  );
}

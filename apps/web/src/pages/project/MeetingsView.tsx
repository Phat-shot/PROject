import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DocPage, Meeting, MeetingAttendee } from '@projekttool/shared';
import { api, fmtDateTime, today } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync, useDialog } from '../../components/ui';
import { useProject } from '../ProjectPage';

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const toLocalInput = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

/**
 * Besprechungen: Termin ↔ Protokoll ↔ Arbeitspakete. Teilnehmer aus Mitgliedern und Kontakten, Einladung per ICS
 * über das Projektkonto, Protokollseite aus der Vorlage der Reihe, Aktionspunkte direkt als Arbeitspakete.
 */
export function MeetingsView() {
  const { detail, reloadTasks } = useProject();
  const pid = detail.project.id;
  const base = `/projekte/${pid}`;
  const d = useData<{ meetings: Meeting[] }>(`/projects/${pid}/meetings`);
  const docs = useData<{ pages: DocPage[] }>(`/projects/${pid}/docs`);
  const [edit, setEdit] = useState<Meeting | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const nav = useNavigate();
  const now = new Date().toISOString();
  const list = d.data?.meetings ?? [];
  const upcoming = list.filter((m) => m.endsAt >= now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = list.filter((m) => m.endsAt < now);
  const series = (docs.data?.pages ?? []).filter((p) => p.settings?.kind === 'series');
  const isPl = detail.project.myMembership.role === 'pl';
  const refresh = async () => { await d.reload(); };
  const protocol = (m: Meeting) => run(async () => { const r = await api.post<{ page: { id: string } }>(`/meetings/${m.id}/protocol`); nav(`${base}/doku/${r.page.id}`); });
  const invite = (m: Meeting) => void dialog.confirm({ title: 'Einladung senden', text: `Einladung mit Kalendereintrag an ${m.attendees.length} Teilnehmer über das Projektkonto senden?${m.inviteSentAt ? ' Eine Aktualisierung ersetzt den bisherigen Eintrag.' : ''}`, confirmLabel: 'Senden' }).then((ok) => { if (ok) void run(async () => { await api.post(`/meetings/${m.id}/invite`); await refresh(); }); });
  const Row = ({ m }: { m: Meeting }) => (
    <div className={`meeting ${open === m.id ? 'open' : ''}`}>
      <div className="row between" onClick={() => setOpen(open === m.id ? null : m.id)} style={{ cursor: 'pointer' }}>
        <div><strong>{m.title}</strong>{m.seriesPageTitle && <span className="badge" style={{ marginLeft: 6 }}>{m.seriesPageTitle}</span>}<div className="muted small">{fmtDateTime(m.startsAt)} – {fmtTime(m.endsAt)}{m.location ? ` · ${m.location}` : ''} · {m.attendees.length} Teilnehmer{m.tasks.length ? ` · ${m.tasks.filter((t) => !t.done).length}/${m.tasks.length} Aktionspunkte offen` : ''}</div></div>
        <div className="row small">{m.pageId ? <Link className="badge ok" to={`${base}/doku/${m.pageId}`} onClick={(e) => e.stopPropagation()}>Protokoll</Link> : <span className="badge">kein Protokoll</span>}{m.inviteSentAt && <span className="badge" title={`gesendet ${fmtDateTime(m.inviteSentAt)}`}>eingeladen</span>}</div>
      </div>
      {open === m.id && (
        <div className="mt">
          {m.description && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{m.description}</p>}
          <div className="small"><span className="muted">Teilnehmer:</span> {m.attendees.length ? m.attendees.map((a) => <span key={a.email} className="badge" style={{ marginRight: 4 }} title={a.email}>{a.name ?? a.email}{!a.userId && ' (extern)'}</span>) : '–'}</div>
          <div className="row mt">
            <button className="btn sm primary" disabled={busy} onClick={() => void protocol(m)}>{m.pageId ? 'Protokoll öffnen' : 'Protokoll anlegen'}</button>
            <button className="btn sm" disabled={busy || !m.attendees.length} onClick={() => invite(m)}>{m.inviteSentAt ? 'Einladung aktualisieren' : 'Einladung senden (ICS)'}</button>
            <a className="btn sm" href={`/api/meetings/${m.id}/ics`}>In meinen Kalender (ICS)</a>
            {(isPl || m.createdBy === detail.project.myMembership.userId) && <><button className="btn sm" onClick={() => setEdit(m)}>Bearbeiten</button><button className="btn sm danger" onClick={() => void dialog.confirm({ title: 'Besprechung löschen', text: `„${m.title}“ löschen? Protokoll und Arbeitspakete bleiben.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/meetings/${m.id}`); setOpen(null); await refresh(); }); })}>Löschen</button></>}
          </div>
          <ActionItems m={m} onChanged={async () => { await refresh(); await reloadTasks(); }} />
        </div>
      )}
    </div>
  );
  return (
    <div className="content">
      <div className="row mb">
        <button className="btn primary" onClick={() => setEdit('new')}>Besprechung anlegen</button>
        <span className="muted small">Termin, Teilnehmer und Protokoll an einem Ort. Einladungen gehen mit Kalendereintrag über das Projektkonto, Aktionspunkte werden Arbeitspakete.</span>
        <Link className="btn sm right" to={`${base}/kalender`}>Kalender</Link>
      </div>
      {error && <div className="error mb">{error}</div>}
      <div className="card mb">
        <h2>Anstehend</h2>
        {d.data && upcoming.length === 0 && <div className="empty">Keine anstehenden Besprechungen.</div>}
        {upcoming.map((m) => <Row key={m.id} m={m} />)}
      </div>
      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>Vergangen <span className="muted small" style={{ fontWeight: 400 }}>{past.length}</span></h2>{past.length > 0 && <button className="btn sm" onClick={() => setShowPast(!showPast)}>{showPast ? 'Ausblenden' : 'Anzeigen'}</button>}</div>
        {showPast && past.map((m) => <Row key={m.id} m={m} />)}
      </div>
      {edit && <MeetingForm existing={edit === 'new' ? undefined : edit} series={series} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await refresh(); }} />}
    </div>
  );
}

function ActionItems({ m, onChanged }: { m: Meeting; onChanged: () => Promise<void> }) {
  const { detail, tasks, openTask } = useProject();
  const [title, setTitle] = useState('');
  const [resp, setResp] = useState('');
  const [due, setDue] = useState('');
  const [link, setLink] = useState('');
  const { busy, error, run } = useAsync();
  const members = detail.members;
  const linkable = tasks.filter((t) => !t.done && !m.tasks.some((x) => x.id === t.id));
  return (
    <div className="mt">
      <div className="small"><span className="muted">Aktionspunkte / Arbeitspakete:</span></div>
      {m.tasks.length > 0 && <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>{m.tasks.map((t) => <li key={t.id}><button className="btn sm link" onClick={() => openTask(t.id)}>{t.number ? `${detail.project.key}-${t.number} ` : ''}{t.title}</button>{t.done && <span className="badge ok" style={{ marginLeft: 4 }}>erledigt</span>} <button className="btn sm link" title="Verknüpfung lösen" onClick={() => void run(async () => { await api.del(`/meetings/${m.id}/tasks/${t.id}`); await onChanged(); })}>×</button></li>)}</ul>}
      {error && <div className="error small">{error}</div>}
      <form className="row small" onSubmit={(e) => { e.preventDefault(); if (!title.trim()) return; void run(async () => { await api.post(`/meetings/${m.id}/tasks`, { title, responsibleUserId: resp || null, dueDate: due || null }); setTitle(''); setDue(''); await onChanged(); }); }}>
        <input type="text" placeholder="Neuer Aktionspunkt …" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <select value={resp} onChange={(e) => setResp(e.target.value)} style={{ width: 'auto' }}><option value="">Zuständig …</option>{members.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}</select>
        <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} style={{ width: 'auto' }} />
        <button className="btn sm primary" disabled={busy || !title.trim()}>Anlegen</button>
      </form>
      {linkable.length > 0 && <div className="row small mt"><select value={link} onChange={(e) => setLink(e.target.value)} style={{ width: 'auto', maxWidth: 320 }}><option value="">Bestehendes Arbeitspaket verknüpfen …</option>{linkable.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select><button className="btn sm" disabled={busy || !link} onClick={() => void run(async () => { await api.post(`/meetings/${m.id}/tasks`, { taskId: link }); setLink(''); await onChanged(); })}>Verknüpfen</button></div>}
    </div>
  );
}

function MeetingForm({ existing, series, onClose, onSaved }: { existing?: Meeting; series: DocPage[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { detail } = useProject();
  const contacts = useData<{ contacts: { email: string; name: string | null }[] }>(`/projects/${detail.project.id}/contacts`);
  const start = existing ? toLocalInput(existing.startsAt) : (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return toLocalInput(d.toISOString()); })();
  const [f, setF] = useState({ title: existing?.title ?? '', startsAt: start, durationMinutes: existing ? Math.round((new Date(existing.endsAt).getTime() - new Date(existing.startsAt).getTime()) / 60000) : 60, location: existing?.location ?? '', description: existing?.description ?? '', seriesPageId: existing?.seriesPageId ?? '' });
  const [attendees, setAttendees] = useState<MeetingAttendee[]>(existing?.attendees ?? []);
  const [extra, setExtra] = useState('');
  const { busy, error, run } = useAsync();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const has = (email: string) => attendees.some((a) => a.email.toLowerCase() === email.toLowerCase());
  const toggle = (a: MeetingAttendee) => setAttendees(has(a.email) ? attendees.filter((x) => x.email.toLowerCase() !== a.email.toLowerCase()) : [...attendees, a]);
  const addExtra = () => { const e = extra.trim().toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !has(e)) setAttendees([...attendees, { email: e }]); setExtra(''); };
  const save = () => run(async () => {
    const startsAt = new Date(f.startsAt).toISOString();
    const body = { title: f.title, startsAt, durationMinutes: Number(f.durationMinutes) || 60, location: f.location, description: f.description, seriesPageId: f.seriesPageId || null, attendees };
    if (existing) await api.patch(`/meetings/${existing.id}`, body); else await api.post(`/projects/${detail.project.id}/meetings`, body);
    await onSaved();
  });
  const sel = useMemo(() => new Set(attendees.map((a) => a.email.toLowerCase())), [attendees]);
  return (
    <Modal title={existing ? 'Besprechung bearbeiten' : 'Besprechung anlegen'} onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Titel</span><input type="text" value={f.title} autoFocus onChange={(e) => set('title', e.target.value)} placeholder="z. B. Jour fixe Auftraggeber" /></label>
        <label className="field"><span>Beginn</span><input type="datetime-local" value={f.startsAt} onChange={(e) => set('startsAt', e.target.value)} /></label>
        <label className="field"><span>Dauer (Minuten)</span><input type="number" min={5} step={5} value={f.durationMinutes} onChange={(e) => set('durationMinutes', Number(e.target.value))} /></label>
        <label className="field"><span>Ort / Link</span><input type="text" value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Raum, Teams-Link …" /></label>
        <label className="field"><span>Besprechungsreihe (Protokoll-Vorlage und Ablage)</span><select value={f.seriesPageId} onChange={(e) => set('seriesPageId', e.target.value)}><option value="">keine (Ordner „Protokolle“)</option>{series.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
        <label className="field full"><span>Agenda / Beschreibung</span><textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
        <div className="field full"><span>Teilnehmer</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{detail.members.map((m) => <button key={m.userId} type="button" className={`chip ${sel.has(m.email.toLowerCase()) ? 'on' : ''}`} onClick={() => toggle({ userId: m.userId, email: m.email, name: m.name })}>{m.name}</button>)}</div>
          {(contacts.data?.contacts.length ?? 0) > 0 && <div className="row mt" style={{ flexWrap: 'wrap', gap: 4 }}><span className="muted small">Kontakte:</span>{contacts.data!.contacts.map((c) => <button key={c.email} type="button" className={`chip ${sel.has(c.email.toLowerCase()) ? 'on' : ''}`} onClick={() => toggle({ email: c.email, name: c.name })}>{c.name ?? c.email}</button>)}</div>}
          <div className="row mt"><input type="email" placeholder="Weitere Adresse …" value={extra} onChange={(e) => setExtra(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } }} style={{ width: 260 }} /><button type="button" className="btn sm" onClick={addExtra}>Hinzufügen</button></div>
          {attendees.filter((a) => !a.userId && !contacts.data?.contacts.some((c) => c.email.toLowerCase() === a.email.toLowerCase())).map((a) => <span key={a.email} className="badge" style={{ marginRight: 4 }}>{a.email} <button type="button" className="btn sm link" onClick={() => toggle(a)}>×</button></span>)}
        </div>
        {error && <div className="error full">{error}</div>}
        <div className="full row"><button className="btn primary" disabled={busy || !f.title.trim() || !f.startsAt} onClick={() => void save()}>{existing ? 'Speichern' : 'Anlegen'}</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

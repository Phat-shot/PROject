import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { MailDetail, MailDraft, MailSummary, MailView as MailViewT, MailAccount, MailViewFilter } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, roleLabel, useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';

type ViewRow = MailViewT & { canManage?: boolean };

export function MailView() {
  const { detail } = useProject();
  const base = `/projekte/${detail.project.id}/mail`;
  const views = useData<{ views: ViewRow[] }>(`/projects/${detail.project.id}/mail/views`);
  const drafts = useData<{ drafts: MailDraft[] }>(`/projects/${detail.project.id}/mail/drafts`);
  const nav = useNavigate();
  const [newView, setNewView] = useState(false);
  const [rightsFor, setRightsFor] = useState<ViewRow | null>(null);
  const pending = (drafts.data?.drafts ?? []).filter((d) => d.status === 'pending_approval');
  const me = detail.project.myMembership;
  return (
    <div className="mail-layout">
      <div className="mail-views">
        <div className="row between mb"><strong>Ansichten</strong>{me.role !== 'reader' && <button className="btn sm" onClick={() => setNewView(true)}>+ Ansicht</button>}</div>
        <Routes>
          <Route path=":viewId?/*" element={<ViewList views={views.data?.views ?? []} base={base} onRights={setRightsFor} />} />
        </Routes>
        <div className="section mt" style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', padding: '10px 10px 4px' }}>Freigabe-Liste</div>
        <div className={`view ${location.pathname.endsWith('/freigaben') ? 'active' : ''}`} onClick={() => nav(`${base}/freigaben`)}>
          <span>Entwürfe und Freigaben {pending.length > 0 && <span className="badge warn">{pending.length}</span>}</span>
        </div>
        {me.role !== 'reader' && <button className="btn primary mt" style={{ width: '100%' }} onClick={() => nav(`${base}/neu`)}>Neue Mail</button>}
      </div>
      <Routes>
        <Route index element={<><div className="mail-list"><div className="empty" style={{ margin: 12 }}>Ansicht wählen</div></div><div className="mail-detail muted">Konten werden angebunden, geteilt werden nur gefilterte Ansichten. Rechte hängen an der Ansicht, nicht an der Projektrolle.</div></>} />
        <Route path="freigaben" element={<><div className="mail-list" /><DraftsPanel drafts={drafts.data?.drafts ?? []} reload={drafts.reload} /></>} />
        <Route path="neu" element={<><div className="mail-list" /><Compose views={views.data?.views ?? []} onDone={() => { void drafts.reload(); nav(`${base}/freigaben`); }} /></>} />
        <Route path="mail/:mailId" element={<MailOnly base={base} />} />
        <Route path=":viewId/:mailId?" element={<ViewMails base={base} views={views.data?.views ?? []} />} />
      </Routes>
      {newView && <NewView onClose={() => setNewView(false)} onCreated={() => { setNewView(false); void views.reload(); }} />}
      {rightsFor && <RightsEditor view={rightsFor} onClose={() => setRightsFor(null)} onChanged={() => void views.reload()} />}
    </div>
  );
}

function ViewList({ views, base, onRights }: { views: ViewRow[]; base: string; onRights: (v: ViewRow) => void }) {
  const { viewId } = useParams();
  const nav = useNavigate();
  return (
    <>
      {views.map((v) => (
        <div key={v.id} className={`view ${viewId === v.id ? 'active' : ''}`} onClick={() => nav(`${base}/${v.id}`)}>
          <span className="row between">{v.name}{v.canManage && <button className="btn sm link" onClick={(e) => { e.stopPropagation(); onRights(v); }}>Rechte</button>}</span>
          <span className="acc">{v.accountAddress} · {v.accountType === 'personal' ? 'persönlich' : 'Projektkonto'}{!v.myRights.canRead && ' · kein Leserecht'}</span>
        </div>
      ))}
      {views.length === 0 && <div className="muted small" style={{ padding: 10 }}>Noch keine Ansichten.</div>}
    </>
  );
}

function ViewMails({ base, views }: { base: string; views: ViewRow[] }) {
  const { viewId, mailId } = useParams();
  const nav = useNavigate();
  const [folder, setFolder] = useState('');
  const list = useData<{ view: MailViewT; mails: MailSummary[] }>(viewId ? `/mail/views/${viewId}/mails${folder ? `?folder=${folder}` : ''}` : null, [folder]);
  const view = views.find((v) => v.id === viewId);
  return (
    <>
      <div className="mail-list">
        <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <select value={folder} onChange={(e) => setFolder(e.target.value)} style={{ width: 'auto' }}><option value="">Alle Ordner</option><option value="INBOX">Posteingang</option><option value="Sent">Gesendet</option></select>
          <span className="muted small right">{list.data?.mails.length ?? 0} Mails</span>
        </div>
        {list.error && <div className="error" style={{ margin: 12 }}>{list.error}</div>}
        {list.data?.mails.map((m) => (
          <div key={m.id} className={`mail-item ${mailId === m.id ? 'active' : ''}`} onClick={() => nav(`${base}/${viewId}/${m.id}`)}>
            <div className="from"><span>{m.folder.toLowerCase() === 'sent' ? `An: ${m.toJson.join(', ')}` : m.fromName ?? m.fromAddr}</span><span className="date">{fmtDateTime(m.date)}</span></div>
            <div className="subject">{m.subject}{m.linkedTaskIds.length > 0 && <span className="badge" style={{ marginLeft: 6 }}>Aufgabe</span>}{m.hasAttachments && ' 📎'}</div>
            <div className="snippet">{m.snippet}</div>
          </div>
        ))}
        {list.data && list.data.mails.length === 0 && <div className="empty" style={{ margin: 12 }}>Keine Mails in dieser Ansicht.</div>}
      </div>
      {mailId ? <MailDetailPanel mailId={mailId} view={view} base={base} onChanged={() => void list.reload()} /> : <div className="mail-detail muted">{view ? <ViewInfo view={view} /> : 'Mail wählen'}</div>}
    </>
  );
}

function ViewInfo({ view }: { view: ViewRow }) {
  const f = view.filter;
  const parts = [f.folders?.length && `Ordner: ${f.folders.join(', ')}`, f.from?.length && `Von: ${f.from.join(', ')}`, f.to?.length && `An: ${f.to.join(', ')}`, f.subject?.length && `Betreff: ${f.subject.join(', ')}`, f.keyword?.length && `Stichwort: ${f.keyword.join(', ')}`, f.since && `ab ${f.since}`].filter(Boolean);
  const r = view.myRights;
  return (
    <div>
      <h2>{view.name}</h2>
      <p>Konto {view.accountAddress} ({view.accountType === 'personal' ? 'persönlich' : 'Projektkonto'})</p>
      <p>Filter: {parts.length ? parts.join(' · ') : 'alle Mails des Kontos'}</p>
      <p>Meine Rechte: {[r.canRead && 'Lesen', r.canDraft && 'Entwurf', r.canSend && 'Senden', r.canCreateTask && 'Aufgabe erzeugen', r.canAi && 'KI'].filter(Boolean).join(', ') || 'keine'}</p>
      <p className="small">Gespeichert werden nur Treffer dieser Ansicht; Filter laufen beim Anbieter.</p>
    </div>
  );
}

function MailOnly({ base }: { base: string }) {
  const { mailId } = useParams();
  return <><div className="mail-list" /><MailDetailPanel mailId={mailId!} base={base} onChanged={() => undefined} /></>;
}

function MailDetailPanel({ mailId, view, base, onChanged }: { mailId: string; view?: ViewRow; base: string; onChanged: () => void }) {
  const { detail, tasks, reloadTasks, openTask } = useProject();
  const d = useData<{ mail: MailDetail; rights: MailViewT['myRights']; links: { taskId: string; title: string; copied: boolean }[] }>(`/mail/mails/${mailId}`);
  const [link, setLink] = useState(false);
  const [confirmCopy, setConfirmCopy] = useState<{ taskId: string; willSee: { name: string; role: string }[] } | null>(null);
  const [createTask, setCreateTask] = useState(false);
  const nav = useNavigate();
  const { error, run } = useAsync();
  if (d.error) return <div className="mail-detail"><div className="error">{d.error}</div><p className="muted mt">Verknüpfte Mail, keine Berechtigung: Du darfst die Ansicht nicht lesen, aus der diese Mail stammt.</p></div>;
  if (!d.data) return <div className="mail-detail muted">Lade …</div>;
  const m = d.data.mail;
  const r = d.data.rights;
  const doLink = async (taskId: string, copy: boolean, confirmed = false) => {
    await run(async () => {
      const res = await api.post<{ needsConfirmation?: boolean; willSee?: { name: string; role: string }[] }>(`/mail/mails/${m.id}/link`, { taskId, copy, confirmed });
      if (res.needsConfirmation) { setConfirmCopy({ taskId, willSee: res.willSee ?? [] }); return; }
      setConfirmCopy(null); setLink(false); await d.reload(); await reloadTasks(); onChanged();
    });
  };
  return (
    <div className="mail-detail">
      <h2>{m.subject}</h2>
      <div className="hdr">
        <div><strong>Von:</strong> {m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr}</div>
        <div><strong>An:</strong> {m.toJson.join(', ')}</div>
        {m.ccJson.length > 0 && <div><strong>Cc:</strong> {m.ccJson.join(', ')}</div>}
        <div><strong>Datum:</strong> {fmtDateTime(m.date)} · Ordner {m.folder}</div>
      </div>
      <div className="row mb">
        {(r.canDraft || r.canSend) && view && <Link className="btn sm" to={`${base}/neu?reply=${m.id}&view=${view.id}`}>Antworten</Link>}
        {r.canCreateTask && <><button className="btn sm" onClick={() => setCreateTask(true)}>Aufgabe erstellen</button><button className="btn sm" onClick={() => setLink(true)}>Mit Aufgabe verknüpfen</button></>}
      </div>
      {d.data.links.length > 0 && <p className="small">Verknüpft mit: {d.data.links.map((l) => <button key={l.taskId} className="btn sm link" onClick={() => openTask(l.taskId)}>{l.title}{l.copied ? ' (Kopie)' : ''}</button>)}</p>}
      {error && <div className="error mb">{error}</div>}
      {m.textBody ? <pre>{m.textBody}</pre> : m.htmlBody ? <div className="prose" dangerouslySetInnerHTML={{ __html: m.htmlBody.replace(/<script[\s\S]*?<\/script>/gi, '') }} /> : <p className="muted">Kein Inhalt</p>}
      {link && (
        <Modal title="Mit Aufgabe verknüpfen" onClose={() => setLink(false)}>
          <p className="small muted">Verknüpfen: Wer die Ansicht nicht lesen darf, sieht nur „verknüpfte Mail, keine Berechtigung“. Kopieren: Die Mail wird für alle sichtbar, die die Aufgabe lesen dürfen – mit Bestätigung und Audit-Eintrag.</p>
          <table className="table"><tbody>
            {tasks.filter((t) => !t.done).map((t) => <tr key={t.id}><td>{t.title}</td><td className="nowrap"><button className="btn sm" onClick={() => void doLink(t.id, false)}>Verknüpfen</button> <button className="btn sm" onClick={() => void doLink(t.id, true)}>Kopieren</button></td></tr>)}
          </tbody></table>
        </Modal>
      )}
      {confirmCopy && (
        <Modal title="Kopie bestätigen" onClose={() => setConfirmCopy(null)}>
          <p>Diese Mail wird durch die Kopie für folgende Personen sichtbar:</p>
          <ul>{confirmCopy.willSee.map((w) => <li key={w.name}>{w.name} <span className="badge">{roleLabel[w.role]}</span></li>)}</ul>
          <div className="row"><button className="btn primary" onClick={() => void doLink(confirmCopy.taskId, true, true)}>Kopieren und protokollieren</button><button className="btn" onClick={() => setConfirmCopy(null)}>Abbrechen</button></div>
        </Modal>
      )}
      {createTask && <CreateTaskFromMail mail={m} onClose={() => setCreateTask(false)} onCreated={async (id) => { setCreateTask(false); await d.reload(); await reloadTasks(); onChanged(); nav(`/projekte/${detail.project.id}?task=${id}`); }} />}
    </div>
  );
}

function CreateTaskFromMail({ mail, onClose, onCreated }: { mail: MailDetail; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const { detail, users } = useProject();
  const [f, setF] = useState({ title: mail.subject.replace(/^(re|aw|fwd|wg):\s*/i, ''), subprojectId: '', dueDate: '', responsibleUserId: '', responsibleEmail: '', copy: false });
  const { busy, error, run } = useAsync();
  const members = users.filter((u) => detail.members.some((m) => m.userId === u.id));
  return (
    <Modal title="Aufgabe aus Mail (W3)" onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Titel</span><input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field"><span>Teilprojekt</span><select value={f.subprojectId} onChange={(e) => setF({ ...f, subprojectId: e.target.value })}><option value="">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>Deadline</span><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
        <label className="field"><span>Zuständig</span><select value={f.responsibleUserId} onChange={(e) => setF({ ...f, responsibleUserId: e.target.value })}><option value="">– geerbt –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field"><span>oder extern</span><input type="email" value={f.responsibleEmail} onChange={(e) => setF({ ...f, responsibleEmail: e.target.value })} placeholder={mail.fromAddr} /></label>
        <label className="check full"><input type="checkbox" checked={f.copy} onChange={(e) => setF({ ...f, copy: e.target.checked })} /> Mail als Kopie in die Aufgabe übernehmen (dann gelten die Aufgabenrechte)</label>
        <p className="muted small full">Beschreibung wird aus dem Mailtext vorbefüllt. KI-Vorbefüllung folgt als letztes Modul.</p>
        {error && <div className="error full">{error}</div>}
        <div className="row full"><button className="btn primary" disabled={busy} onClick={() => void run(async () => {
          const r = await api.post<{ task: { id: string } }>(`/mail/mails/${mail.id}/create-task`, { projectId: detail.project.id, title: f.title, subprojectId: f.subprojectId || null, dueDate: f.dueDate || null, responsibleUserId: f.responsibleUserId || null, responsibleEmail: f.responsibleEmail || null, copy: f.copy });
          await onCreated(r.task.id);
        })}>Aufgabe anlegen</button></div>
      </div>
    </Modal>
  );
}

function Compose({ views, onDone }: { views: ViewRow[]; onDone: () => void }) {
  const { detail, tasks } = useProject();
  const [params] = useSearchParams();
  const replyTo = params.get('reply');
  const taskParam = params.get('task');
  const writable = views.filter((v) => v.myRights.canDraft || v.myRights.canSend);
  const [f, setF] = useState({ viewId: params.get('view') ?? writable[0]?.id ?? '', taskId: taskParam ?? '', to: '', cc: '', subject: '', body: '', inReplyTo: '' as string | null });
  const { busy, error, run } = useAsync();
  useEffect(() => {
    if (replyTo) {
      api.get<{ mail: MailDetail }>(`/mail/mails/${replyTo}`).then(({ mail }) => {
        setF((x) => ({ ...x, to: mail.fromAddr, subject: mail.subject.startsWith('Re:') ? mail.subject : `Re: ${mail.subject}`, inReplyTo: mail.messageId, taskId: x.taskId || (mail.linkedTaskIds[0] ?? ''),
          body: `\n\n---\nAm ${fmtDateTime(mail.date)} schrieb ${mail.fromName ?? mail.fromAddr}:\n${(mail.textBody ?? '').split('\n').map((l) => `> ${l}`).join('\n')}` }));
      }).catch(() => undefined);
    } else if (taskParam) {
      const t = tasks.find((x) => x.id === taskParam);
      if (t) setF((x) => ({ ...x, to: t.responsible.email && !t.responsible.userId ? t.responsible.email : '', subject: `${detail.project.key}: ${t.title}`, body: `Guten Tag,\n\nzur Aufgabe „${t.title}“${t.dueDate ? ` (fällig ${t.dueDate.split('-').reverse().join('.')})` : ''}:\n\n\n\nMit freundlichen Grüßen\n` }));
    }
  }, [replyTo, taskParam]);
  const view = views.find((v) => v.id === f.viewId);
  if (writable.length === 0) return <div className="mail-detail"><div className="empty">Du hast an keiner Ansicht ein Entwurfs- oder Senderecht.</div></div>;
  const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  return (
    <div className="mail-detail">
      <h2>{replyTo ? 'Antwort' : 'Neue Mail'}</h2>
      <div className="form">
        <label className="field"><span>Senden über Ansicht / Konto</span>
          <select value={f.viewId} onChange={(e) => setF({ ...f, viewId: e.target.value })}>{writable.map((v) => <option key={v.id} value={v.id}>{v.name} – {v.accountAddress}{v.myRights.canSend ? '' : ' (nur Entwurf, Versand nach Freigabe)'}</option>)}</select></label>
        <label className="field"><span>Zu Aufgabe (setzt Antwortadresse mit Aufgaben-Code)</span>
          <select value={f.taskId} onChange={(e) => setF({ ...f, taskId: e.target.value })}><option value="">– keine –</option>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
        <label className="field"><span>An</span><input type="text" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="mehrere mit Komma" /></label>
        <label className="field"><span>Cc</span><input type="text" value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} /></label>
        <label className="field"><span>Betreff</span><input type="text" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
        <label className="field"><span>Text</span><textarea style={{ minHeight: 240 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        {view?.accountType === 'personal' && !view.myRights.canSend && <div className="notice small">Aus persönlichen Konten sendet nur der Eigentümer. Dein Entwurf geht an ihn zur Freigabe.</div>}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || !f.to || !f.subject} onClick={() => void run(async () => { await api.post('/mail/drafts', { viewId: f.viewId, projectId: detail.project.id, taskId: f.taskId || null, to: split(f.to), cc: split(f.cc), subject: f.subject, body: f.body, inReplyTo: f.inReplyTo, send: true }); onDone(); })}>
            {view?.myRights.canSend ? 'Senden' : 'Zur Freigabe einreichen'}
          </button>
          <button className="btn" disabled={busy || !f.to || !f.subject} onClick={() => void run(async () => { await api.post('/mail/drafts', { viewId: f.viewId, projectId: detail.project.id, taskId: f.taskId || null, to: split(f.to), cc: split(f.cc), subject: f.subject, body: f.body, inReplyTo: f.inReplyTo, send: false }); onDone(); })}>Als Entwurf speichern</button>
        </div>
      </div>
    </div>
  );
}

function DraftsPanel({ drafts, reload }: { drafts: MailDraft[]; reload: () => Promise<void> }) {
  const { error, run } = useAsync();
  const [edit, setEdit] = useState<MailDraft | null>(null);
  const groups: [string, string][] = [['pending_approval', 'Wartet auf Freigabe'], ['draft', 'Entwürfe'], ['failed', 'Fehlgeschlagen'], ['sent', 'Gesendet']];
  return (
    <div className="mail-detail">
      <h2>Entwürfe und Freigaben</h2>
      <p className="muted small">Vorschläge und Entwürfe ohne Senderecht landen hier. Freigeben darf, wer an der Ansicht das Senderecht hat. Der Worker versendet; alles steht im Audit-Log.</p>
      {error && <div className="error mb">{error}</div>}
      {groups.map(([status, label]) => {
        const rows = drafts.filter((d) => d.status === status);
        if (!rows.length) return null;
        return (
          <div key={status} className="card mb">
            <h3>{label} <span className="badge">{rows.length}</span></h3>
            <table className="table"><tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.subject}</strong><div className="muted small">an {d.toAddrs.join(', ')} · von {d.userName} · {fmtDateTime(d.createdAt)}</div>{d.error && <div className="error small mt">{d.error}</div>}</td>
                  <td className="nowrap">
                    {status !== 'sent' && <button className="btn sm" onClick={() => setEdit(d)}>Ansehen</button>}{' '}
                    {(status === 'pending_approval' || status === 'draft' || status === 'failed') && <button className="btn sm primary" onClick={() => void run(async () => { await api.post(`/mail/drafts/${d.id}/send`); await reload(); })}>{status === 'pending_approval' ? 'Freigeben und senden' : 'Senden'}</button>}{' '}
                    {status !== 'sent' && <button className="btn sm danger" onClick={() => void run(async () => { await api.del(`/mail/drafts/${d.id}`); await reload(); })}>{status === 'pending_approval' ? 'Ablehnen' : 'Löschen'}</button>}
                  </td>
                </tr>
              ))}
            </tbody></table>
          </div>
        );
      })}
      {drafts.length === 0 && <div className="empty">Keine Entwürfe.</div>}
      {edit && (
        <Modal title={edit.subject} onClose={() => setEdit(null)}>
          <div className="hdr small muted">An: {edit.toAddrs.join(', ')}{edit.ccAddrs.length > 0 && <> · Cc: {edit.ccAddrs.join(', ')}</>}</div>
          <EditDraft draft={edit} onSaved={async () => { setEdit(null); await reload(); }} />
        </Modal>
      )}
    </div>
  );
}

function EditDraft({ draft, onSaved }: { draft: MailDraft; onSaved: () => Promise<void> }) {
  const [body, setBody] = useState(draft.body);
  const [subject, setSubject] = useState(draft.subject);
  const { busy, error, run } = useAsync();
  return (
    <div className="form">
      <label className="field"><span>Betreff</span><input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
      <label className="field"><span>Text (Vorher/Nachher: Änderungen werden gespeichert, bevor freigegeben wird)</span><textarea style={{ minHeight: 200 }} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.patch(`/mail/drafts/${draft.id}`, { subject, body }); await onSaved(); })}>Speichern</button></div>
    </div>
  );
}

function NewView({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { detail } = useProject();
  const accounts = useData<{ accounts: MailAccount[] }>('/mail/accounts');
  const [f, setF] = useState({ accountId: '', name: '', folders: '', from: '', to: '', subject: '', keyword: '', since: '', memberRead: true, memberDraft: true, memberTask: true, readerRead: false });
  const { busy, error, run } = useAsync();
  const usable = (accounts.data?.accounts ?? []).filter((a) => a.type === 'personal' || a.projectId === detail.project.id);
  return (
    <Modal title="Neue Mail-Ansicht" onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Konto</span>
          <select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}><option value="">– wählen –</option>{usable.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.address}) – {a.type === 'personal' ? 'persönlich' : 'Projektkonto'}</option>)}</select></label>
        {usable.length === 0 && <p className="notice small full">Kein Konto verfügbar. Lege unter „Mail-Konten“ ein persönliches Konto an oder als PL ein Projektkonto.</p>}
        <label className="field full"><span>Name der Ansicht</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Kunde Müller" /></label>
        <label className="field"><span>Absender (Adresse oder @domain, Komma)</span><input type="text" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="@mueller-design.de" /></label>
        <label className="field"><span>Empfänger enthält</span><input type="text" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="field"><span>Betreff enthält</span><input type="text" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
        <label className="field"><span>Stichwort im Text</span><input type="text" value={f.keyword} onChange={(e) => setF({ ...f, keyword: e.target.value })} /></label>
        <label className="field"><span>Ordner (leer = INBOX)</span><input type="text" value={f.folders} onChange={(e) => setF({ ...f, folders: e.target.value })} placeholder="INBOX, Sent" /></label>
        <label className="field"><span>Ab Datum</span><input type="date" value={f.since} onChange={(e) => setF({ ...f, since: e.target.value })} /></label>
        <div className="full"><strong className="small">Rechte für Rollen</strong> <span className="muted small">(du selbst erhältst alle Rechte; Senden aus persönlichen Konten nur du)</span></div>
        <label className="check"><input type="checkbox" checked={f.memberRead} onChange={(e) => setF({ ...f, memberRead: e.target.checked })} /> Mitglieder lesen</label>
        <label className="check"><input type="checkbox" checked={f.memberDraft} onChange={(e) => setF({ ...f, memberDraft: e.target.checked })} /> Mitglieder entwerfen</label>
        <label className="check"><input type="checkbox" checked={f.memberTask} onChange={(e) => setF({ ...f, memberTask: e.target.checked })} /> Mitglieder: Aufgabe erzeugen</label>
        <label className="check"><input type="checkbox" checked={f.readerRead} onChange={(e) => setF({ ...f, readerRead: e.target.checked })} /> Leser lesen</label>
        {error && <div className="error full">{error}</div>}
        <div className="row full"><button className="btn primary" disabled={busy || !f.accountId || !f.name} onClick={() => void run(async () => {
          const filter: MailViewFilter = { folders: f.folders || undefined, from: f.from || undefined, to: f.to || undefined, subject: f.subject || undefined, keyword: f.keyword || undefined, since: f.since || null } as any;
          const roleRights: Record<string, unknown> = { pl: { canRead: true, canDraft: true, canSend: true, canCreateTask: true, canAi: true } };
          if (f.memberRead) roleRights.member = { canRead: true, canDraft: f.memberDraft, canCreateTask: f.memberTask };
          if (f.readerRead) roleRights.reader = { canRead: true };
          await api.post(`/projects/${detail.project.id}/mail/views`, { accountId: f.accountId, name: f.name, filter, roleRights });
          onCreated();
        })}>Ansicht anlegen</button></div>
      </div>
    </Modal>
  );
}

interface RightRow { id?: string; userId: string | null; userName?: string | null; role: string | null; canRead: boolean; canDraft: boolean; canSend: boolean; canAi: boolean; canCreateTask: boolean }

function RightsEditor({ view, onClose, onChanged }: { view: ViewRow; onClose: () => void; onChanged: () => void }) {
  const { detail } = useProject();
  const [rows, setRows] = useState<RightRow[] | null>(null);
  const [addUser, setAddUser] = useState('');
  const { busy, error, run } = useAsync();
  useEffect(() => { api.get<{ rights: RightRow[] }>(`/mail/views/${view.id}/rights`).then((r) => setRows(r.rights)); }, [view.id]);
  const flags: [keyof RightRow, string][] = [['canRead', 'Lesen'], ['canDraft', 'Entwurf'], ['canSend', 'Senden'], ['canCreateTask', 'Aufgabe'], ['canAi', 'KI']];
  const [filterEdit, setFilterEdit] = useState(false);
  if (!rows) return null;
  const label = (r: RightRow) => (r.userId ? r.userName ?? detail.members.find((m) => m.userId === r.userId)?.name ?? '?' : `Rolle ${roleLabel[r.role!]}`);
  return (
    <Modal title={`Rechte: ${view.name}`} onClose={onClose}>
      <table className="table"><thead><tr><th>Person / Rolle</th>{flags.map(([k, l]) => <th key={k}>{l}</th>)}<th /></tr></thead><tbody>
        {rows.map((r, i) => <tr key={i}><td>{label(r)}</td>{flags.map(([k]) => <td key={k}><input type="checkbox" checked={Boolean(r[k])} disabled={k === 'canSend' && view.accountType === 'personal'} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, [k]: e.target.checked } : x)))} /></td>)}<td><button className="btn sm link" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button></td></tr>)}
      </tbody></table>
      <div className="row mt">
        <select value={addUser} onChange={(e) => setAddUser(e.target.value)} style={{ width: 'auto' }}>
          <option value="">+ Person oder Rolle</option>
          {['pl', 'member', 'reader'].filter((ro) => !rows.some((r) => r.role === ro)).map((ro) => <option key={ro} value={`role:${ro}`}>Rolle {roleLabel[ro]}</option>)}
          {detail.members.filter((m) => !rows.some((r) => r.userId === m.userId)).map((m) => <option key={m.userId} value={`user:${m.userId}`}>{m.name}</option>)}
        </select>
        <button className="btn sm" disabled={!addUser} onClick={() => { const [kind, id] = addUser.split(':'); setRows([...rows, { userId: kind === 'user' ? id : null, role: kind === 'role' ? id : null, canRead: true, canDraft: false, canSend: false, canAi: false, canCreateTask: false }]); setAddUser(''); }}>Hinzufügen</button>
        <button className="btn sm right" onClick={() => setFilterEdit(true)}>Filter bearbeiten</button>
      </div>
      {view.accountType === 'personal' && <p className="muted small mt">Persönliches Konto: Senden bleibt beim Eigentümer.</p>}
      {error && <div className="error mt">{error}</div>}
      <div className="row mt">
        <button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.put(`/mail/views/${view.id}/rights`, { rights: rows }); onChanged(); onClose(); })}>Speichern</button>
        <button className="btn danger right" onClick={() => { if (confirm('Ansicht entfernen? Mails verschwinden aus dem Projekt, Kopien in Aufgaben bleiben.')) void run(async () => { await api.del(`/mail/views/${view.id}`); onChanged(); onClose(); }); }}>Ansicht entfernen</button>
      </div>
      {filterEdit && <FilterEditor view={view} onClose={() => setFilterEdit(false)} onSaved={() => { setFilterEdit(false); onChanged(); }} />}
    </Modal>
  );
}

function FilterEditor({ view, onClose, onSaved }: { view: ViewRow; onClose: () => void; onSaved: () => void }) {
  const f0 = view.filter;
  const [f, setF] = useState({ name: view.name, folders: f0.folders?.join(', ') ?? '', from: f0.from?.join(', ') ?? '', to: f0.to?.join(', ') ?? '', subject: f0.subject?.join(', ') ?? '', keyword: f0.keyword?.join(', ') ?? '', since: f0.since ?? '' });
  const { busy, error, run } = useAsync();
  return (
    <Modal title="Filter der Ansicht" onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>Absender</span><input type="text" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="field"><span>Empfänger</span><input type="text" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="field"><span>Betreff</span><input type="text" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
        <label className="field"><span>Stichwort</span><input type="text" value={f.keyword} onChange={(e) => setF({ ...f, keyword: e.target.value })} /></label>
        <label className="field"><span>Ordner</span><input type="text" value={f.folders} onChange={(e) => setF({ ...f, folders: e.target.value })} /></label>
        <label className="field"><span>Ab Datum</span><input type="date" value={f.since} onChange={(e) => setF({ ...f, since: e.target.value })} /></label>
        <p className="muted small full">Nach dem Speichern werden die Treffer neu berechnet; Mails, die keine Ansicht mehr treffen, werden gelöscht (Kopien in Aufgaben bleiben).</p>
        {error && <div className="error full">{error}</div>}
        <div className="full"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.patch(`/mail/views/${view.id}`, { name: f.name, filter: { folders: f.folders, from: f.from, to: f.to, subject: f.subject, keyword: f.keyword, since: f.since || null } }); onSaved(); })}>Speichern</button></div>
      </div>
    </Modal>
  );
}

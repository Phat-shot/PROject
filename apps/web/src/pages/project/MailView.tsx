import { useEffect, useMemo, useState, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AiFeature, MailAiRun, MailDetail, MailDraft, MailView as MailViewT, MailAccount, MailViewFilter, MailAction, DocFolder, DocPage, Group, MailFolder, InboxMail, OutboundCheck, OutboundFinding, AudienceClass } from '@projekttool/shared';
import { AUDIENCE_LABEL } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, PromptModal, roleLabel, statusLabel, useAsync, useDialog } from '../../components/ui';
import { ProjectScope, useProject } from '../ProjectPage';
import { useIsMobile } from '../../lib/useMedia';
import { useAssistAgent } from '../../components/AssistAgent';
import { aiBlocked } from '../../lib/useAi';
import { refreshMailUnread, useMailUnread } from '../../lib/useMailUnread';
import { MailAiBox } from './MailAi';

export type ViewRow = MailViewT & { canManage?: boolean };

export const FOLDER_LABEL: Record<string, string> = { inbox: 'Posteingang', sent: 'Gesendet', archive: 'Archiv', trash: 'Papierkorb', drafts: 'Entwürfe', junk: 'Spam' };

/** Ordner aller Konten, auf die lesbare Ansichten zeigen; gleiche Spezialordner werden zusammengelegt. */
function useFolders(accountIds: string[]) {
  const [folders, setFolders] = useState<(MailFolder & { accountIds: string[] })[]>([]);
  const key = accountIds.join(',');
  useEffect(() => {
    if (!key) { setFolders([]); return; }
    let alive = true;
    Promise.all(accountIds.map((id) => api.get<{ folders: MailFolder[] }>(`/mail/accounts/${id}/folders`).then((r) => r.folders.map((f) => ({ ...f, accountId: id }))).catch(() => [] as (MailFolder & { accountId: string })[])))
      .then((lists) => {
        if (!alive) return;
        const merged = new Map<string, MailFolder & { accountIds: string[] }>();
        for (const f of lists.flat()) {
          const k = f.specialUse ?? f.path.toLowerCase();
          const cur = merged.get(k);
          if (cur) cur.accountIds.push(f.accountId); else merged.set(k, { path: f.path, name: f.name, specialUse: f.specialUse, accountIds: [f.accountId] });
        }
        const order = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash'];
        setFolders([...merged.values()].sort((a, b) => (a.specialUse ? order.indexOf(a.specialUse) : 99) - (b.specialUse ? order.indexOf(b.specialUse) : 99) || a.name.localeCompare(b.name)));
      });
    return () => { alive = false; };
  }, [key]);
  return folders;
}

/**
 * Postfach (nur global, /postfach): vereinigte Sicht aller Postfächer mit Leserecht, jede Mail einmal. Links „Zur Freigabe“
 * (Entwürfe, auch der KI) und die Ordner; oben Filter nach Postfach und Projekt. Ansichten pflegt die PL in den
 * Projekteinstellungen; hier wirken sie nur als Leserecht. Alte Projektpfade (/projekte/:id/mail/…) leiten hierher.
 */
export function MailView() {
  const base = '/postfach';
  const views = useData<{ views: ViewRow[] }>('/mail/views');
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const folder = params.get('ordner') ?? 'INBOX';
  const accountId = params.get('postfach') ?? '';
  const projectId = params.get('projekt') ?? '';
  const unread = useMailUnread();
  const mobile = useIsMobile();
  const all = (views.data?.views ?? []).filter((v) => v.myRights.canRead);
  const projects = [...new Map(all.map((v) => [v.projectId, { id: v.projectId, key: v.projectKey ?? '' }])).values()].sort((a, b) => a.key.localeCompare(b.key));
  const readable = all.filter((v) => !projectId || v.projectId === projectId);
  const accountIds = Array.from(new Set(readable.map((v) => v.accountId)));
  const accounts = accountIds.map((id) => readable.find((v) => v.accountId === id)!);
  const folders = useFolders(accountIds.filter((id) => !accountId || id === accountId));
  const drafts = useData<{ drafts: MailDraft[] }>(`/mail/drafts${projectId ? `?projectId=${projectId}` : ''}`, [loc.pathname]);
  const pending = (drafts.data?.drafts ?? []).filter((d) => d.status === 'pending_approval');
  const canWrite = readable.some((v) => v.myRights.canDraft || v.myRights.canSend);
  const manage = projectId && (views.data?.views ?? []).some((v) => v.projectId === projectId && v.canManage);
  const inList = loc.pathname === base || loc.pathname.startsWith(`${base}/m/`);
  const inDrafts = loc.pathname === `${base}/freigaben`;
  const query = (patch: Record<string, string>) => { const n = new URLSearchParams(params); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } ['reply', 'view', 'ap', 'task', 'to', 'subject', 'body', 'final', 'ai'].forEach((k) => n.delete(k)); return n.toString(); };
  const go = (patch: Record<string, string>, path = base) => nav(`${path}?${query(patch)}`);
  const label = (f: MailFolder) => (f.specialUse ? FOLDER_LABEL[f.specialUse] : f.name);
  const kindLabel = (v: ViewRow) => (v.accountType === 'personal' ? 'persönlich' : v.accountType === 'org' ? 'Organisation' : 'Projektkonto');
  const filters = (
    <div className="mail-filters">
      <select aria-label="Postfach" value={accountId} onChange={(e) => go({ postfach: e.target.value })}>
        <option value="">Alle Postfächer{unread.total ? ` (${unread.total})` : ''}</option>
        {accounts.map((v) => <option key={v.accountId} value={v.accountId}>{v.accountAddress} · {kindLabel(v)}{unread.byAccount?.[v.accountId] ? ` (${unread.byAccount[v.accountId]})` : ''}</option>)}
      </select>
      <select aria-label="Projekt" value={projectId} onChange={(e) => go({ projekt: e.target.value, postfach: '' })}>
        <option value="">Alle Projekte</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.key}{unread.byProject[p.id] ? ` (${unread.byProject[p.id]})` : ''}</option>)}
      </select>
    </div>
  );
  return (
    <div className="mail-layout">
      {mobile ? <div className="mail-mobile-bar">
        <select aria-label="Ordner" value={inDrafts ? '__freigaben' : folder} onChange={(e) => (e.target.value === '__freigaben' ? go({}, `${base}/freigaben`) : go({ ordner: e.target.value }))}>
          <option value="__freigaben">Zur Freigabe ({pending.length})</option>
          {folders.map((f) => <option key={f.path} value={f.path}>{label(f)}</option>)}
        </select>
        {canWrite && <button className="btn sm primary right" onClick={() => go({}, `${base}/neu`)}>Neue Mail</button>}
      </div> : <div className="mail-views">
        {canWrite && <button className="btn primary mb" style={{ width: '100%' }} onClick={() => go({}, `${base}/neu`)}>Neue Mail</button>}
        <div className={`view approve ${inDrafts ? 'active' : ''} ${pending.length ? 'has' : ''}`} onClick={() => go({}, `${base}/freigaben`)} title="Entwürfe von Personen und KI-Agenten, die auf Freigabe warten">
          <span>Zur Freigabe</span>{pending.length > 0 && <span className="badge warn">{pending.length}</span>}
        </div>
        <div className="section">Ordner</div>
        {folders.map((f) => (
          <div key={f.path} className={`view ${inList && folder.toLowerCase() === f.path.toLowerCase() ? 'active' : ''}`} onClick={() => go({ ordner: f.path })}>
            <span>{label(f)}</span>{f.specialUse === 'inbox' && (accountId ? unread.byAccount?.[accountId] : projectId ? unread.byProject[projectId] : unread.total) ? <span className="badge danger">{accountId ? unread.byAccount?.[accountId] : projectId ? unread.byProject[projectId] : unread.total}</span> : null}
          </div>
        ))}
        {folders.length === 0 && <div className="muted small" style={{ padding: '4px 10px' }}>{views.data && readable.length === 0 ? 'Kein Postfach mit Leserecht.' : 'Lade Ordner …'}</div>}
        {manage && <Link className="btn sm link mt" to={`/projekte/${projectId}/einstellungen/mail`}>Ansichten und Filter verwalten</Link>}
      </div>}
      <Routes>
        <Route index element={<InboxList base={base} projectId={projectId} folder={folder} accountId={accountId} views={views.data?.views ?? []} folders={folders} mobile={mobile} filters={filters} pending={pending.length} />} />
        <Route path="m/:mailId" element={<InboxList base={base} projectId={projectId} folder={folder} accountId={accountId} views={views.data?.views ?? []} folders={folders} mobile={mobile} filters={filters} pending={pending.length} />} />
        <Route path="freigaben" element={<div className="mail-wide">{filters}<DraftsPanel drafts={drafts.data?.drafts ?? []} reload={drafts.reload} projectId={projectId} /></div>} />
        <Route path="neu" element={<div className="mail-wide"><ComposeGlobal views={views.data?.views ?? []} onDone={(pid) => { void drafts.reload(); nav(`${base}/freigaben?projekt=${pid}`); }} /></div>} />
        <Route path="*" element={<Navigate to={base} replace />} />
      </Routes>
    </div>
  );
}

/** Neue Mail im Postfach: im Projekt der gewählten Ansicht (view), des Filters oder der Antwort; sonst Projekt wählen. */
function ComposeGlobal({ views, onDone }: { views: ViewRow[]; onDone: (projectId: string) => void }) {
  const [params, setParams] = useSearchParams();
  const writable = views.filter((v) => v.myRights.canDraft || v.myRights.canSend);
  const projects = [...new Map(writable.map((v) => [v.projectId, v.projectKey ?? ''])).entries()];
  const fromView = writable.find((v) => v.id === params.get('view'))?.projectId;
  const projectId = fromView ?? (writable.some((v) => v.projectId === params.get('projekt')) ? params.get('projekt') : null) ?? (projects.length === 1 ? projects[0][0] : null);
  if (!views.length) return <div className="mail-detail muted">Lade …</div>;
  if (!writable.length) return <div className="mail-detail"><div className="empty">Du hast an keinem Postfach Entwurfs- oder Senderecht.</div></div>;
  if (!projectId) return (
    <div className="mail-detail">
      <h2>Neue Mail</h2>
      <label className="field"><span>Projekt</span>
        <select value="" onChange={(e) => { const n = new URLSearchParams(params); n.set('projekt', e.target.value); setParams(n, { replace: true }); }}>
          <option value="">Projekt wählen …</option>{projects.map(([id, key]) => <option key={id} value={id}>{key}</option>)}
        </select>
      </label>
    </div>
  );
  return <ProjectScope projectId={projectId}><Compose key={projectId} views={writable.filter((v) => v.projectId === projectId)} onDone={() => onDone(projectId)} /></ProjectScope>;
}

function InboxList({ base, projectId, folder, accountId, views, folders, mobile = false, filters, pending }: { base: string; projectId: string; folder: string; accountId: string; views: ViewRow[]; folders: MailFolder[]; mobile?: boolean; filters: ReactNode; pending: number }) {
  const { mailId } = useParams();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const url = `/mail/inbox?${projectId ? `projectId=${projectId}&` : ''}${folder ? `folder=${encodeURIComponent(folder)}` : ''}${accountId ? `&accountId=${accountId}` : ''}`;
  // Gelesen-Stand gilt je Person für die Mail: ändert sich der Zähler (Öffnen anderswo, Abruf), Liste nachladen
  const unreadTotal = useMailUnread().total;
  const list = useData<{ mails: InboxMail[] }>(url, [unreadTotal]);
  const accountCount = new Set(views.filter((v) => v.myRights.canRead).map((v) => v.accountId)).size;
  const needle = q.trim().toLowerCase();
  const mails = (list.data?.mails ?? []).filter((m) => !needle || m.subject.toLowerCase().includes(needle) || m.fromAddr.toLowerCase().includes(needle) || (m.fromName ?? '').toLowerCase().includes(needle));
  // Öffnen gilt als gelesen: Liste und Zähler sofort nachziehen (der Server trägt es beim Laden der Mail ein)
  const open = (id: string) => { nav(`${base}/m/${id}?${params.toString()}`); if (list.data?.mails.some((m) => m.id === id && m.unread)) { list.setData({ mails: list.data.mails.map((m) => (m.id === id ? { ...m, unread: false } : m)) }); setTimeout(refreshMailUnread, 500); } };
  const current = mails.find((m) => m.id === mailId);
  // Mail außerhalb der Liste (Link aus Meldung, Chat, anderer Ordner): Projekt über ihre Ansichten bestimmen
  const outside = useData<{ viewIds: string[] }>(mailId && !current && list.data ? `/mail/mails/${mailId}` : null, [mailId]);
  const pid = current?.projectId ?? views.find((v) => outside.data?.viewIds.includes(v.id) && (!projectId || v.projectId === projectId))?.projectId ?? views.find((v) => outside.data?.viewIds.includes(v.id))?.projectId ?? null;
  const back = `${base}?${params.toString()}`;
  return (
    <>
      {mobile && mailId && <div className="mail-mobile-bar"><button className="btn sm" onClick={() => nav(back)}>← Zur Liste</button></div>}
      {(!mobile || !mailId) && <div className="mail-list">
        {filters}
        {pending > 0 && <div className="mail-approve-note" onClick={() => nav(`${base}/freigaben?${params.toString()}`)}>{pending} Entw{pending === 1 ? 'urf wartet' : 'ürfe warten'} auf Freigabe →</div>}
        <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <input type="text" placeholder="Betreff oder Absender …" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
          <span className="muted small nowrap">{mails.length}</span>
        </div>
        {list.error && <div className="error" style={{ margin: 12 }}>{list.error}</div>}
        {mails.map((m) => (
          <div key={m.id} className={`mail-item ${mailId === m.id ? 'active' : ''} ${m.unread ? 'unread' : ''}`} onClick={() => open(m.id)}>
            <div className="from"><span>{m.folder.toLowerCase() === 'sent' ? `An: ${m.toJson.join(', ')}` : m.fromName ?? m.fromAddr}</span><span className="date">{fmtDateTime(m.date)}</span></div>
            <div className="subject">{m.subject}{m.linkedTaskIds.length > 0 && <span className="badge" style={{ marginLeft: 6 }}>Arbeitspaket</span>}{m.hasAttachments && ' 📎'}</div>
            <div className="snippet">{!projectId && (m.projectKeys ?? [m.projectKey]).map((k) => <span key={k} className="badge" style={{ marginRight: 6 }}>{k}</span>)}{m.snippet}{!accountId && accountCount > 1 && <span className="muted"> · {m.accountName}</span>}</div>
          </div>
        ))}
        {list.data && mails.length === 0 && <div className="empty" style={{ margin: 12 }}>{views.length === 0 ? 'Noch kein Postfach mit Leserecht. Die PL legt Ansichten unter Projekteinstellungen › Mail an.' : 'Keine Mails in diesem Ordner.'}</div>}
      </div>}
      {mobile && !mailId ? null : mailId && pid
        ? <ProjectScope projectId={pid}><MailDetailPanel mailId={mailId} views={views} folders={folders} onChanged={() => void list.reload()} onGone={() => { void list.reload(); nav(back); }} viewHint={current?.viewId} /></ProjectScope>
        : <div className="mail-detail muted">{mailId ? (outside.error ?? 'Lade …') : 'Mail wählen.'}</div>}
    </>
  );
}

function MailDetailPanel({ mailId, views, folders, onChanged, onGone, viewHint }: { mailId: string; views: ViewRow[]; folders: MailFolder[]; onChanged: () => void; onGone: () => void; viewHint?: string }) {
  const { detail, tasks, reloadTasks, openTask, ai } = useProject();
  const d = useData<{ mail: MailDetail; rights: MailViewT['myRights']; viewIds: string[]; canModify: boolean; links: { taskId: string; title: string; code: string; projectId: string; copied: boolean; origin: boolean; isSubtask: boolean }[] }>(`/mail/mails/${mailId}`, [mailId]);
  const [moveTo, setMoveTo] = useState('');
  const [newFolder, setNewFolder] = useState(false);
  const actions = useData<{ rule: MailAction[]; ai: MailAction[]; pages: { pageId: string; kind: string; title: string }[] }>(`/mail/mails/${mailId}/actions`);
  const aiRuns = useData<{ runs: MailAiRun[]; suggestAgent: { id: string; name: string; canProcess: boolean } | null }>(`/mail/mails/${mailId}/ai?projectId=${detail.project.id}`, [mailId]);
  const suggestAgent = aiRuns.data?.suggestAgent ?? null;
  const [dialog, setDialog] = useState<null | 'link' | 'log' | 'adjust' | 'toPage' | 'appendPage' | 'createTask' | 'aiEssence' | 'aiMerge'>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [confirmCopy, setConfirmCopy] = useState<{ run: () => Promise<void>; willSee: { name: string; role: string }[] } | null>(null);
  const nav = useNavigate();
  const { error, run } = useAsync();
  const dlg = useDialog();
  const sumAgent = useAssistAgent(ai, 'assist.summarize');
  const essAgent = useAssistAgent(ai, 'assist.essence');
  if (d.error) return <div className="mail-detail"><div className="error">{d.error}</div><p className="muted mt">Verknüpfte Mail, keine Berechtigung: Du darfst die Ansicht nicht lesen, aus der diese Mail stammt.</p></div>;
  if (!d.data) return <div className="mail-detail muted">Lade …</div>;
  const m = d.data.mail;
  const r = d.data.rights;
  const view = views.find((v) => v.id === viewHint && d.data!.viewIds.includes(v.id)) ?? views.find((v) => d.data!.viewIds.includes(v.id));
  const mailFolders = folders.filter((f) => (f as any).accountIds ? (f as any).accountIds.includes(m.accountId) : true);
  const refresh = async () => { await d.reload(); await actions.reload(); await reloadTasks(); onChanged(); };
  const folderAction = (call: () => Promise<unknown>) => run(async () => { await call(); onGone(); });
  const enabled = (key: string) => actions.data?.rule.find((a) => a.key === key)?.enabled ?? false;
  const reason = (key: string) => actions.data?.rule.find((a) => a.key === key)?.reason ?? '';
  // KI-Knöpfe bleiben sichtbar und nennen den Grund, wenn sie nicht gehen: Recht an der Ansicht, KI nutzen, Agent mit dem Recht
  const aiNo = (f: AiFeature) => (!r.canAi ? 'Kein KI-Recht in dieser Ansicht' : aiBlocked(ai, f));
  const aiReasons = [...new Set([aiNo('assist.summarize'), aiNo('assist.essence'), aiNo('mail.triage')].filter((x): x is string => Boolean(x)))];

  /** Führt eine Aktion aus, die eine Bestätigung verlangen kann (Kopie wird für Mitglieder sichtbar). */
  const withConfirm = async (call: (confirmed: boolean) => Promise<any>, after: (res: any) => Promise<void>) => {
    await run(async () => {
      const res = await call(false);
      if (res?.needsConfirmation) {
        setConfirmCopy({ willSee: res.willSee ?? [], run: async () => { const r2 = await call(true); setConfirmCopy(null); await after(r2); } });
        return;
      }
      await after(res);
    });
  };
  const doLink = (taskId: string, copy: boolean) => withConfirm(
    (confirmed) => api.post(`/mail/mails/${m.id}/link`, { taskId, copy, confirmed }),
    async () => { setDialog(null); await refresh(); }
  );

  return (
    <div className="mail-detail">
      <h2>{m.subject}</h2>
      <div className="hdr">
        <div><strong>Von:</strong> {m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr}</div>
        <div><strong>An:</strong> {m.toJson.join(', ')}</div>
        {m.ccJson.length > 0 && <div><strong>Cc:</strong> {m.ccJson.join(', ')}</div>}
        <div><strong>Datum:</strong> {fmtDateTime(m.date)} · Ordner {m.folder}</div>
      </div>
      <div className="mail-actions">
        <span className="muted small">Mail:</span>
        {(r.canDraft || r.canSend) && view && <Link className="btn sm" to={`/postfach/neu?reply=${m.id}&view=${view.id}&projekt=${detail.project.id}`}>Antworten</Link>}
        {d.data.canModify && (<>
          <button className="btn sm" onClick={() => folderAction(() => api.post(`/mail/mails/${m.id}/archive`))}>Archivieren</button>
          <button className="btn sm danger" onClick={() => void dlg.confirm({ title: 'Mail löschen', text: 'In den Papierkorb des Kontos verschieben? Verknüpfungen mit Arbeitspaketen bleiben.', confirmLabel: 'In Papierkorb', danger: true }).then((ok) => { if (ok) folderAction(() => api.post(`/mail/mails/${m.id}/trash`)); })}>Löschen</button>
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Verschieben nach …</option>
            {mailFolders.filter((f) => f.path.toLowerCase() !== m.folder.toLowerCase()).map((f) => <option key={f.path} value={f.path}>{f.specialUse ? FOLDER_LABEL[f.specialUse] : f.path}</option>)}
            <option value="__new">+ neuer Unterordner …</option>
          </select>
          <button className="btn sm" disabled={!moveTo} onClick={() => {
            if (moveTo === '__new') { setNewFolder(true); return; }
            folderAction(() => api.post(`/mail/mails/${m.id}/move`, { folder: moveTo }));
          }}>Verschieben</button>
        </>)}
      </div>
      <div className="row mb">
        <span className="muted small" title="Ohne KI: die Mail selbst wird übernommen">Projekt:</span>
        <span className="muted small">Arbeitspaket</span>
        {enabled('create_task') && <button className="btn sm" onClick={() => setDialog('createTask')}>Erstellen</button>}
        {enabled('link_task') && <button className="btn sm" onClick={() => setDialog('link')}>Verknüpfen / Kopieren</button>}
        <button className="btn sm" disabled={!enabled('task_log')} title={reason('task_log')} onClick={() => setDialog('log')}>Ins Log übernehmen</button>
        <button className="btn sm" disabled={!enabled('task_adjust')} title={reason('task_adjust')} onClick={() => setDialog('adjust')}>Anpassen (Mail als Beleg)</button>
        <span className="muted small" style={{ marginLeft: 8 }}>Doku</span>
        <button className="btn sm" disabled={!enabled('to_page')} title={reason('to_page')} onClick={() => setDialog('toPage')}>Ablegen</button>
        <button className="btn sm" disabled={!enabled('append_page')} title={reason('append_page')} onClick={() => setDialog('appendPage')}>An Seite anhängen</button>
      </div>
      <div className="row mb small">
        <span className="muted" title={suggestAgent ? `${suggestAgent.name} antwortet dir per Direktnachricht im Chat` : 'Kein Agent im Projekt (Projektagent unter Mitglieder oder Agent an der Mail-Ansicht): Ergebnisse erscheinen hier bzw. unter Vorschläge zur Freigabe'}>Agent schlägt vor{suggestAgent ? ` (Antwort im Chat von ${suggestAgent.name})` : ' (kein Agent im Projekt)'}:</span>
        <button className="btn sm" disabled={!suggestAgent || Boolean(aiNo('mail.triage')) || Boolean(m.outgoing)} title={!suggestAgent ? 'Kein Agent im Projekt' : aiNo('mail.triage') ?? `${suggestAgent.name} prüft die Mail und schlägt Arbeitspaket, Termin, Antwort oder Ablage vor; die Vorschläge kommen per Chat, angenommen wird an der Mail`} onClick={() => void run(async () => { const res = await api.post<{ existing: boolean; agent: { name: string } }>(`/mail/mails/${m.id}/ai-suggest`, { projectId: detail.project.id }); setAiMsg(res.existing ? `${res.agent.name} hat zu dieser Mail schon Vorschläge gemacht (unten).` : `${res.agent.name} prüft die Mail und meldet sich per Chat.`); await aiRuns.reload(); })}>Vorschläge zur Mail</button>
        {essAgent.picker}<button className="btn sm" disabled={Boolean(aiNo('assist.essence'))} title={aiNo('assist.essence') ?? 'Vorschlag für Log, Status und Termin; wird erst nach Freigabe angewendet'} onClick={() => setDialog('aiEssence')}>Essenz → Arbeitspaket</button>
        <button className="btn sm" disabled={Boolean(aiNo('assist.essence'))} title={aiNo('assist.essence') ?? 'Abschnitt für Protokoll oder Bericht; wird erst nach Freigabe angehängt'} onClick={() => setDialog('aiMerge')}>Essenz → Seite</button>
        {sumAgent.picker}<button className="btn sm" disabled={Boolean(aiNo('assist.summarize'))} title={aiNo('assist.summarize') ?? 'Kurzfassung der Mail (wird gespeichert)'} onClick={() => void run(async () => { const res = await api.post<{ summary: string; viaChat: string | null }>(`/mail/mails/${m.id}/ai/summarize`, { agentId: sumAgent.agentId }); setSummary(res.summary); if (res.viaChat) setAiMsg(`Zusammenfassung auch per Chat von ${res.viaChat}.`); })}>Zusammenfassen</button>
        <Link className="btn sm link" to={`/projekte/${detail.project.id}/ki`}>Offene Vorschläge</Link>
        {ai && aiReasons.length > 0 && <span className="muted">{aiReasons.join(' · ')}</span>}
      </div>
      <MailAiBox key={m.id} mailId={m.id} accountId={m.accountId} outgoing={Boolean(m.outgoing)} views={views} canCreateTask={r.canCreateTask} data={aiRuns} />
      {summary && <div className="notice mb small" style={{ whiteSpace: 'pre-wrap' }}><strong>Zusammenfassung (KI):</strong> {summary}</div>}
      {aiMsg && <div className="success mb small">{aiMsg} <Link to={`/projekte/${detail.project.id}/ki`}>Offene Vorschläge</Link></div>}
      {(d.data.links.length > 0 || (actions.data?.pages.length ?? 0) > 0) && (
        <p className="small">
          {d.data.links.length > 0 && <>{d.data.links.some((l) => l.origin) ? 'Daraus entstanden / verknüpft' : 'Verknüpft'}: {d.data.links.map((l) => l.projectId === detail.project.id
            ? <button key={l.taskId} className="btn sm link" title={l.origin ? 'Aus dieser Mail entstanden' : undefined} onClick={() => openTask(l.taskId)}><span className="tkey">{l.code}</span> {l.title}{l.origin ? ' · Ursprung' : ''}{l.copied ? ' (Kopie)' : ''}</button>
            : <Link key={l.taskId} className="btn sm link" to={`/projekte/${l.projectId}/board?task=${l.taskId}`}><span className="tkey">{l.code}</span> {l.title}{l.origin ? ' · Ursprung' : ''}</Link>)}</>}
          {(actions.data?.pages.length ?? 0) > 0 && <> · Doku: {actions.data!.pages.map((p) => <Link key={p.pageId} className="btn sm link" to={`/projekte/${detail.project.id}/doku/${p.pageId}`}>{p.title}{p.kind === 'section' ? ' (Abschnitt)' : ''}</Link>)}</>}
        </p>
      )}
      {error && <div className="error mb">{error}</div>}
      {m.textBody ? <pre>{m.textBody}</pre> : m.htmlBody ? <MailHtml html={m.htmlBody} /> : <p className="muted">Kein Inhalt</p>}

      {newFolder && <PromptModal title="Neuer Unterordner" label="Name" placeholder="z. B. Lieferanten" submitLabel="Anlegen und verschieben" onClose={() => setNewFolder(false)}
        onSubmit={(name) => { if (name) folderAction(async () => { const f = await api.post<{ folder: MailFolder }>(`/mail/accounts/${m.accountId}/folders`, { name }); await api.post(`/mail/mails/${m.id}/move`, { folder: f.folder.path }); }); }} />}
      {dialog === 'link' && (
        <Modal title="Mit Arbeitspaket verknüpfen oder kopieren" onClose={() => setDialog(null)}>
          <p className="small muted">Verknüpfen: Wer die Ansicht nicht lesen darf, sieht nur „verknüpfte Mail, keine Berechtigung“. Kopieren: Die Mail wird für alle sichtbar, die das Arbeitspaket lesen dürfen, mit Bestätigung und Audit-Eintrag.</p>
          <table className="table"><tbody>
            {tasks.filter((t) => !t.done).map((t) => <tr key={t.id}><td>{t.title}</td><td className="nowrap"><button className="btn sm" onClick={() => void doLink(t.id, false)}>Verknüpfen</button> <button className="btn sm" disabled={!enabled('copy_task')} onClick={() => void doLink(t.id, true)}>Kopieren</button></td></tr>)}
          </tbody></table>
        </Modal>
      )}
      {dialog === 'log' && <PickTaskDialog title="Ins Arbeitspaket-Log übernehmen" hint="Die Mail wird 1:1 als Log-Eintrag (Zitat) an das Arbeitspaket gehängt und verknüpft. Für eine Essenz: „KI: Essenz → Arbeitspaket“." noteLabel="Eigene Anmerkung (optional)" onClose={() => setDialog(null)}
        onPick={(taskId, note) => withConfirm(
          (confirmed) => api.post(`/mail/mails/${m.id}/to-task-log`, { taskId, note, confirmed }),
          async () => { setDialog(null); await refresh(); openTask(taskId); }
        )} />}
      {dialog === 'aiEssence' && <PickTaskDialog title="Essenz → Arbeitspaket (KI-Vorschlag)" hint="Die KI schlägt einen Log-Eintrag vor und erkennt, ob die Mail einen neuen Status oder Termin belegt. Angewendet wird erst nach Freigabe durch PL oder Personen mit Freigaberecht." onClose={() => setDialog(null)}
        onPick={async (taskId) => { await run(async () => { await api.post(`/mail/mails/${m.id}/ai/essence`, { taskId, agentId: essAgent.agentId }); setDialog(null); setAiMsg('Vorschlag angelegt.'); }); }} />}
      {dialog === 'aiMerge' && <AppendPageDialog ai onClose={() => setDialog(null)} onSubmit={async (pageId) => { await run(async () => { await api.post(`/mail/mails/${m.id}/ai/merge-page`, { pageId, agentId: essAgent.agentId }); setDialog(null); setAiMsg('Vorschlag für die Seite angelegt.'); }); }} />}
      {dialog === 'adjust' && <AdjustTaskDialog mailId={m.id} onClose={() => setDialog(null)} onDone={async (taskId) => { setDialog(null); await refresh(); openTask(taskId); }} />}
      {dialog === 'toPage' && <ToPageDialog onClose={() => setDialog(null)} onSubmit={(folderId, title) => withConfirm(
        (confirmed) => api.post(`/mail/mails/${m.id}/to-page`, { projectId: detail.project.id, folderId, title, confirmed }),
        async (res) => { setDialog(null); await refresh(); nav(`/projekte/${detail.project.id}/doku/${res.page.id}`); }
      )} />}
      {dialog === 'appendPage' && <AppendPageDialog onClose={() => setDialog(null)} onSubmit={(pageId, withBody) => withConfirm(
        (confirmed) => api.post(`/mail/mails/${m.id}/append-to-page`, { pageId, withBody, confirmed }),
        async (res) => { setDialog(null); await refresh(); nav(`/projekte/${detail.project.id}/doku/${res.page.id}`); }
      )} />}
      {confirmCopy && (
        <Modal title="Sichtbarkeit bestätigen" onClose={() => setConfirmCopy(null)}>
          <p>Der Mailinhalt wird dadurch für folgende Personen sichtbar:</p>
          <ul>{confirmCopy.willSee.map((w) => <li key={w.name}>{w.name} <span className="badge">{roleLabel[w.role]}</span></li>)}</ul>
          <div className="row"><button className="btn primary" onClick={() => void run(confirmCopy.run)}>Bestätigen und protokollieren</button><button className="btn" onClick={() => setConfirmCopy(null)}>Abbrechen</button></div>
        </Modal>
      )}
      {dialog === 'createTask' && <CreateTaskFromMail mail={m} askConfirm={(willSee, go) => setConfirmCopy({ willSee, run: async () => { await go(); setConfirmCopy(null); } })} onClose={() => setDialog(null)} onCreated={async (id) => { setDialog(null); await refresh(); nav(`/projekte/${detail.project.id}/board?task=${id}`); }} />}
    </div>
  );
}

/**
 * HTML-Mail isoliert anzeigen: bereinigt (DOMPurify) in einem Sandbox-iframe ohne Skripte und mit eigener Herkunft;
 * eine Content-Security-Policy im Dokument blockt externe Bilder (Tracking-Pixel), bis man sie zulässt.
 */
export function MailHtml({ html }: { html: string }) {
  const [images, setImages] = useState(false);
  const clean = useMemo(() => DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false, FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed', 'base', 'meta', 'link'] }), [html]);
  const remote = /\bsrc\s*=\s*["']?\s*(https?:)?\/\//i.test(clean) || /url\(\s*["']?\s*(https?:)?\/\//i.test(clean);
  const csp = `default-src 'none'; img-src data: cid:${images ? ' https: http:' : ''}; style-src 'unsafe-inline'; font-src data:`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>html{background:#fff;color:#1f2937}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;margin:8px;word-break:break-word}img{max-width:100%;height:auto}</style></head><body>${clean}</body></html>`;
  return (
    <>
      {remote && !images && <div className="notice small mb">Externe Bilder sind blockiert (Schutz vor Tracking). <button className="btn sm link" onClick={() => setImages(true)}>Bilder laden</button></div>}
      <iframe className="mail-html" title="Mailinhalt" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={doc} />
    </>
  );
}

function PickTaskDialog({ title, hint, noteLabel, onClose, onPick }: { title: string; hint: string; noteLabel?: string; onClose: () => void; onPick: (taskId: string, note: string) => Promise<void> }) {
  const { tasks } = useProject();
  const [taskId, setTaskId] = useState(tasks.find((t) => !t.done)?.id ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="form">
        <p className="muted small">{hint}</p>
        <label className="field"><span>Arbeitspaket</span><select value={taskId} onChange={(e) => setTaskId(e.target.value)}>{tasks.map((t) => <option key={t.id} value={t.id}>{t.done ? '✓ ' : ''}{t.title}</option>)}</select></label>
        {noteLabel && <label className="field"><span>{noteLabel}</span><textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>}
        <div><button className="btn primary" disabled={busy || !taskId} onClick={() => { setBusy(true); void onPick(taskId, note).finally(() => setBusy(false)); }}>Übernehmen</button></div>
      </div>
    </Modal>
  );
}

function AdjustTaskDialog({ mailId, onClose, onDone }: { mailId: string; onClose: () => void; onDone: (taskId: string) => Promise<void> }) {
  const { detail, tasks } = useProject();
  const [taskId, setTaskId] = useState(tasks.find((t) => !t.done)?.id ?? '');
  const task = tasks.find((t) => t.id === taskId);
  const [columnId, setColumnId] = useState(task?.columnId ?? '');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [note, setNote] = useState('');
  const { busy, error, run } = useAsync();
  const pick = (id: string) => { setTaskId(id); const t = tasks.find((x) => x.id === id); setColumnId(t?.columnId ?? ''); setDueDate(t?.dueDate ?? ''); };
  return (
    <Modal title="Arbeitspaket anpassen – Mail als Beleg" onClose={onClose}>
      <div className="form">
        <p className="muted small">Status oder Deadline ändern; die Mail wird verknüpft und die Änderung mit Bezug im Arbeitspaket-Log festgehalten.</p>
        <label className="field"><span>Arbeitspaket</span><select value={taskId} onChange={(e) => pick(e.target.value)}>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
        <label className="field"><span>Status</span><select value={columnId} onChange={(e) => setColumnId(e.target.value)}>{detail.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>Deadline</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
        <label className="field"><span>Begründung (optional)</span><textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={busy || !taskId} onClick={() => void run(async () => {
          const body: Record<string, unknown> = { sourceMailId: mailId, note };
          if (task && columnId !== task.columnId) body.columnId = columnId;
          if (task && (dueDate || null) !== task.dueDate) body.dueDate = dueDate || null;
          await api.patch(`/tasks/${taskId}`, body);
          await onDone(taskId);
        })}>Speichern</button></div>
      </div>
    </Modal>
  );
}

function ToPageDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (folderId: string | null, title: string) => Promise<void> }) {
  const { detail } = useProject();
  const docs = useData<{ folders: DocFolder[] }>(`/projects/${detail.project.id}/docs`);
  const [folderId, setFolderId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (docs.data && !folderId) setFolderId(docs.data.folders.find((f) => f.name === 'Allgemein')?.id ?? docs.data.folders[0]?.id ?? ''); }, [docs.data]);
  return (
    <Modal title="In Doku ablegen" onClose={onClose}>
      <div className="form">
        <p className="muted small">Die Mail wird 1:1 als neue Seite (Entwurf) im gewählten Ordner abgelegt. Der Inhalt wird für alle Projektmitglieder sichtbar.</p>
        <label className="field"><span>Ordner</span><select value={folderId} onChange={(e) => setFolderId(e.target.value)}><option value="">– ohne –</option>{docs.data?.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label className="field"><span>Titel (leer = „Mail: Betreff“)</span><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div><button className="btn primary" disabled={busy} onClick={() => { setBusy(true); void onSubmit(folderId || null, title).finally(() => setBusy(false)); }}>Ablegen</button></div>
      </div>
    </Modal>
  );
}

function AppendPageDialog({ onClose, onSubmit, ai = false }: { onClose: () => void; onSubmit: (pageId: string, withBody: boolean) => Promise<void>; ai?: boolean }) {
  const { detail } = useProject();
  const docs = useData<{ pages: DocPage[]; folders: DocFolder[] }>(`/projects/${detail.project.id}/docs`);
  const [pageId, setPageId] = useState('');
  const [withBody, setWithBody] = useState(true);
  const [busy, setBusy] = useState(false);
  const open = (docs.data?.pages ?? []).filter((p) => p.status !== 'final');
  useEffect(() => { if (open.length && !pageId) setPageId(open[0].id); }, [docs.data]);
  return (
    <Modal title={ai ? 'Essenz → Seite (KI-Vorschlag)' : 'An Seite anhängen'} onClose={onClose}>
      <div className="form">
        <p className="muted small">{ai ? 'Die KI formuliert aus der Mail einen Abschnitt im Stil der Seite (Entscheidungen, Zusagen, Termine, offene Punkte). Angehängt wird erst nach Freigabe.' : 'Die Mail wird als Abschnitt an das Ende einer Seite gehängt, z. B. unter ein Jour-fixe-Protokoll oder einen Report. Finale Seiten sind gesperrt.'}</p>
        <label className="field"><span>Seite</span><select value={pageId} onChange={(e) => setPageId(e.target.value)}>{open.map((p) => <option key={p.id} value={p.id}>{docs.data?.folders.find((f) => f.id === p.folderId)?.name ?? '–'} / {p.title} ({statusLabel[p.status]})</option>)}</select></label>
        {!ai && <label className="check"><input type="checkbox" checked={withBody} onChange={(e) => setWithBody(e.target.checked)} /> Mailtext als Zitat übernehmen (sonst nur Kopfdaten)</label>}
        <div><button className="btn primary" disabled={busy || !pageId} onClick={() => { setBusy(true); void onSubmit(pageId, withBody).finally(() => setBusy(false)); }}>{ai ? 'Vorschlag erzeugen' : 'Anhängen'}</button></div>
      </div>
    </Modal>
  );
}

/** Arbeitspaket aus einer Mail; fragt nach, wenn der Mailinhalt dadurch für Mitglieder ohne Leserecht sichtbar wird. */
function CreateTaskFromMail({ mail, askConfirm, onClose, onCreated }: { mail: MailDetail; askConfirm: (willSee: { name: string; role: string }[], go: () => Promise<void>) => void; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const { detail, users } = useProject();
  const [f, setF] = useState({ title: mail.subject.replace(/^(re|aw|fwd|wg):\s*/i, ''), subprojectId: '', dueDate: '', responsibleUserId: '', responsibleEmail: '', copy: false });
  const { busy, error, run } = useAsync();
  const isPl = detail.project.myMembership.role === 'pl';
  const members = users.filter((u) => detail.members.some((m) => m.userId === u.id) && (u.kind !== 'agent' || isPl));
  return (
    <Modal title="Arbeitspaket aus Mail" onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Titel</span><input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field"><span>Teilprojekt</span><select value={f.subprojectId} onChange={(e) => setF({ ...f, subprojectId: e.target.value })}><option value="">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>Deadline</span><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
        <label className="field"><span>Zuständig</span><select value={f.responsibleUserId} onChange={(e) => setF({ ...f, responsibleUserId: e.target.value })}><option value="">– geerbt –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field"><span>oder extern</span><input type="email" value={f.responsibleEmail} onChange={(e) => setF({ ...f, responsibleEmail: e.target.value })} placeholder={mail.fromAddr} /></label>
        <label className="check full"><input type="checkbox" checked={f.copy} onChange={(e) => setF({ ...f, copy: e.target.checked })} /> Mail als Kopie in das Arbeitspaket übernehmen (dann gelten die Arbeitspaketrechte)</label>
        <p className="muted small full">Beschreibung wird aus dem Mailtext vorbefüllt.</p>
        {error && <div className="error full">{error}</div>}
        <div className="row full"><button className="btn primary" disabled={busy} onClick={() => void run(async () => {
          const body = { projectId: detail.project.id, title: f.title, subprojectId: f.subprojectId || null, dueDate: f.dueDate || null, responsibleUserId: f.responsibleUserId || null, responsibleEmail: f.responsibleEmail || null, copy: f.copy };
          const r = await api.post<{ task?: { id: string }; needsConfirmation?: boolean; willSee?: { name: string; role: string }[] }>(`/mail/mails/${mail.id}/create-task`, body);
          if (r.needsConfirmation) { askConfirm(r.willSee ?? [], async () => { const r2 = await api.post<{ task: { id: string } }>(`/mail/mails/${mail.id}/create-task`, { ...body, confirmed: true }); await onCreated(r2.task.id); }); return; }
          await onCreated(r.task!.id);
        })}>Arbeitspaket anlegen</button></div>
      </div>
    </Modal>
  );
}

/** Neue Mail, Antwort oder Abschluss-Antwort; an Externe vor dem Senden Hinweise der Außenprüfung (kein Block). */
export function Compose({ views, onDone }: { views: ViewRow[]; onDone: () => void }) {
  const { detail, tasks } = useProject();
  const [params] = useSearchParams();
  const replyTo = params.get('reply');
  // Arbeitspaket als „ap“ (nicht „task“: das öffnet im Projekt den Drawer über dem Formular)
  const taskParam = params.get('ap') ?? params.get('task');
  // Abschluss-Antwort auf die Ursprungsmail eines Arbeitspakets (aufbereitetes Ergebnis, optional mit KI)
  const final = params.get('final') === '1';
  const [finalInfo, setFinalInfo] = useState<string | null>(final ? 'Antwort wird vorbereitet …' : null);
  // KI-Text an Externe: Fundstellen der Außenprüfung nur als Hinweis
  const [hints, setHints] = useState<{ audience: AudienceClass; findings: OutboundFinding[] } | null>(null);
  // Schreibbare Ansichten, das Standard-Projektkonto (Projekt-Mailadresse) zuerst
  const writable = views.filter((v) => v.myRights.canDraft || v.myRights.canSend).sort((a, b) => Number(b.accountAddress === detail.project.mailAddress) - Number(a.accountAddress === detail.project.mailAddress));
  const [f, setF] = useState({ viewId: params.get('view') ?? writable[0]?.id ?? '', taskId: taskParam ?? '', to: params.get('to') ?? '', cc: '', subject: params.get('subject') ?? '', body: params.get('body') ?? '', inReplyTo: '' as string | null });
  // Eigene Mail an Externe: Fundstellen der Außenprüfung vor dem Senden als Hinweis, gesendet wird trotzdem auf Wunsch
  const [check, setCheck] = useState<{ audience: AudienceClass; findings: OutboundFinding[] } | null>(null);
  const { busy, error, run } = useAsync();
  // Ansichten laden asynchron: erste schreibbare Ansicht nachziehen, sobald sie da ist
  useEffect(() => { if (!f.viewId && writable[0]) setF((x) => ({ ...x, viewId: writable[0].id })); }, [writable.length]);
  useEffect(() => setCheck(null), [f.to, f.cc, f.subject, f.body, f.taskId]);
  useEffect(() => {
    if (final && taskParam) {
      api.get<{ mailId: string; viewId: string | null; to: string[]; subject: string; inReplyTo: string | null; body: string; answered: boolean; draftOpen: boolean; outbound: { audience: AudienceClass; findings: OutboundFinding[] } | null }>(`/tasks/${taskParam}/final-reply${params.get('ai') === '1' ? `?ai=1${params.get('agent') ? `&agent=${encodeURIComponent(params.get('agent')!)}` : ''}` : ''}`).then(async (r) => {
        setHints(r.outbound?.findings.length ? r.outbound : null);
        const { mail } = await api.get<{ mail: MailDetail }>(`/mail/mails/${r.mailId}`);
        setF((x) => ({ ...x, viewId: r.viewId ?? x.viewId, to: r.to.join(', '), subject: r.subject, inReplyTo: r.inReplyTo, taskId: taskParam,
          body: `${r.body}\n\n---\nAm ${fmtDateTime(mail.date)} schrieb ${mail.fromName ?? mail.fromAddr}:\n${(mail.textBody ?? '').split('\n').map((l) => `> ${l}`).join('\n')}` }));
        setFinalInfo(!r.viewId ? 'Keine Ansicht mit Entwurfsrecht für das Konto der Ursprungsmail: Ansicht unten bitte prüfen.' : r.answered ? 'Hinweis: Die Ursprungsmail wurde bereits beantwortet.' : r.draftOpen ? 'Hinweis: Eine Antwort auf die Ursprungsmail liegt schon als Entwurf vor.' : null);
      }).catch((e) => setFinalInfo(String(e?.message ?? e)));
    } else if (replyTo) {
      api.get<{ mail: MailDetail }>(`/mail/mails/${replyTo}`).then(({ mail }) => {
        setF((x) => ({ ...x, to: mail.fromAddr, subject: mail.subject.startsWith('Re:') ? mail.subject : `Re: ${mail.subject}`, inReplyTo: mail.messageId, taskId: x.taskId || (mail.linkedTaskIds[0] ?? ''),
          body: `\n\n---\nAm ${fmtDateTime(mail.date)} schrieb ${mail.fromName ?? mail.fromAddr}:\n${(mail.textBody ?? '').split('\n').map((l) => `> ${l}`).join('\n')}` }));
      }).catch(() => undefined);
    } else if (taskParam && !params.get('subject')) {
      const t = tasks.find((x) => x.id === taskParam);
      if (t) setF((x) => ({ ...x, to: t.responsible.email && !t.responsible.userId ? t.responsible.email : '', subject: `${detail.project.key}: ${t.title}`, body: `Guten Tag,\n\nzum Arbeitspaket „${t.title}“${t.dueDate ? ` (fällig ${t.dueDate.split('-').reverse().join('.')})` : ''}:\n\n\n\nMit freundlichen Grüßen\n` }));
    }
  }, [replyTo, taskParam, final]);
  const view = views.find((v) => v.id === f.viewId);
  if (writable.length === 0) return <div className="mail-detail"><div className="empty">Du hast an keiner Ansicht ein Entwurfs- oder Senderecht.</div></div>;
  const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const save = async (send: boolean) => { await api.post('/mail/drafts', { viewId: f.viewId, projectId: detail.project.id, taskId: f.taskId || null, to: split(f.to), cc: split(f.cc), subject: f.subject, body: f.body, inReplyTo: f.inReplyTo, send }); onDone(); };
  const trySend = () => run(async () => {
    const r = await api.post<{ outbound: { audience: AudienceClass; findings: OutboundFinding[] } | null }>(`/projects/${detail.project.id}/outbound-hint`, { taskId: f.taskId || null, to: split(f.to), cc: split(f.cc), subject: f.subject, body: f.body });
    if (r.outbound?.findings.length) { setCheck(r.outbound); return; }
    await save(true);
  });
  return (
    <div className="mail-detail">
      <h2>{final ? 'Antwort auf die Ursprungsmail' : replyTo ? 'Antwort' : 'Neue Mail'}</h2>
      {final && <p className="muted small">Aufbereitetes Ergebnis für den Absender, bitte prüfen und ergänzen. Die Mail hängt danach am Arbeitspaket, ein Log-Eintrag entsteht nicht.</p>}
      {finalInfo && <div className="notice small mb">{finalInfo}</div>}
      {hints && <div className="notice small mb"><strong>Hinweise der Außenprüfung</strong> ({AUDIENCE_LABEL[hints.audience]}): Der KI-Text nennt Inhalte, die Externe nicht erfahren sollen. Bitte prüfen; gesendet wird nur, was du freigibst.<Findings findings={hints.findings} /></div>}
      <div className="form">
        <label className="field"><span>Senden über Ansicht / Konto</span>
          <select value={f.viewId} onChange={(e) => setF({ ...f, viewId: e.target.value })}>{writable.map((v) => <option key={v.id} value={v.id}>{v.name} – {v.accountAddress}{v.myRights.canSend ? '' : ' (nur Entwurf, Versand nach Freigabe)'}</option>)}</select></label>
        <label className="field"><span>Zu Arbeitspaket (setzt Antwortadresse mit Arbeitspaket-Code)</span>
          <select value={f.taskId} onChange={(e) => setF({ ...f, taskId: e.target.value })}><option value="">– keine –</option>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
        <label className="field"><span>An</span><input type="text" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="mehrere mit Komma" /></label>
        <label className="field"><span>Cc</span><input type="text" value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} /></label>
        <label className="field"><span>Betreff</span><input type="text" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
        <label className="field"><span>Text</span><textarea style={{ minHeight: 240 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        {view?.accountType === 'personal' && !view.myRights.canSend && <div className="notice small">Aus persönlichen Konten sendet nur der Eigentümer. Dein Entwurf geht an ihn zur Freigabe.</div>}
        {error && <div className="error">{error}</div>}
        {check && (
          <div className="notice small">
            <strong>Hinweise der Außenprüfung</strong> ({AUDIENCE_LABEL[check.audience]}): Die Mail nennt Inhalte, die Externe nicht erfahren sollen. Du entscheidest selbst.
            <Findings findings={check.findings} />
            <div className="row mt">
              <button className="btn sm primary" disabled={busy} onClick={() => void run(() => save(true))}>{view?.myRights.canSend ? 'Trotzdem senden' : 'Trotzdem einreichen'}</button>
              <button className="btn sm" disabled={busy} onClick={() => setCheck(null)}>Bearbeiten</button>
            </div>
          </div>
        )}
        <div className="row">
          <button className="btn primary" disabled={busy || !f.to || !f.subject || Boolean(check)} onClick={() => void trySend()}>
            {view?.myRights.canSend ? 'Senden' : 'Zur Freigabe einreichen'}
          </button>
          <button className="btn" disabled={busy || !f.to || !f.subject} onClick={() => void run(() => save(false))}>Als Entwurf speichern</button>
        </div>
      </div>
    </div>
  );
}

/** Zur Freigabe: Entwürfe aller Projekte (KI-Agenten und Personen), wartende zuerst; mit Projektfilter auch die von der Außenprüfung angehaltenen Mails. */
function DraftsPanel({ drafts, reload, projectId }: { drafts: MailDraft[]; reload: () => Promise<void>; projectId: string }) {
  const { error, run } = useAsync();
  const [edit, setEdit] = useState<MailDraft | null>(null);
  const groups: [string, string][] = [['pending_approval', 'Wartet auf Freigabe'], ['draft', 'Entwürfe'], ['failed', 'Fehlgeschlagen'], ['sent', 'Gesendet']];
  // Von der Außenprüfung angehaltene Entwürfe stehen oben mit ihren Fundstellen
  const held = (d: MailDraft) => d.outbound?.result === 'held' && !d.outbound.decided && d.outbound.channel !== 'draft';
  return (
    <div className="mail-detail">
      <h2>Zur Freigabe</h2>
      <p className="muted small">Antwortentwürfe der KI-Agenten und Entwürfe ohne Senderecht. Freigeben darf, wer an der Ansicht das Senderecht hat; alles steht im Audit-Log.</p>
      {error && <div className="error mb">{error}</div>}
      {projectId && <ProjectScope projectId={projectId}><OutboundHeld onChanged={reload} /></ProjectScope>}
      {groups.map(([status, label]) => {
        const rows = drafts.filter((d) => d.status === status && !(status !== 'sent' && held(d)));
        if (!rows.length) return null;
        return (
          <div key={status} className="card mb">
            <h3>{label} <span className="badge">{rows.length}</span></h3>
            <table className="table"><tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>{d.projectKey && <span className="badge" style={{ marginRight: 6 }}>{d.projectKey}</span>}<strong>{d.subject}</strong><div className="muted small">an {d.toAddrs.join(', ')} · von {d.userName}{d.byAgent ? ' (KI-Agent)' : ''} · {fmtDateTime(d.createdAt)}</div>{d.error && <div className="error small mt">{d.error}</div>}{status !== 'sent' && (d.outbound?.findings.length ?? 0) > 0 && <div className="small mt" style={{ color: 'var(--warn)' }} title={d.outbound!.findings.map((f) => f.text).join('\n')}>Hinweise der Außenprüfung: {d.outbound!.findings.length}</div>}</td>
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
          {(edit.outbound?.findings.length ?? 0) > 0 && <div className="notice small mb"><strong>Hinweise der Außenprüfung</strong> ({AUDIENCE_LABEL[edit.outbound!.audience]}): bitte vor dem Senden prüfen.<Findings findings={edit.outbound!.findings} withheld={edit.outbound!.withheld} /></div>}
          <EditDraft draft={edit} onSaved={async () => { setEdit(null); await reload(); }} />
        </Modal>
      )}
    </div>
  );
}

/** Fundstellen der Außenprüfung und, bei Agenten-Mails, was die Neuformulierung zurückgehalten hat. */
function Findings({ findings, withheld }: { findings: OutboundFinding[]; withheld?: string[] }) {
  return <>
    {findings.length > 0 && <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{findings.map((f, i) => <li key={i}>{f.text}</li>)}</ul>}
    {(withheld?.length ?? 0) > 0 && <div className="muted">Zurückgehalten: {withheld!.join('; ')}</div>}
  </>;
}

const CHANNEL_LABEL: Record<string, string> = { mail: 'Mail', reply_origin: 'Antwort auf die Ursprungsmail', pdf: 'PDF-Versand', draft: 'Entwurf', chat: 'Chat' };

/**
 * Außenprüfung angehalten: Mails von KI-Agenten an Externe mit Fundstellen. Bearbeiten und senden, unverändert senden
 * (Menschen werden von Fundstellen nicht blockiert) oder ablehnen; genannte Seiten lassen sich dabei für die Empfänger
 * freigeben (PL oder „Final setzen / Versand“).
 */
export function OutboundHeld({ onChanged }: { onChanged: () => Promise<void> }) {
  const { detail } = useProject();
  const me = detail.project.myMembership;
  const held = useData<{ checks: OutboundCheck[] }>(`/projects/${detail.project.id}/outbound-checks?result=held`);
  const rows = held.data?.checks ?? [];
  if (!rows.length) return null;
  return (
    <div className="card mb">
      <h3>Außenprüfung angehalten <span className="badge warn">{rows.length}</span></h3>
      <p className="muted small">Agenten-Mails an Nicht-Interne, in denen die Prüfung Projektinternes gefunden hat (andere Arbeitspakete, Teilprojekte, nicht freigegebene Seiten, interne Adressen, Links ins Tool). Nichts ist gesendet.</p>
      {rows.map((c) => <HeldCheck key={c.id} check={c} canShare={me.role === 'pl' || me.canFinalize} onDone={async () => { await held.reload(); await onChanged(); }} />)}
    </div>
  );
}

function HeldCheck({ check, canShare, onDone }: { check: OutboundCheck; canShare: boolean; onDone: () => Promise<void> }) {
  const d = check.draft!;
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(d.subject);
  const [body, setBody] = useState(d.body);
  const [share, setShare] = useState<string[]>([]);
  const { busy, error, run } = useAsync();
  const pages = check.findings.filter((f) => f.kind === 'page' && f.pageId);
  const externals = check.recipients.filter((r) => r.audience !== 'internal').map((r) => r.email).join(', ');
  const decide = (action: 'release' | 'edit' | 'block') => run(async () => { await api.post(`/outbound-checks/${check.id}/decide`, { action, ...(action === 'edit' ? { subject, body } : {}), sharePageIds: action === 'block' ? [] : share }); await onDone(); });
  return (
    <div className="mb" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <div><strong>{d.subject}</strong> <span className="badge">{CHANNEL_LABEL[check.channel] ?? check.channel}</span> <span className="badge">{AUDIENCE_LABEL[check.audience]}</span></div>
      <div className="muted small">an {d.toAddrs.join(', ')} · von {d.userName}{check.taskRef ? ` · ${check.taskRef} „${check.taskTitle}“` : ''} · {fmtDateTime(check.createdAt)}{d.pageTitle ? ` · Anhang „${d.pageTitle}“ (PDF)` : ''}</div>
      <div className="notice small mt"><strong>Fundstellen</strong><Findings findings={check.findings} withheld={check.withheld} /></div>
      {canShare && pages.map((f) => (
        <label key={f.pageId} className="check small"><input type="checkbox" checked={share.includes(f.pageId!)} onChange={(e) => setShare(e.target.checked ? [...share, f.pageId!] : share.filter((x) => x !== f.pageId))} /> Seite „{f.match}“ für {externals} freigeben (nur lesen)</label>
      ))}
      {editing ? (
        <div className="form mt">
          <label className="field"><span>Betreff</span><input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className="field"><span>Text</span><textarea style={{ minHeight: 180 }} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        </div>
      ) : <div className="small mt" style={{ whiteSpace: 'pre-wrap' }}>{d.body}</div>}
      {error && <div className="error small mt">{error}</div>}
      <div className="row mt">
        {editing
          ? <button className="btn sm primary" disabled={busy || !subject.trim()} onClick={() => void decide('edit')}>Senden</button>
          : <button className="btn sm primary" disabled={busy} onClick={() => setEditing(true)}>Bearbeiten und senden</button>}
        {!editing && <button className="btn sm" disabled={busy} title="Die Fundstellen sind geprüft und dürfen hinaus" onClick={() => void decide('release')}>Unverändert senden</button>}
        <button className="btn sm danger" disabled={busy} onClick={() => void decide('block')}>Ablehnen</button>
      </div>
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

export function NewView({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { detail } = useProject();
  const accounts = useData<{ accounts: MailAccount[]; personalAccounts: MailAccount[] }>(`/projects/${detail.project.id}/mail/accounts`);
  const [f, setF] = useState({ accountId: '', name: '', folders: '', from: '', to: '', subject: '', keyword: '', since: '', memberRead: true, memberDraft: true, memberTask: true, readerRead: false });
  const { busy, error, run } = useAsync();
  const isPl = detail.project.myMembership.role === 'pl';
  // Projektkonten (nur PL) über ihre Projektbindung, eigene Konten über die persönliche Bindung
  const usable = [...(isPl ? (accounts.data?.accounts ?? []).map((a) => ({ ...a, via: 'Projektkonto' })) : []), ...(accounts.data?.personalAccounts ?? []).filter((a) => !(accounts.data?.accounts ?? []).some((x) => x.id === a.id)).map((a) => ({ ...a, via: 'persönlich' }))];
  return (
    <Modal title="Neue Mail-Ansicht" onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Konto</span>
          <select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}><option value="">– wählen –</option>{usable.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.address}) – {a.via}</option>)}</select></label>
        {usable.length === 0 && <p className="notice small full">Kein Konto verfügbar. Lege unter Meine Einstellungen › Mail ein eigenes Konto an oder binde als PL ein Projektkonto an (Projekt › Einstellungen › Mail).</p>}
        <label className="field full"><span>Name der Ansicht</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Kunde Müller" /></label>
        <label className="field"><span>Absender (Adresse oder @domain, Komma)</span><input type="text" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="@mueller-design.de" /></label>
        <label className="field"><span>Empfänger enthält</span><input type="text" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="field"><span>Betreff enthält</span><input type="text" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
        <label className="field"><span>Stichwort im Text</span><input type="text" value={f.keyword} onChange={(e) => setF({ ...f, keyword: e.target.value })} /></label>
        <label className="field"><span>Ordner (leer = INBOX)</span><input type="text" value={f.folders} onChange={(e) => setF({ ...f, folders: e.target.value })} placeholder="INBOX, Sent" /></label>
        <label className="field"><span>Ab Datum</span><input type="date" value={f.since} onChange={(e) => setF({ ...f, since: e.target.value })} /></label>
        <div className="full"><strong className="small">Rechte für Rollen</strong> <span className="muted small">(du selbst erhältst alle Rechte; über eine persönliche Bindung sendest nur du)</span></div>
        <label className="check"><input type="checkbox" checked={f.memberRead} onChange={(e) => setF({ ...f, memberRead: e.target.checked })} /> Mitglieder lesen</label>
        <label className="check"><input type="checkbox" checked={f.memberDraft} onChange={(e) => setF({ ...f, memberDraft: e.target.checked })} /> Mitglieder entwerfen</label>
        <label className="check"><input type="checkbox" checked={f.memberTask} onChange={(e) => setF({ ...f, memberTask: e.target.checked })} /> Mitglieder: Arbeitspaket erzeugen</label>
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

interface RightRow { id?: string; userId: string | null; userName?: string | null; role: string | null; groupId?: string | null; groupName?: string | null; canRead: boolean; canDraft: boolean; canSend: boolean; canAi: boolean; canCreateTask: boolean }

export function RightsEditor({ view, onClose, onChanged }: { view: ViewRow; onClose: () => void; onChanged: () => void }) {
  const { detail } = useProject();
  const [rows, setRows] = useState<RightRow[] | null>(null);
  const [addUser, setAddUser] = useState('');
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  useEffect(() => { api.get<{ rights: RightRow[] }>(`/mail/views/${view.id}/rights`).then((r) => setRows(r.rights)); }, [view.id]);
  const flags: [keyof RightRow, string][] = [['canRead', 'Lesen'], ['canDraft', 'Entwurf'], ['canSend', 'Senden'], ['canCreateTask', 'Arbeitspaket'], ['canAi', 'KI']];
  const [filterEdit, setFilterEdit] = useState(false);
  if (!rows) return null;
  const groups = useData<{ groups: Group[] }>('/groups');
  const label = (r: RightRow) => (r.userId ? r.userName ?? detail.members.find((m) => m.userId === r.userId)?.name ?? '?' : r.groupId ? `Gruppe ${r.groupName ?? groups.data?.groups.find((g) => g.id === r.groupId)?.name ?? '?'}` : `Rolle ${roleLabel[r.role!]}`);
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
          {(groups.data?.groups ?? []).filter((g) => !rows.some((r) => r.groupId === g.id)).map((g) => <option key={g.id} value={`group:${g.id}`}>Gruppe {g.name}</option>)}
        </select>
        <button className="btn sm" disabled={!addUser} onClick={() => { const [kind, id] = addUser.split(':'); setRows([...rows, { userId: kind === 'user' ? id : null, role: kind === 'role' ? id : null, groupId: kind === 'group' ? id : null, canRead: true, canDraft: false, canSend: false, canAi: false, canCreateTask: false }]); setAddUser(''); }}>Hinzufügen</button>
        <button className="btn sm right" onClick={() => setFilterEdit(true)}>Filter bearbeiten</button>
      </div>
      {view.accountType === 'personal' && <p className="muted small mt">Ansicht über eine persönliche Bindung: Senden bleibt beim Eigentümer.</p>}
      {error && <div className="error mt">{error}</div>}
      <div className="row mt">
        <button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.put(`/mail/views/${view.id}/rights`, { rights: rows }); onChanged(); onClose(); })}>Speichern</button>
        <button className="btn danger right" onClick={() => void dialog.confirm({ title: 'Ansicht entfernen', text: 'Mails dieser Ansicht verschwinden aus dem Projekt, Kopien in Arbeitspaketen bleiben.', confirmLabel: 'Entfernen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/mail/views/${view.id}`); onChanged(); onClose(); }); })}>Ansicht entfernen</button>
      </div>
      {filterEdit && <FilterEditor view={view} onClose={() => setFilterEdit(false)} onSaved={() => { setFilterEdit(false); onChanged(); }} />}
    </Modal>
  );
}

export function FilterEditor({ view, onClose, onSaved }: { view: ViewRow; onClose: () => void; onSaved: () => void }) {
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
        <p className="muted small full">Nach dem Speichern werden die Treffer neu berechnet; Mails, die keine Ansicht mehr treffen, werden gelöscht (Kopien in Arbeitspaketen bleiben).</p>
        {error && <div className="error full">{error}</div>}
        <div className="full"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.patch(`/mail/views/${view.id}`, { name: f.name, filter: { folders: f.folders, from: f.from, to: f.to, subject: f.subject, keyword: f.keyword, since: f.since || null } }); onSaved(); })}>Speichern</button></div>
      </div>
    </Modal>
  );
}

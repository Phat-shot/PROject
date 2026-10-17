import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { RaidItem, RaidKind } from '@projekttool/shared';
import { api, fmtDate } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync, useDialog } from '../../components/ui';
import { useProject } from '../ProjectPage';
import { InlineText } from './TaskDrawer';

const KIND_LABEL: Record<RaidKind, string> = { risk: 'Risiko', assumption: 'Annahme', issue: 'Issue', decision: 'Entscheidung' };
const STATUS_LABEL = { open: 'offen', mitigated: 'in Behandlung', closed: 'geschlossen' } as const;
const scoreClass = (s: number | null) => (s == null ? '' : s >= 15 ? 'high' : s >= 8 ? 'mid' : 'low');

/**
 * RAID-Register: Risiken (Wahrscheinlichkeit × Auswirkung), Annahmen, Issues, Entscheidungen.
 * Inline editierbar, Matrix als Einstieg, Verknüpfung zu Arbeitspaket oder Seite optional.
 */
export function RaidView() {
  const { detail, tasks, openTask } = useProject();
  const pid = detail.project.id;
  const me = detail.project.myMembership;
  const canEdit = me.role !== 'reader';
  const d = useData<{ items: RaidItem[] }>(`/projects/${pid}/raid`);
  const [params, setParams] = useSearchParams();
  const kind = (params.get('art') ?? '') as RaidKind | '';
  const showClosed = params.get('geschlossen') === '1';
  const cell = params.get('zelle') ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const [create, setCreate] = useState<RaidKind | null>(null);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  const items = d.data?.items ?? [];
  const list = useMemo(() => items.filter((x) => (!kind || x.kind === kind) && (showClosed || x.status !== 'closed') && (!cell || `${x.probability}-${x.impact}` === cell) && (!params.get('nr') || String(x.number) === params.get('nr'))), [items, kind, showClosed, cell, params]);
  const patch = (x: RaidItem, body: Partial<RaidItem>) => run(async () => { await api.patch(`/projects/${pid}/raid/${x.id}`, body); await d.reload(); });
  const members = detail.members;
  const counts = { risk: 0, assumption: 0, issue: 0, decision: 0 } as Record<RaidKind, number>;
  for (const x of items) if (x.status !== 'closed') counts[x.kind]++;
  const matrix = new Map<string, number>();
  for (const x of items) if (x.kind === 'risk' && x.status !== 'closed' && x.probability && x.impact) matrix.set(`${x.probability}-${x.impact}`, (matrix.get(`${x.probability}-${x.impact}`) ?? 0) + 1);
  return (
    <div className="content">
      <div className="filterbar">
        <button className={`chip ${!kind ? 'on' : ''}`} onClick={() => set('art', '')}>Alle</button>
        {(Object.keys(KIND_LABEL) as RaidKind[]).map((k) => <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => set('art', kind === k ? '' : k)}>{KIND_LABEL[k]} <span className="muted">{counts[k]}</span></button>)}
        <label className="check small"><input type="checkbox" checked={showClosed} onChange={(e) => set('geschlossen', e.target.checked ? '1' : '')} /> geschlossene zeigen</label>
        {(cell || params.get('nr')) && <button className="chip" onClick={() => { set('zelle', ''); set('nr', ''); }}>Filter löschen</button>}
        {canEdit && <span className="row right" style={{ gap: 4 }}>{(Object.keys(KIND_LABEL) as RaidKind[]).map((k) => <button key={k} className="btn sm" onClick={() => setCreate(k)}>+ {KIND_LABEL[k]}</button>)}</span>}
      </div>
      {error && <div className="error mb">{error}</div>}
      <div className="grid cols-2 mb" style={{ gridTemplateColumns: 'minmax(0, 1fr) 380px' }}>
        <div className="card">
          {d.data && list.length === 0 && <div className="empty">Keine Einträge.</div>}
          {list.length > 0 && (
            <table className="table raid-table"><thead><tr><th>Nr.</th><th>Art</th><th>Titel</th><th title="Wahrscheinlichkeit">W</th><th title="Auswirkung">A</th><th>Score</th><th>Status</th><th>Verantwortlich</th><th>Termin</th><th /></tr></thead><tbody>
              {list.map((x) => (
                <tr key={x.id} className="inline-row" style={x.status === 'closed' ? { opacity: 0.6 } : undefined}>
                  <td className="nowrap"><span className="tkey">{x.kind === 'decision' ? 'E' : x.kind === 'issue' ? 'I' : x.kind === 'assumption' ? 'A' : 'R'}-{x.number}</span></td>
                  <td><span className={`badge raid-${x.kind}`}>{KIND_LABEL[x.kind]}</span></td>
                  <td style={{ minWidth: 220 }}><InlineText value={x.title} canEdit={canEdit} onSave={(v) => void patch(x, { title: v })} />{x.taskId && <button className="btn sm link" onClick={() => openTask(x.taskId!)}>{detail.project.key}-{tasks.find((t) => t.id === x.taskId)?.number ?? '?'}</button>}</td>
                  <td>{x.kind === 'risk' || x.kind === 'issue' ? <select className="inline-select" value={x.probability ?? ''} disabled={!canEdit} onChange={(e) => void patch(x, { probability: e.target.value ? Number(e.target.value) : null })}><option value="">–</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select> : <span className="muted">–</span>}</td>
                  <td>{x.kind === 'risk' || x.kind === 'issue' ? <select className="inline-select" value={x.impact ?? ''} disabled={!canEdit} onChange={(e) => void patch(x, { impact: e.target.value ? Number(e.target.value) : null })}><option value="">–</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select> : <span className="muted">–</span>}</td>
                  <td>{x.score != null && <span className={`badge ${scoreClass(x.score) === 'high' ? 'danger' : scoreClass(x.score) === 'mid' ? 'warn' : 'ok'}`}>{x.score}</span>}</td>
                  <td><select className="inline-select" value={x.status} disabled={!canEdit} onChange={(e) => void patch(x, { status: e.target.value as RaidItem['status'] })}>{Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                  <td><select className="inline-select" value={x.ownerUserId ?? ''} disabled={!canEdit} onChange={(e) => void patch(x, { ownerUserId: e.target.value || null })}><option value="">–</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></td>
                  <td className="nowrap"><input type="date" className="inline-date" value={x.dueDate ?? ''} disabled={!canEdit} onChange={(e) => void patch(x, { dueDate: e.target.value || null })} /></td>
                  <td className="nowrap"><DetailButton item={x} canEdit={canEdit} onSave={(body) => patch(x, body)} />{me.role === 'pl' && <button className="btn sm link" title="Löschen" onClick={() => void dialog.confirm({ title: 'Eintrag löschen', text: `„${x.title}“ löschen? Zum Behalten der Historie besser auf „geschlossen“ setzen.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${pid}/raid/${x.id}`); await d.reload(); }); })}>✕</button>}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
        <div className="card">
          <h2>Risikomatrix <span className="muted small" style={{ fontWeight: 400 }}>offene Risiken</span></h2>
          <div className="raid-matrix">
            <div className="c n" />{[1, 2, 3, 4, 5].map((i) => <div key={i} className="c n" title="Auswirkung">A{i}</div>)}
            {[5, 4, 3, 2, 1].map((p) => <span key={p} style={{ display: 'contents' }}><div className="c n" title="Wahrscheinlichkeit">W{p}</div>{[1, 2, 3, 4, 5].map((i) => { const k = `${p}-${i}`; const n = matrix.get(k) ?? 0; return <div key={k} className={`c ${scoreClass(p * i)} ${n ? 'has' : ''} ${cell === k ? 'sel' : ''}`} title={`W${p} × A${i} = ${p * i}`} onClick={() => n && set('zelle', cell === k ? '' : k)}>{n || ''}</div>; })}</span>)}
          </div>
          <p className="muted small mt">Score = Wahrscheinlichkeit × Auswirkung (1 bis 25). Ab 8 gelb, ab 15 rot. Klick auf eine Zelle filtert die Liste.</p>
        </div>
      </div>
      {create && <CreateDialog kind={create} onClose={() => setCreate(null)} onCreated={async () => { setCreate(null); await d.reload(); }} />}
      {busy && <span className="muted small">speichert …</span>}
    </div>
  );
}

/** Beschreibung und Maßnahme/Begründung in einem Dialog; Entscheidungen mit Datum. */
function DetailButton({ item: x, canEdit, onSave }: { item: RaidItem; canEdit: boolean; onSave: (b: Partial<RaidItem>) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ description: x.description ?? '', mitigation: x.mitigation ?? '', decidedOn: x.decidedOn ?? '' });
  const has = Boolean(x.description || x.mitigation);
  return (
    <>
      <button className={`btn sm link ${has ? '' : 'muted'}`} title="Beschreibung und Maßnahme" onClick={() => { setF({ description: x.description ?? '', mitigation: x.mitigation ?? '', decidedOn: x.decidedOn ?? '' }); setOpen(true); }}>{has ? '≡' : '+'}</button>
      {open && (
        <Modal title={`${KIND_LABEL[x.kind]}: ${x.title}`} onClose={() => setOpen(false)}>
          <div className="form">
            <label className="field"><span>Beschreibung</span><textarea value={f.description} readOnly={!canEdit} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
            <label className="field"><span>{x.kind === 'decision' ? 'Begründung und Konsequenzen' : x.kind === 'assumption' ? 'Wie wird die Annahme geprüft?' : 'Maßnahme'}</span><textarea value={f.mitigation} readOnly={!canEdit} onChange={(e) => setF({ ...f, mitigation: e.target.value })} /></label>
            {x.kind === 'decision' && <label className="field"><span>Entschieden am</span><input type="date" value={f.decidedOn} readOnly={!canEdit} onChange={(e) => setF({ ...f, decidedOn: e.target.value })} /></label>}
            <div className="muted small">Angelegt {fmtDate(x.createdAt.slice(0, 10))}, zuletzt geändert {fmtDate(x.updatedAt.slice(0, 10))}</div>
            {canEdit && <div className="row"><button className="btn primary sm" onClick={() => void onSave({ description: f.description || null, mitigation: f.mitigation || null, decidedOn: f.decidedOn || null }).then(() => setOpen(false))}>Speichern</button><button className="btn sm" onClick={() => setOpen(false)}>Abbrechen</button></div>}
          </div>
        </Modal>
      )}
    </>
  );
}

function CreateDialog({ kind, onClose, onCreated }: { kind: RaidKind; onClose: () => void; onCreated: () => Promise<void> }) {
  const { detail, tasks } = useProject();
  const [f, setF] = useState({ title: '', description: '', probability: '', impact: '', ownerUserId: '', dueDate: '', mitigation: '', taskId: '' });
  const { busy, error, run } = useAsync();
  const scored = kind === 'risk' || kind === 'issue';
  return (
    <Modal title={`Neu: ${KIND_LABEL[kind]}`} onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Titel</span><input type="text" value={f.title} autoFocus onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field full"><span>Beschreibung</span><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        {scored && <>
          <label className="field"><span>Wahrscheinlichkeit (1 gering … 5 hoch)</span><select value={f.probability} onChange={(e) => setF({ ...f, probability: e.target.value })}><option value="">–</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <label className="field"><span>Auswirkung (1 gering … 5 hoch)</span><select value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })}><option value="">–</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        </>}
        <label className="field"><span>Verantwortlich</span><select value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })}><option value="">–</option>{detail.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></label>
        <label className="field"><span>{kind === 'decision' ? 'Entschieden am' : 'Termin'}</span><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
        <label className="field full"><span>{kind === 'decision' ? 'Begründung und Konsequenzen' : kind === 'assumption' ? 'Wie wird die Annahme geprüft?' : 'Maßnahme'}</span><textarea value={f.mitigation} onChange={(e) => setF({ ...f, mitigation: e.target.value })} /></label>
        <label className="field full"><span>Bezug zu Arbeitspaket (optional)</span><select value={f.taskId} onChange={(e) => setF({ ...f, taskId: e.target.value })}><option value="">–</option>{tasks.filter((t) => !t.done).map((t) => <option key={t.id} value={t.id}>{detail.project.key}-{t.number} {t.title}</option>)}</select></label>
        {error && <div className="error full">{error}</div>}
        <div className="row full"><button className="btn primary" disabled={busy || !f.title.trim()} onClick={() => void run(async () => {
          await api.post(`/projects/${detail.project.id}/raid`, { kind, title: f.title, description: f.description || null, probability: f.probability ? Number(f.probability) : null, impact: f.impact ? Number(f.impact) : null, ownerUserId: f.ownerUserId || null, dueDate: kind === 'decision' ? null : f.dueDate || null, decidedOn: kind === 'decision' ? f.dueDate || null : null, mitigation: f.mitigation || null, taskId: f.taskId || null });
          await onCreated();
        })}>Anlegen</button></div>
      </div>
    </Modal>
  );
}

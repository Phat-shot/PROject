import { useMemo, useState } from 'react';
import { api, fmtDate, today } from '../../lib/api';
import { Modal, useAsync, useDialog } from '../../components/ui';
import { useProject } from '../ProjectPage';
import { InlineText } from './TaskDrawer';
import { useData } from '../../lib/useData';
import type { Group } from '@projekttool/shared';

const DAY = 86400_000;
const PX_PER_DAY = 4;

export function PlanView() {
  const { detail, tasks, reload, reloadTasks, openTask, users } = useProject();
  const me = detail.project.myMembership;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const [newSp, setNewSp] = useState(false);
  const [newMs, setNewMs] = useState(false);
  const dialog = useDialog();

  const range = useMemo(() => {
    const dates: string[] = [today()];
    for (const t of tasks) { if (t.startDate) dates.push(t.startDate); if (t.dueDate) dates.push(t.dueDate); }
    for (const s of detail.subprojects) { if (s.startDate) dates.push(s.startDate); if (s.endDate) dates.push(s.endDate); }
    for (const m of detail.milestones) dates.push(m.date);
    const min = new Date(dates.reduce((a, b) => (a < b ? a : b)));
    const max = new Date(dates.reduce((a, b) => (a > b ? a : b)));
    min.setDate(1); min.setDate(min.getDate() - 7);
    max.setMonth(max.getMonth() + 1, 1); max.setDate(max.getDate() + 7);
    return { min, max, days: Math.round((max.getTime() - min.getTime()) / DAY) };
  }, [tasks, detail]);
  const x = (d: string) => Math.round((new Date(d + 'T00:00:00').getTime() - range.min.getTime()) / DAY) * PX_PER_DAY;
  const width = range.days * PX_PER_DAY;
  const months = useMemo(() => {
    const out: { label: string; left: number; w: number }[] = [];
    const d = new Date(range.min); d.setDate(1);
    while (d < range.max) {
      const start = new Date(d); const end = new Date(d); end.setMonth(end.getMonth() + 1);
      const l = Math.max(0, (start.getTime() - range.min.getTime()) / DAY) * PX_PER_DAY;
      const r = Math.min(range.days * DAY, end.getTime() - range.min.getTime()) / DAY * PX_PER_DAY;
      out.push({ label: start.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }), left: l, w: r - l });
      d.setMonth(d.getMonth() + 1);
    }
    return out;
  }, [range]);

  const rows: { kind: 'sub' | 'task' | 'ms'; id: string; label: string; start: string | null; end: string | null; done?: boolean; conflict?: boolean; resp?: string | null }[] = [];
  const spRows = (spId: string | null) => {
    for (const t of tasks.filter((t) => t.subprojectId === spId)) {
      rows.push({ kind: 'task', id: t.id, label: t.title, start: t.startDate, end: t.dueDate, done: t.done, conflict: t.conflicts.length > 0, resp: t.responsible.name ?? t.responsible.email });
    }
    for (const m of detail.milestones.filter((m) => m.subprojectId === spId)) rows.push({ kind: 'ms', id: m.id, label: m.name, start: m.date, end: m.date });
  };
  for (const s of detail.subprojects) {
    const inSp = tasks.filter((t) => t.subprojectId === s.id);
    const starts = inSp.map((t) => t.startDate ?? t.dueDate).filter(Boolean) as string[];
    const ends = inSp.map((t) => t.dueDate).filter(Boolean) as string[];
    const start = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : s.startDate;
    const end = ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : s.endDate;
    rows.push({ kind: 'sub', id: s.id, label: s.name, start: s.startDate ?? start, end: s.endDate ?? end, resp: s.responsible.name });
    spRows(s.id);
  }
  const loose = tasks.filter((t) => !t.subprojectId);
  if (loose.length || detail.milestones.some((m) => !m.subprojectId)) { rows.push({ kind: 'sub', id: 'none', label: 'Ohne Teilprojekt', start: null, end: null }); spRows(null); }

  return (
    <div className="content">
      <div className="row mb">
        <span className="muted small">Balken = Start bis Deadline, Punkt = nur Deadline. Teilprojekt-Balken = frühester Start bis späteste Deadline. Konflikte orange, nichts verschiebt sich automatisch.</span>
        {canPlan && <><button className="btn right" onClick={() => setNewSp(true)}>Teilprojekt</button><button className="btn" onClick={() => setNewMs(true)}>Meilenstein</button></>}
      </div>
      <div className="card gantt" style={{ padding: 0 }}>
        <table>
          <thead><tr><th className="label">Element</th><th style={{ width }}><div style={{ position: 'relative', height: 24, width }}>{months.map((m) => <div key={m.label + m.left} className="month" style={{ position: 'absolute', left: m.left, width: m.w, top: 0, bottom: 0 }}>{m.label}</div>)}</div></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.kind + r.id}>
                <td className={`label ${r.kind === 'sub' ? 'sub' : ''}`} style={{ cursor: r.kind === 'task' ? 'pointer' : undefined }} onClick={() => r.kind === 'task' && openTask(r.id)}>
                  {r.kind === 'task' && <span style={{ paddingLeft: 10 }} />}{r.kind === 'ms' && '◆ '}{r.label}
                  {r.resp && <span className="muted"> · {r.resp}</span>}
                </td>
                <td className="bars" style={{ width }}>
                  <div style={{ position: 'relative', height: 30, width }}>
                    <div className="today" style={{ left: x(today()) }} />
                    {r.kind === 'ms' && r.start && <div className="milestone" style={{ left: x(r.start) - 8 }} title={fmtDate(r.start)} />}
                    {r.kind !== 'ms' && r.start && r.end && r.start <= r.end && <div className={`bar ${r.kind} ${r.done ? 'done' : ''} ${r.conflict ? 'conflict' : ''}`} style={{ left: x(r.start), width: Math.max(6, x(r.end) - x(r.start) + PX_PER_DAY) }} title={`${fmtDate(r.start)} – ${fmtDate(r.end)}`}>{r.kind === 'sub' ? '' : `${fmtDate(r.start)} – ${fmtDate(r.end)}`}</div>}
                    {r.kind === 'task' && !r.start && r.end && <div className={`dot ${r.conflict ? 'conflict' : ''}`} style={{ left: x(r.end) - 6, background: r.conflict ? '#e08b2b' : undefined }} title={`Deadline ${fmtDate(r.end)}`} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid cols-2 mt">
        <div className="card">
          <h2>Teilprojekte</h2>
          <table className="table"><thead><tr><th>Name</th><th>Verantwortlich</th><th>Zeitraum</th><th /></tr></thead><tbody>
            {detail.subprojects.map((s) => <SubRow key={s.id} s={s} canPlan={canPlan} />)}
          </tbody></table>
        </div>
        <div className="card">
          <h2>Meilensteine</h2>
          <table className="table"><thead><tr><th>Name</th><th>Datum</th><th>Teilprojekt</th><th /></tr></thead><tbody>
            {detail.milestones.map((m) => <tr key={m.id}><td>{m.name}</td><td>{fmtDate(m.date)}</td><td className="muted">{detail.subprojects.find((s) => s.id === m.subprojectId)?.name ?? '–'}</td>
              <td>{canPlan && <button className="btn sm link" onClick={() => void api.del(`/projects/${detail.project.id}/milestones/${m.id}`).then(reload)}>✕</button>}</td></tr>)}
          </tbody></table>
        </div>
      </div>
      {newSp && <SubprojectForm onClose={() => setNewSp(false)} />}
      {newMs && <MilestoneForm onClose={() => setNewMs(false)} />}
    </div>
  );

  function SubRow({ s, canPlan }: { s: (typeof detail.subprojects)[number]; canPlan: boolean }) {
    const [edit, setEdit] = useState(false);
    const members = users.filter((u) => detail.members.some((m) => m.userId === u.id));
    const save = async (body: Record<string, unknown>) => {
      if ('responsibleUserId' in body) {
        const direct = tasks.filter((x) => x.subprojectId === s.id && !x.done && x.responsibleUserId && x.responsibleUserId === s.responsible.userId);
        const newName = members.find((u) => u.id === body.responsibleUserId)?.name ?? 'den PL';
        if (direct.length > 0) { const v = await dialog.choose({ title: 'Direkt zugewiesene Arbeitspakete', text: `${direct.length} Arbeitspaket(e) sind ${s.responsible.name ?? 'der bisherigen Verantwortung'} direkt  zugewiesen. Auch an ${newName} übertragen? Geerbte Zuständigkeiten wechseln in jedem Fall.`, options: [{ label: 'Mit übertragen', value: true, primary: true }, { label: 'Nur geerbte wechseln', value: false }] }); if (v === null) return; body.transferTasks = v; }
      }
      await api.patch(`/projects/${detail.project.id}/subprojects/${s.id}`, body); await reload(); await reloadTasks();
    };
    if (!canPlan) {
      return (
        <tr>
          <td>{s.name}{s.restricted && <span className="badge" title="Eingeschränkt sichtbar" style={{ marginLeft: 6 }}>🔒</span>}</td>
          <td>{s.responsible.name ?? '–'}{s.responsible.inherited && <span className="muted small"> (geerbt vom PL)</span>}</td>
          <td className="nowrap">{fmtDate(s.startDate)} – {fmtDate(s.endDate)}</td><td />
        </tr>
      );
    }
    return (
      <tr className="inline-row">
        <td><span className="row" style={{ gap: 4 }}><InlineText value={s.name} canEdit onSave={(name) => void save({ name })} />{s.restricted && <span className="badge" title="Eingeschränkt sichtbar">🔒</span>}</span></td>
        <td><select className="inline-select" value={s.responsibleUserId ?? ''} onChange={(e) => void save({ responsibleUserId: e.target.value || null })}><option value="">{s.responsible.inherited ? `${s.responsible.name ?? 'PL'} (geerbt vom PL)` : '– geerbt vom PL –'}</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></td>
        <td className="nowrap"><input type="date" className="inline-date" value={s.startDate ?? ''} onChange={(e) => void save({ startDate: e.target.value || null })} /> – <input type="date" className="inline-date" value={s.endDate ?? ''} onChange={(e) => void save({ endDate: e.target.value || null })} /></td>
        <td className="nowrap">{me.role === 'pl' && <button className="btn sm link" title="Sichtbarkeit, Zugriff" onClick={() => setEdit(true)}>Sichtbarkeit</button>}{me.role === 'pl' && <button className="btn sm link" onClick={() => void dialog.confirm({ title: 'Teilprojekt löschen', text: `„${s.name}“ löschen? Die Arbeitspakete bleiben erhalten und stehen danach unter „Ohne Teilprojekt“.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void api.del(`/projects/${detail.project.id}/subprojects/${s.id}`).then(async () => { await reload(); await reloadTasks(); }); })}>✕</button>}
          {edit && <SubprojectForm existing={s} onClose={() => setEdit(false)} />}</td>
      </tr>
    );
  }

  function SubprojectForm({ existing, onClose }: { existing?: (typeof detail.subprojects)[number]; onClose: () => void }) {
    const [f, setF] = useState({ name: existing?.name ?? '', responsibleUserId: existing?.responsibleUserId ?? '', startDate: existing?.startDate ?? '', endDate: existing?.endDate ?? '', restricted: existing?.restricted ?? false, accessUserIds: existing?.accessUserIds ?? [], accessGroupIds: existing?.accessGroupIds ?? [] });
    const { busy, error, run } = useAsync();
    const members = users.filter((u) => detail.members.some((m) => m.userId === u.id));
    const groups = useData<{ groups: Group[] }>(me.role === 'pl' ? '/groups' : null);
    const toggle = (k: 'accessUserIds' | 'accessGroupIds', id: string) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] });
    return (
      <Modal title={existing ? 'Teilprojekt bearbeiten' : 'Neues Teilprojekt'} onClose={onClose}>
        <div className="form cols-2">
          <label className="field full"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field full"><span>Verantwortlich (Benutzer oder PL; keine eigene Rolle)</span><select value={f.responsibleUserId} onChange={(e) => setF({ ...f, responsibleUserId: e.target.value })}><option value="">– geerbt vom PL –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label className="field"><span>Start</span><input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
          <label className="field"><span>Ende</span><input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
          {me.role === 'pl' && <div className="full stack">
            <label className="check"><input type="checkbox" checked={f.restricted} onChange={(e) => setF({ ...f, restricted: e.target.checked })} /> Eingeschränkt sichtbar: nur PL, Verantwortliche und die hier benannten Benutzer und Gruppen sehen Teilprojekt und Arbeitspakete</label>
            {f.restricted && <div className="grid cols-2">
              <div className="field"><span>Benutzer</span><div className="stack" style={{ gap: 2 }}>{members.map((u) => <label key={u.id} className="check small"><input type="checkbox" checked={f.accessUserIds.includes(u.id)} onChange={() => toggle('accessUserIds', u.id)} /> {u.name}</label>)}</div></div>
              <div className="field"><span>Gruppen</span><div className="stack" style={{ gap: 2 }}>{(groups.data?.groups ?? []).map((g) => <label key={g.id} className="check small"><input type="checkbox" checked={f.accessGroupIds.includes(g.id)} onChange={() => toggle('accessGroupIds', g.id)} /> {g.name} <span className="muted">({g.memberIds.length})</span></label>)}{groups.data && groups.data.groups.length === 0 && <span className="muted small">Keine Gruppen. Der Org-Admin legt sie in der Verwaltung an.</span>}</div></div>
            </div>}
          </div>}
          {error && <div className="error full">{error}</div>}
          <div className="row full"><button className="btn primary" disabled={busy || !f.name} onClick={() => void run(async () => {
            const body: Record<string, unknown> = { name: f.name, responsibleUserId: f.responsibleUserId || null, startDate: f.startDate || null, endDate: f.endDate || null };
            if (me.role === 'pl') { body.restricted = f.restricted; body.accessUserIds = f.accessUserIds; body.accessGroupIds = f.accessGroupIds; }
            if (existing && (f.responsibleUserId || null) !== (existing.responsibleUserId ?? null)) {
              const oldEff = existing.responsible.userId;
              const newName = members.find((u) => u.id === f.responsibleUserId)?.name ?? 'den PL';
              const direct = tasks.filter((x) => x.subprojectId === existing.id && !x.done && x.responsibleUserId && x.responsibleUserId === oldEff);
              if (direct.length > 0) { const v = await dialog.choose({ title: 'Direkt zugewiesene Arbeitspakete', text: `${direct.length} Arbeitspaket(e) in diesem Teilprojekt sind ${existing.responsible.name ?? 'der bisherigen Verantwortung'} direkt  zugewiesen. Auch an ${newName} übertragen? Geerbte Zuständigkeiten wechseln in jedem Fall.`, options: [{ label: 'Mit übertragen', value: true, primary: true }, { label: 'Nur geerbte wechseln', value: false }] }); if (v === null) return; body.transferTasks = v; }
            }
            if (existing) await api.patch(`/projects/${detail.project.id}/subprojects/${existing.id}`, body); else await api.post(`/projects/${detail.project.id}/subprojects`, body);
            await reload(); await reloadTasks(); onClose();
          })}>Speichern</button></div>
        </div>
      </Modal>
    );
  }

  function MilestoneForm({ onClose }: { onClose: () => void }) {
    const [f, setF] = useState({ name: '', date: '', subprojectId: '' });
    const { busy, error, run } = useAsync();
    return (
      <Modal title="Neuer Meilenstein" onClose={onClose}>
        <div className="form">
          <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>Datum</span><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label className="field"><span>Teilprojekt</span><select value={f.subprojectId} onChange={(e) => setF({ ...f, subprojectId: e.target.value })}><option value="">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          {error && <div className="error">{error}</div>}
          <div><button className="btn primary" disabled={busy || !f.name || !f.date} onClick={() => void run(async () => { await api.post(`/projects/${detail.project.id}/milestones`, { name: f.name, date: f.date, subprojectId: f.subprojectId || null }); await reload(); onClose(); })}>Anlegen</button></div>
        </div>
      </Modal>
    );
  }
}

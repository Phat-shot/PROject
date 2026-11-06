import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LABEL_COLORS, type Task } from '@projekttool/shared';
import { api, downloadCsv, fmtDate, today } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, IconButton, Initials, keyboardShortcutsBlocked, Loading, Modal, prioLabel, Term, useAsync, useDialog, useToast } from '../../components/ui';
import { IconAlert, IconArrowRight, IconCheck, IconCollapse, IconCheckSquare, IconChevronDown, IconChevronRight, IconChevronUp, IconClock, IconComment, IconHourglass, IconLock, IconRotate, IconSettings, IconX } from '../../components/icons';
import { moveTaskTo, reviewOptsOf } from '../../lib/moveTask';
import { SUBTASK_DRAG } from './MoveDialog';
import { useCreate } from './create';
import { useData } from '../../lib/useData';
import { StartRunDialog, type WorkflowDef } from './WorkflowsView';
import { useProject } from '../ProjectPage';
import { useIsMobile } from '../../lib/useMedia';
import { EMPTY_FILTER, isFilterActive, readFilter, writeFilter, type BoardFilter } from '../../lib/boardFilter';
import { groupColumns } from '../../lib/columnGroups';
import { projectPolicy } from '../../lib/useProjectPolicy';

type Filter = BoardFilter;
const EMPTY = EMPTY_FILTER;
function readSet(key: string): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set(); } }
function writeSet(key: string, s: Set<string>) { try { localStorage.setItem(key, JSON.stringify([...s])); } catch { /* ignore */ } }

export function BoardView() {
  const { detail, tasks, reloadTasks, openTask, openSubproject } = useProject();
  const { user } = useAuth();
  const create = useCreate();
  const canPlanSp = detail.project.myMembership.role === 'pl' || detail.project.myMembership.canEditPlan;
  const dialog = useDialog();
  const toast = useToast();
  const mobile = useIsMobile();
  const [showFilters, setShowFilters] = useState(false);
  const pid = detail.project.id;
  // Mehrfachauswahl: Modus über Chip „Auswählen“ oder Strg/Cmd+Klick auf eine Karte; Aktionen in der Leiste unten
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clearSelection = () => { setSelected(new Set()); setSelectMode(false); };
  const bulk = useAsync({ toast: true });
  // Sammelaktion mit Nachfrage (nennt die Anzahl); Fehler als Toast, danach Board neu laden
  const bulkRun = async (what: string, fn: (id: string) => Promise<unknown>, opts: { danger?: boolean; confirmLabel?: string; text?: string } = {}) => {
    const n = selected.size;
    const ok = await dialog.confirm({ title: what, text: opts.text ?? `${n} Arbeitspaket${n === 1 ? '' : 'e'}: ${what.toLowerCase()}?`, confirmLabel: opts.confirmLabel ?? 'Ausführen', danger: opts.danger });
    if (!ok) return;
    await bulk.run(async () => { try { for (const id of selected) await fn(id); } finally { await reloadTasks(); } clearSelection(); toast.ok(`${n} Arbeitspaket${n === 1 ? '' : 'e'} geändert.`); });
  };
  const [params, setParams] = useSearchParams();
  const f = useMemo(() => readFilter(params), [params]);
  const setF = (next: Filter | ((x: Filter) => Filter)) => setParams(writeFilter(params, typeof next === 'function' ? next(f) : next), { replace: true });
  const [lanes, setLanesState] = useState(() => { try { return localStorage.getItem(`pt_swim_${pid}`) !== '0'; } catch { return true; } });
  const setLanes = (v: boolean) => { setLanesState(v); try { localStorage.setItem(`pt_swim_${pid}`, v ? '1' : '0'); } catch { /* ignore */ } };
  // Aufgaben stehen in der Karte ihres Arbeitspakets; aufgeklappt oder nur als Zähler (je Projekt gemerkt, je Karte umschaltbar)
  const [showSubs, setShowSubsState] = useState(() => { try { return localStorage.getItem(`pt_subs_${pid}`) !== '0'; } catch { return true; } });
  const setShowSubs = (v: boolean) => { setShowSubsState(v); try { localStorage.setItem(`pt_subs_${pid}`, v ? '1' : '0'); } catch { /* ignore */ } };
  const [archived, setArchived] = useState<Task[] | null>(null);
  const [collapsed, setCollapsedState] = useState<Set<string>>(() => readSet(`pt_cols_${pid}`));
  const setCollapsed = (s: Set<string>) => { setCollapsedState(s); writeSet(`pt_cols_${pid}`, s); };
  const [laneClosed, setLaneClosedState] = useState<Set<string>>(() => readSet(`pt_lanes_${pid}`));
  const toggleLane = (k: string) => { const n = new Set(laneClosed); if (n.has(k)) n.delete(k); else n.add(k); setLaneClosedState(n); writeSet(`pt_lanes_${pid}`, n); };
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ col: string; lane: string; index: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const canEdit = detail.project.myMembership.role !== 'reader';
  const t = today();
  const soon = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const active = isFilterActive(f);
  const archive = useAsync({ toast: true });

  useEffect(() => {
    if (f.archived && !archived) api.get<{ tasks: Task[] }>(`/projects/${detail.project.id}/tasks?archived=1`).then((r) => setArchived(r.tasks)).catch((e) => toast.error(e.message));
    if (!f.archived) setArchived(null);
  }, [f.archived]);

  // Tastaturkürzel wie in Trello: f Filter, q nur meine, n neues Arbeitspaket, x Filter löschen – nicht in Eingabefeldern und nicht bei offenem Dialog
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || keyboardShortcutsBlocked(e.target)) return;
      if (e.key === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'q') setF((x) => ({ ...x, mine: !x.mine }));
      if (e.key === 'x') setF(EMPTY);
      if (e.key === 'Escape') clearSelection();
      if (e.key === 'n' && canEdit) { e.preventDefault(); setAdding(firstAdd.current); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [canEdit, detail.columns]);

  // Board zeigt Arbeitspakete; Aufgaben als eigene Karten unter ihrem Arbeitspaket (Schalter „Aufgaben“).
  // Personenfilter treffen ein Arbeitspaket auch über seine offenen Aufgaben.
  const all = f.archived ? archived ?? [] : tasks;
  const source = useMemo(() => all.filter((x) => !x.parentId), [all]);
  const kidsOf = useMemo(() => { const m = new Map<string, Task[]>(); for (const x of all) if (x.parentId && !x.done) m.set(x.parentId, [...(m.get(x.parentId) ?? []), x]); return m; }, [all]);
  const passes = (x: Task, viaKids: boolean) => {
    const respIs = (uid: string) => x.responsible.userId === uid || (viaKids && (kidsOf.get(x.id) ?? []).some((k) => k.responsible.userId === uid));
    if (f.q && !(x.title + ' ' + (x.description ?? '')).toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.member === 'none' ? x.responsible.userId : f.member && !respIs(f.member)) return false;
    if (f.label && !x.labelIds.includes(f.label)) return false;
    if (f.mine && !respIs(user?.id ?? '')) return false;
    if (f.overdue && !(x.dueDate && x.dueDate < t && !x.done)) return false;
    if (f.conflicts && x.conflicts.length === 0) return false;
    if (f.escalated && !x.blocked && x.escalationLevel === 0) return false;
    if (f.prio && x.priority !== f.prio) return false;
    return true;
  };
  const filtered = useMemo(() => source.filter((x) => passes(x, true)), [source, kidsOf, f, t, user?.id]);
  const kidsAll = useMemo(() => { const m = new Map<string, Task[]>(); for (const x of all) if (x.parentId) m.set(x.parentId, [...(m.get(x.parentId) ?? []), x]); for (const v of m.values()) v.sort((a, b) => Number(a.done) - Number(b.done) || a.position - b.position || a.number - b.number); return m; }, [all]);

  const groups = useMemo(() => {
    if (!lanes) return [{ key: 'all', name: null as string | null, tasks: filtered }];
    const out = detail.subprojects.map((s) => ({ key: s.id, name: s.name, tasks: filtered.filter((x) => x.subprojectId === s.id) }));
    out.push({ key: 'none', name: 'Ohne Teilprojekt', tasks: filtered.filter((x) => !x.subprojectId) });
    return out.filter((g) => g.tasks.length > 0 || !active);
  }, [filtered, lanes, detail.subprojects, active]);

  // Spaltengruppen (Einstellungen › Planung und Board): gleiche Gruppe = eine Board-Spalte mit Abschnitten untereinander
  const boardCols = useMemo(() => groupColumns(detail.columns), [detail.columns]);
  // Schnell anlegen nur in einer Spalte je Teilprojekt (erste aktive, sonst erste): weniger Knöpfe, gleicher Weg
  const addColumnId = (detail.columns.find((c) => c.kind === 'active') ?? detail.columns[0])?.id;
  // Anlegen in jeder Spalte außer „Wartet“ (braucht Grund und Frist) und „Erledigt“; `n` öffnet das Feld der ersten aktiven Spalte
  const [adding, setAdding] = useState<string | null>(null);
  const firstAdd = useRef('');
  firstAdd.current = `${groups[0]?.key ?? 'all'}|${addColumnId}`;
  const [newSp, setNewSp] = useState(false);
  const columnCount = (colId: string) => tasks.filter((x) => x.columnId === colId && !x.parentId).length;

  // Ablegen: Fehler als Toast, Board danach in jedem Fall neu laden (sonst zeigt es einen Stand, den der Server nicht hat)
  const onDrop = async (laneKey: string, colId: string) => {
    if (!drag) return;
    const task = tasks.find((x) => x.id === drag);
    setDrag(null); setDrop(null);
    if (!task) return;
    try {
      if (task.parentId) {
        const col = detail.columns.find((c) => c.id === colId);
        if (col && col.id !== task.columnId && (await moveTaskTo(dialog.form, task.id, col, null, reviewOptsOf(detail, task.reviewer?.userId)))) await reloadTasks();
        return;
      }
      // Zielindex innerhalb der Spalte bestimmen (Swimlane → Position im Gesamt der Spalte)
      const colTasks = tasks.filter((x) => x.columnId === colId && x.id !== task.id && !x.parentId).sort((a, b) => a.position - b.position);
      const laneTasks = colTasks.filter((x) => laneKey === 'all' ? true : laneKey === 'none' ? !x.subprojectId : x.subprojectId === laneKey);
      const idxInLane = drop && drop.col === colId && drop.lane === laneKey ? drop.index : laneTasks.length;
      const anchor = laneTasks[idxInLane];
      const index = anchor ? colTasks.indexOf(anchor) : colTasks.length;
      const col = detail.columns.find((c) => c.id === colId);
      if (!col || !(await moveTaskTo(dialog.form, task.id, col, index, reviewOptsOf(detail, task.reviewer?.userId)))) return;
      if (laneKey !== 'all' && (task.subprojectId ?? 'none') !== laneKey) await api.patch(`/tasks/${task.id}`, { subprojectId: laneKey === 'none' ? null : laneKey });
      await reloadTasks();
    } catch (e: any) {
      toast.error(`Verschieben fehlgeschlagen: ${e?.message ?? e}`);
      await reloadTasks().catch(() => undefined);
    }
  };

  const archiveDone = (c: { id: string; name: string }, total: number) => void dialog.confirm({ title: 'Erledigte archivieren', text: `${total} erledigte Arbeitspakete archivieren? Sie bleiben über den Filter „Archiv“ erreichbar.`, confirmLabel: 'Archivieren' })
    .then((ok) => { if (ok) void archive.run(async () => { await api.post(`/projects/${detail.project.id}/columns/${c.id}/archive-done`); await reloadTasks(); toast.ok(`${total} Arbeitspakete archiviert.`); }); });

  return (
    <div className="content">
      {projectPolicy(detail.project).assistant && detail.project.myMembership.role === 'pl' && <AssistantHint projectId={detail.project.id} />}
      {mobile && !showFilters ? (
        <div className="filterbar compact">
          <input ref={searchRef} type="text" aria-label="Filtern" placeholder="Filtern …" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <button className={`chip ${active ? 'on' : ''}`} aria-expanded={false} onClick={() => setShowFilters(true)}>Filter{active ? ' ·' : ''}</button>
        </div>
      ) : (
      <div className="filterbar kbd-hint">
        {mobile && <button className="chip" aria-expanded onClick={() => setShowFilters(false)}><IconChevronUp size={12} /> Filter einklappen</button>}
        <input ref={searchRef} type="text" aria-label="Filtern (Taste f)" placeholder="Filtern … (f)" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select aria-label="Person" value={f.member} onChange={(e) => setF({ ...f, member: e.target.value })}>
          <option value="">Alle Personen</option>
          {detail.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          <option value="none">Extern / ohne Person</option>
        </select>
        <select aria-label="Label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })}>
          <option value="">Alle Labels</option>
          {detail.labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select aria-label="Priorität" value={f.prio} onChange={(e) => setF({ ...f, prio: e.target.value })}>
          <option value="">Jede Priorität</option>
          {Object.entries(prioLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className={`chip ${f.mine ? 'on' : ''}`} aria-pressed={f.mine} onClick={() => setF({ ...f, mine: !f.mine })}>Nur meine<kbd>q</kbd></button>
        <button className={`chip ${f.overdue ? 'on' : ''}`} aria-pressed={f.overdue} onClick={() => setF({ ...f, overdue: !f.overdue })}>Überfällig</button>
        <button className={`chip ${f.conflicts ? 'on' : ''}`} aria-pressed={f.conflicts} onClick={() => setF({ ...f, conflicts: !f.conflicts })}>Konflikte</button>
        <button className={`chip ${f.escalated ? 'on' : ''}`} aria-pressed={f.escalated} onClick={() => setF({ ...f, escalated: !f.escalated })}>Blockiert / eskaliert</button>
        <button className={`chip ${f.archived ? 'on' : ''}`} aria-pressed={f.archived} onClick={() => setF({ ...f, archived: !f.archived })}>Archiv</button>
        {canEdit && <button className={`chip ${selectMode ? 'on' : ''}`} aria-pressed={selectMode} title="Mehrere Arbeitspakete auswählen (auch Strg+Klick)" onClick={() => { if (selectMode) clearSelection(); else setSelectMode(true); }}>Auswählen</button>}
        {active && <button className="chip" onClick={() => setF(EMPTY)}>Filter löschen<kbd>x</kbd></button>}
        {canEdit && !f.archived && !mobile && <button className="chip" title="Neues Arbeitspaket in der ersten aktiven Spalte (Taste n)" onClick={() => setAdding(firstAdd.current)}>Neu<kbd>n</kbd></button>}
        <label className="check small right" title="Aufgaben in den Karten aufgeklappt zeigen (sonst nur der Zähler; je Karte umschaltbar)"><input type="checkbox" checked={showSubs} onChange={(e) => setShowSubs(e.target.checked)} /> Aufgaben aufgeklappt</label>
        <label className="check small"><input type="checkbox" checked={lanes} onChange={(e) => setLanes(e.target.checked)} /> Swimlanes</label>
        <span className="muted small" aria-label={`${filtered.length} von ${source.length} Arbeitspaketen`}>{filtered.length}/{source.length}</span>
        <button className="chip" title="Gefilterte Arbeitspakete als CSV (Excel)" onClick={() => downloadCsv(`board_${detail.project.key}.csv`, ['Kennung', 'Titel', 'Status', 'Teilprojekt', 'Zuständig', 'Start', 'Fällig', 'Priorität', 'Labels', 'Blockiert', 'Erledigt', 'Übergeordnet'], filtered.map((x) => [x.number ? `${detail.project.key}-${x.number}` : '', x.title, detail.columns.find((c) => c.id === x.columnId)?.name ?? '', detail.subprojects.find((s) => s.id === x.subprojectId)?.name ?? '', x.responsible?.name ?? x.responsible?.email ?? '', x.startDate, x.dueDate, x.priority, (x.labelIds ?? []).map((id) => detail.labels.find((l) => l.id === id)?.name ?? '').filter(Boolean).join(', '), x.blocked ? 'ja' : '', x.done ? 'ja' : '', x.parent ? `${detail.project.key}-${x.parent.number}` : '']))}>CSV</button>
      </div>
      )}
      {f.archived && <div className="notice mb small">Archiv: erledigte und archivierte Arbeitspakete. Wiederherstellen im Arbeitspaket.{!archived && <> <Loading /></>}</div>}
      {groups.map((g) => { const closed = g.tasks.length === 0 ? !laneClosed.has(g.key) : laneClosed.has(g.key); return (
        <div key={g.key} className={`swimlane ${closed ? 'collapsed' : ''}`}>
          {g.name && <h2><button className="lane-toggle" title={closed ? 'Ausklappen' : 'Einklappen'} aria-label={`${g.name}: ${closed ? 'ausklappen' : 'einklappen'}`} aria-expanded={!closed} onClick={() => toggleLane(g.key)}>{closed ? <IconChevronRight /> : <IconChevronDown />}</button>{g.key !== 'none' && g.key !== 'all' ? <button className="lane-name link" title="Teilprojekt öffnen (Verantwortung, Zeitraum, Beschreibung, Sichtbarkeit, Meilensteine)" onClick={() => openSubproject(g.key)}>{g.name}</button> : <span className="lane-name">{g.name}</span>}<Badge>{g.tasks.length}</Badge>{g.key !== 'none' && <SubprojectResp id={g.key} />}{g.key !== 'none' && g.key !== 'all' && <Button size="sm" className="lane-config" icon={<IconSettings />} title="Teilprojekt konfigurieren: Verantwortung, Zeitraum, Beschreibung, Sichtbarkeit, Meilensteine" onClick={() => openSubproject(g.key)}>Teilprojekt</Button>}</h2>}
          {g.name && closed ? null : <div className="board">
            {boardCols.map((bc) => {
              const laneKey = g.key;
              // Abschnitt einer Spalte: Kopf (Name, Art, Zähler, WIP, Einklappen), Karten, „Hier ablegen“, Schnellanlage; eigenes Drop-Ziel
              const section = (c: typeof bc.columns[number], inGroup: boolean) => {
                const inCol = g.tasks.filter((x) => x.columnId === c.id).sort((a, b) => a.position - b.position);
                const total = columnCount(c.id);
                const over = c.wipLimit != null && total > c.wipLimit;
                const isCollapsed = collapsed.has(c.id);
                const isOver = drop?.col === c.id && drop.lane === laneKey;
                const dropProps = {
                  onDragOver: (e: React.DragEvent) => { if (canEdit && drag) { e.preventDefault(); e.stopPropagation(); if (!drop || drop.col !== c.id || drop.lane !== laneKey) setDrop({ col: c.id, lane: laneKey, index: inCol.length }); } },
                  onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrop(null); },
                  onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); void onDrop(laneKey, c.id); }
                };
                const kindHint = <>{c.kind === 'backlog' && <span className="kind"><Term k="stillstand">geplant</Term></span>}{c.kind === 'parked' && <span className="kind" title="Zurückgestellt: ruht, keine Eskalation">ruht</span>}{c.kind === 'waiting' && <span className="kind" title="Wartet auf Rückmeldung mit Frist; ohne Lösung bis zur Frist → Zurückgestellt">Frist</span>}{c.kind === 'review' && <span className="kind" title="In Prüfung: beim Hineinziehen wird die prüfende Person gewählt; sie gibt frei oder weist zurück">Prüfung</span>}{c.wipLimit != null && <span className="count" title="WIP-Limit"> · {total}/{c.wipLimit}</span>}</>;
                const body = <>
                  {!isCollapsed && inCol.map((x, i) => (
                    <TaskCard key={x.id} task={x} t={t} soon={soon} canEdit={canEdit}
                      kids={kidsAll.get(x.id) ?? []} kidsOpen={showSubs}
                      selectable={selectMode} selected={selected.has(x.id)}
                      dragging={drag === x.id}
                      dropMarker={isOver ? (drop!.index === i ? 'before' : drop!.index === i + 1 && i === inCol.length - 1 ? 'after' : null) : null}
                      onDragStart={() => setDrag(x.id)}
                      onDragEnd={() => { setDrag(null); setDrop(null); }}
                      onDragOverCard={(e) => { if (!drag || drag === x.id) return; e.preventDefault(); e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const before = e.clientY < r.top + r.height / 2; setDrop({ col: c.id, lane: laneKey, index: before ? i : i + 1 }); }}
                      onClick={(e) => { if (canEdit && (selectMode || e.ctrlKey || e.metaKey)) { if (!selectMode) setSelectMode(true); toggleSelect(x.id); } else openTask(x.id); }} />
                  ))}
                  {!isCollapsed && inCol.length === 0 && (drag ? <div className="col-empty">Hier ablegen</div> : inGroup && <div className="col-empty none muted small" aria-label="leer">–</div>)}
                  {!isCollapsed && canEdit && !f.archived && !c.isDone && c.kind !== 'waiting' && <QuickAdd columnId={c.id} subprojectId={laneKey === 'none' || laneKey === 'all' ? null : laneKey} workflow={c.id === addColumnId}
                    open={adding === `${laneKey}|${c.id}`} onOpen={() => setAdding(`${laneKey}|${c.id}`)} onClose={() => setAdding(null)} />}
                </>;
                if (inGroup) return (
                  <section key={c.id} className={`col-section kind-${c.kind} ${over ? 'wip-over' : ''} ${isCollapsed ? 'collapsed' : ''} ${isOver ? 'over' : ''}`} aria-label={`Abschnitt ${c.name}`} {...dropProps}>
                    <h4>
                      <button className="section-toggle" aria-expanded={!isCollapsed} aria-label={`Abschnitt ${c.name} ${isCollapsed ? 'ausklappen' : 'einklappen'} (${total})`} title={isCollapsed ? 'Abschnitt ausklappen' : 'Abschnitt einklappen'}
                        onClick={() => { const n = new Set(collapsed); if (isCollapsed) n.delete(c.id); else n.add(c.id); setCollapsed(n); }}>{isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}<span>{c.name}</span>{!isCollapsed && kindHint}</button>
                      <span className="tools"><span>{isCollapsed ? total : inCol.length}</span>{canEdit && c.isDone && inCol.length > 0 && !isCollapsed && <Button size="sm" variant="link" loading={archive.busy} title="Alle erledigten Arbeitspakete vom Board nehmen, Historie bleibt" onClick={() => archiveDone(c, total)}>Archivieren</Button>}</span>
                    </h4>
                    {body}
                  </section>
                );
                return (
                  <div key={c.id} className={`column kind-${c.kind} ${over ? 'wip-over' : ''} ${isCollapsed ? 'collapsed' : ''} ${isOver ? 'over' : ''}`} {...dropProps}>
                    <h3>
                      <span>{c.name}{!isCollapsed && kindHint}</span>
                      {!isCollapsed && <span className="tools">
                        <span>{inCol.length}</span>
                        {canEdit && c.isDone && inCol.length > 0 && <Button size="sm" variant="link" loading={archive.busy} title="Alle erledigten Arbeitspakete vom Board nehmen, Historie bleibt" onClick={() => archiveDone(c, total)}>Archivieren</Button>}
                        <button title="Spalte einklappen" aria-label={`Spalte ${c.name} einklappen`} onClick={() => setCollapsed(new Set([...collapsed, c.id]))}><IconCollapse size={14} /></button>
                      </span>}
                      {isCollapsed && <button className="btn sm link" aria-label={`Spalte ${c.name} ausklappen (${total})`} onClick={() => { const n = new Set(collapsed); n.delete(c.id); setCollapsed(n); }}>{total}</button>}
                    </h3>
                    {body}
                  </div>
                );
              };
              if (!bc.group) return section(bc.columns[0], false);
              // Spaltengruppe: ein Kopf mit Gesamtzahl, darunter je Spalte ein Abschnitt
              const gKey = bc.key;
              const gCollapsed = collapsed.has(gKey);
              const gTotal = bc.columns.reduce((n, c) => n + columnCount(c.id), 0);
              const gLane = bc.columns.reduce((n, c) => n + g.tasks.filter((x) => x.columnId === c.id).length, 0);
              return (
                <div key={gKey} className={`column group ${gCollapsed ? 'collapsed' : ''}`} role="group" aria-label={`Spaltengruppe ${bc.group}`}>
                  <h3>
                    <span>{bc.group}</span>
                    {!gCollapsed && <span className="tools">
                      <span title={`${gLane} in dieser Zeile, ${gTotal} gesamt`}>{gLane}</span>
                      <button title="Gruppe einklappen" aria-label={`Gruppe ${bc.group} einklappen`} onClick={() => setCollapsed(new Set([...collapsed, gKey]))}><IconCollapse size={14} /></button>
                    </span>}
                    {gCollapsed && <button className="btn sm link" aria-label={`Gruppe ${bc.group} ausklappen (${gTotal})`} onClick={() => { const n = new Set(collapsed); n.delete(gKey); setCollapsed(n); }}>{gTotal}</button>}
                  </h3>
                  {!gCollapsed && bc.columns.map((c) => section(c, true))}
                </div>
              );
            })}
          </div>}
        </div>
      ); })}
      {lanes && canPlanSp && !f.archived && <InlineCreate open={newSp} onOpen={() => setNewSp(true)} onClose={() => setNewSp(false)} label="+ Teilprojekt" placeholder="Name des Teilprojekts, Enter zum Anlegen" className="add-lane" onCreate={(name) => create.subproject(name)} />}
      {selectMode && canEdit && (
        <div className="bulkbar" role="region" aria-label="Sammelaktionen">
          <strong>{selected.size} ausgewählt</strong>
          <button className="btn sm link" onClick={() => setSelected(new Set(filtered.map((x) => x.id)))}>alle sichtbaren</button>
          <button className="btn sm link" onClick={clearSelection}>aufheben <kbd>Esc</kbd></button>
          <span className="sep" />
          <select aria-label="Spalte" disabled={!selected.size || bulk.busy} value="" onChange={(e) => { const v = e.target.value; const name = detail.columns.find((c) => c.id === v)?.name ?? ''; if (v) void bulkRun(`In Spalte „${name}“ verschieben`, (id) => api.post(`/tasks/${id}/move`, { columnId: v, index: 0 }), { confirmLabel: 'Verschieben' }); }}>
            <option value="">Spalte …</option>{detail.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select aria-label="Teilprojekt" disabled={!selected.size || bulk.busy} value="" onChange={(e) => { const v = e.target.value; if (v) void bulkRun('Teilprojekt ändern', (id) => api.patch(`/tasks/${id}`, { subprojectId: v === 'none' ? null : v }), { confirmLabel: 'Ändern' }); }}>
            <option value="">Teilprojekt …</option><option value="none">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select aria-label="Zuständig" disabled={!selected.size || bulk.busy} value="" onChange={(e) => { const v = e.target.value; if (v) void bulkRun('Zuständigkeit ändern', (id) => api.patch(`/tasks/${id}`, { responsibleUserId: v === 'none' ? null : v, responsibleEmail: null }), { confirmLabel: 'Ändern' }); }}>
            <option value="">Zuständig …</option><option value="none">– geerbt –</option>{detail.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
          <select aria-label="Label hinzufügen" disabled={!selected.size || bulk.busy} value="" onChange={(e) => { const v = e.target.value; if (v) void bulkRun('Label hinzufügen', (id) => { const cur = tasks.find((x) => x.id === id); return api.patch(`/tasks/${id}`, { labelIds: Array.from(new Set([...(cur?.labelIds ?? []), v])) }); }, { confirmLabel: 'Hinzufügen' }); }}>
            <option value="">Label hinzufügen …</option>{detail.labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select aria-label="Priorität" disabled={!selected.size || bulk.busy} value="" onChange={(e) => { const v = e.target.value; if (v) void bulkRun('Priorität ändern', (id) => api.patch(`/tasks/${id}`, { priority: v }), { confirmLabel: 'Ändern' }); }}>
            <option value="">Priorität …</option>{Object.entries(prioLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Button size="sm" disabled={!selected.size || bulk.busy} onClick={() => void bulkRun('Archivieren', (id) => api.post(`/tasks/${id}/archive`), { confirmLabel: 'Archivieren', text: `${selected.size} Arbeitspakete vom Board nehmen? Sie bleiben über den Filter „Archiv“ erreichbar.` })}>Archivieren</Button>
          {detail.project.myMembership.role === 'pl' && <Button size="sm" variant="danger" disabled={!selected.size || bulk.busy} onClick={() => void bulkRun('In den Papierkorb', (id) => api.del(`/tasks/${id}`), { confirmLabel: 'In den Papierkorb', danger: true, text: `${selected.size} Arbeitspakete in den Papierkorb legen? Wiederherstellen in den Projekteinstellungen.` })}>Papierkorb</Button>}
          {bulk.busy && <Loading>läuft …</Loading>}
          {bulk.error && <span className="error small" role="alert">{bulk.error}</span>}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task: x, t, soon, canEdit, dragging, dropMarker, onDragStart, onDragEnd, onDragOverCard, onClick, selectable = false, selected = false, kids = [], kidsOpen = true }: {
  task: Task; t: string; soon: string; canEdit: boolean; dragging: boolean; dropMarker: 'before' | 'after' | null; kids?: Task[]; kidsOpen?: boolean;
  onDragStart: () => void; onDragEnd: () => void; onDragOverCard: (e: React.DragEvent) => void; onClick: (e: React.MouseEvent) => void; selectable?: boolean; selected?: boolean;
}) {
  const { detail } = useProject();
  const dueClass = x.done ? 'done' : x.dueDate && x.dueDate < t ? 'overdue' : x.dueDate && x.dueDate <= soon ? 'soon' : '';
  const labels = x.labelIds.map((id) => detail.labels.find((l) => l.id === id)).filter(Boolean);
  // Fortschritt aus Aufgaben und Checkliste zusammen
  const stepsTotal = x.subtaskTotal + x.checklistTotal; const stepsDone = x.subtaskDone + x.checklistDone;
  const dueTitle = x.done ? 'erledigt' : dueClass === 'overdue' ? 'überfällig' : dueClass === 'soon' ? 'in den nächsten 3 Tagen fällig' : 'Deadline';
  // Aufgabe (aus dem Arbeitspaket oder einer Karte) auf dieses Arbeitspaket ziehen: umhängen (reparent), nicht Status
  const { reloadTasks, tasks: allTasks } = useProject();
  const toast = useToast();
  const [subOver, setSubOver] = useState(false);
  const isSubDrag = (e: React.DragEvent) => canEdit && !x.parentId && Array.from(e.dataTransfer.types).includes(SUBTASK_DRAG);
  const onSubDrop = async (id: string) => {
    if (!id || id === x.id || allTasks.find((k) => k.id === id)?.parentId === x.id) return;
    try { await api.post(`/tasks/${id}/reparent`, { parentId: x.id }); await reloadTasks(); toast.ok(`Aufgabe nach ${detail.project.key}-${x.number} verschoben.`); }
    catch (e: any) { toast.error(`Verschieben fehlgeschlagen: ${e?.message ?? e}`); }
  };
  return (
    <div className={`task-card prio-${x.priority} ${x.done ? 'is-done' : ''} ${dragging ? 'dragging' : ''} ${dropMarker ? `drop-${dropMarker}` : ''} ${subOver ? 'drop-sub' : ''} ${x.recurrence ? 'recurring' : ''} ${x.blocked ? 'blocked' : ''} ${selected ? 'selected' : ''} ${selectable ? 'selectable' : ''}`} draggable={canEdit && !selectable}
      role="button" tabIndex={0} aria-label={`${detail.project.key}-${x.number} ${x.title}${selectable ? (selected ? ' (ausgewählt)' : '') : ' öffnen'}`} aria-pressed={selectable ? selected : undefined}
      onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e as unknown as React.MouseEvent); } }}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }} onDragEnd={onDragEnd}
      onDragOver={(e) => { if (isSubDrag(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; if (!subOver) setSubOver(true); return; } onDragOverCard(e); }}
      onDragLeave={(e) => { if (subOver && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setSubOver(false); }}
      onDrop={(e) => { if (!isSubDrag(e)) return; e.preventDefault(); e.stopPropagation(); setSubOver(false); void onSubDrop(e.dataTransfer.getData(SUBTASK_DRAG)); }}
      onClick={onClick}>
      {(selectable || selected) && <input type="checkbox" className="select-box" checked={selected} readOnly tabIndex={-1} aria-label="Auswählen" />}
      {labels.length > 0 && <div className="labels">{labels.map((l) => <span key={l!.id} className={`lbl full ${l!.color}`}>{l!.name}</span>)}</div>}
      <div className="title">{x.title}</div>
      {x.reviewer && <div className="review-line small" title="Benannte prüfende Person">Prüfung: {x.reviewer.name ?? '?'}</div>}
      {x.wait && <div className={`wait-line small ${x.wait.expiredAt ? 'expired' : ''}`} title={x.wait.expiredAt ? 'Frist ohne Lösung abgelaufen: zurückgestellt' : 'Wartet; ohne Lösung bis zur Frist → Zurückgestellt'}><IconHourglass size={12} /> {x.wait.reason}{x.wait.until ? ` · bis ${fmtDate(x.wait.until.slice(0, 10))}` : ''}{x.wait.expiredAt ? ' · Frist abgelaufen' : ''}</div>}
      <div className="badges">
        <span className="tkey" title="Kennung">{detail.project.key}-{x.number}</span>
        {x.blocked && <span className="badge blocked" title={x.blockedReason ?? 'blockiert'}>Blockiert</span>}
        {x.escalationLevel > 0 && <span className={`badge esc${x.escalationLevel}`} title="Eskalationsstufe">Esk. {x.escalationLevel}</span>}
        {x.priority !== 'normal' && <span className={`badge prio-${x.priority}`}>{prioLabel[x.priority]}</span>}
        {x.dueDate && <span className={`due ${dueClass}`} title={dueTitle}>{x.done ? <IconCheck size={12} /> : <IconClock size={12} />}<span className="sr-only">{dueTitle} </span>{fmtDate(x.dueDate)}</span>}
        {x.conflicts.length > 0 && <span className="conflict" title={x.conflicts.join('\n')}><IconAlert size={12} /><span className="sr-only">Terminkonflikt</span></span>}
        {x.workflowRunId && <Link to={`/workflows/laeufe/${x.workflowRunId}`} title="Aus einem Workflow-Lauf" aria-label="Workflow-Lauf öffnen" onClick={(e) => e.stopPropagation()}><IconRotate size={12} /></Link>}
        {x.commentCount > 0 && <span title="Log-Einträge"><IconComment size={12} /><span className="sr-only">Log-Einträge</span> {x.commentCount}</span>}
        {/* Aufgaben zählt die Liste unten; hier nur die Checkliste */}
        {x.checklistTotal > 0 && kids.length > 0 ? <span title={`Checkliste: ${x.checklistDone}/${x.checklistTotal}`} className={x.checklistDone === x.checklistTotal ? 'ok' : ''}><IconCheckSquare size={12} /><span className="sr-only">Checkliste</span> {x.checklistDone}/{x.checklistTotal}</span>
          : stepsTotal > 0 && kids.length === 0 && <span title={`Erledigt: ${x.checklistDone}/${x.checklistTotal} Checkliste`} className={stepsDone === stepsTotal ? 'ok' : ''}><IconCheckSquare size={12} /><span className="sr-only">Erledigt</span> {stepsDone}/{stepsTotal}</span>}
        <span className="right who" title={x.responsible.inherited ? `${x.responsible.name ?? ''} (geerbt vom ${x.responsible.inheritedFrom === 'task' ? 'Arbeitspaket' : x.responsible.inheritedFrom === 'subproject' ? 'Teilprojekt' : 'PL'})` : x.responsible.name ?? x.responsible.email ?? ''}>
          {x.responsible.userId ? <span className={x.responsible.inherited ? 'avatar-wrap inherited' : 'avatar-wrap'}><Initials name={x.responsible.name} /></span> : x.responsible.name ? <span className="avatar-wrap external" title={`${x.responsible.name} (extern)`}><Initials name={x.responsible.name} /></span> : <span className="badge">{x.responsible.email ? 'extern' : '–'}</span>}
        </span>
      </div>
      {stepsTotal > 0 && <div className={`progress ${stepsDone === stepsTotal ? 'complete' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={stepsTotal} aria-valuenow={stepsDone} aria-label="Fortschritt"><div style={{ width: `${Math.round((stepsDone / stepsTotal) * 100)}%` }} /></div>}
      {kids.length > 0 && <CardSubtasks kids={kids} open={kidsOpen} canEdit={canEdit && !selectable} />}
      {canEdit && !selectable && <StatusMenu task={x} />}
    </div>
  );
}

/**
 * Status ohne Ziehen (Telefon, Tastatur): „→“ auf der Karte öffnet die Spalten, „Erledigt“ zuerst. Gleicher Weg wie Ziehen
 * (/tasks/:id/move), an den Anfang der Zielspalte. Auf Touch-Geräten immer sichtbar (CSS pointer: coarse / hover: none).
 */
function StatusMenu({ task }: { task: Task }) {
  const { detail, reloadTasks } = useProject();
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAsync({ toast: true });
  const done = detail.columns.find((c) => c.isDone);
  const dialog = useDialog();
  const move = (columnId: string) => void run(async () => { setOpen(false); if (await moveTaskTo(dialog.form, task.id, detail.columns.find((c) => c.id === columnId)!, 0, reviewOptsOf(detail, task.reviewer?.userId))) await reloadTasks(); });
  return (
    <div className="status-menu" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false); }}>
      <button className="btn sm link status-btn" aria-label="Status ändern" aria-haspopup="menu" aria-expanded={open} title="Status ändern" onClick={() => setOpen((o) => !o)}><IconArrowRight size={14} /></button>
      {open && <div className="status-pop" role="menu" aria-label="Status">
        {done && !task.done && <button role="menuitem" className="btn sm primary" disabled={busy} onClick={() => move(done.id)}><IconCheck /> Erledigt</button>}
        {detail.columns.filter((c) => c.id !== task.columnId && c.id !== (task.done ? '' : done?.id)).map((c) => <button key={c.id} role="menuitem" className="btn sm" disabled={busy} onClick={() => move(c.id)}>{c.name}</button>)}
        {error && <span className="error small">{error}</span>}
      </div>}
    </div>
  );
}

function QuickAdd({ columnId, subprojectId, workflow, open, onOpen, onClose }: { columnId: string; subprojectId: string | null; workflow: boolean; open: boolean; onOpen: () => void; onClose: () => void }) {
  const { reloadTasks } = useProject();
  const create = useCreate();
  const [wf, setWf] = useState<'pick' | WorkflowDef | null>(null);
  return (
    <div className="col-add">
      {/* Titel genügt, danach öffnet die Maske mit allen Feldern; ohne Titel entsteht nichts */}
      <InlineCreate open={open} onOpen={onOpen} onClose={onClose} label="+ Arbeitspaket" placeholder="Titel eingeben, Enter zum Anlegen" onCreate={(title) => create.task({ title, columnId, subprojectId })} />
      {workflow && !open && <button className="btn sm link" title="Workflow statt eines einzelnen Arbeitspakets starten: die Arbeitspakete des Ablaufs landen in dieser Spalte" onClick={() => setWf('pick')}>+ Workflow</button>}
      {wf === 'pick' && <WorkflowPicker onPick={(d) => setWf(d)} onClose={() => setWf(null)} />}
      {wf && wf !== 'pick' && <StartRunDialog def={wf} columnId={columnId} subprojectId={subprojectId} onClose={() => setWf(null)} onStarted={async () => { setWf(null); await reloadTasks(); }} />}
    </div>
  );
}

/** Deutlicher Anlegen-Knopf, der zum Eingabefeld wird: Titel bzw. Name, Enter legt an und öffnet die Maske; leer oder Esc legt nichts an. */
export function InlineCreate({ open, onOpen, onClose, label, placeholder, onCreate, className = '' }: { open: boolean; onOpen: () => void; onClose: () => void; label: string; placeholder: string; onCreate: (title: string) => Promise<unknown>; className?: string }) {
  const [title, setTitle] = useState('');
  const { busy, error, run } = useAsync();
  const close = () => { setTitle(''); onClose(); };
  const submit = () => { const t = title.trim(); if (!t) { close(); return; } void run(async () => { await onCreate(t); close(); }); };
  if (!open) return <button className={`add-btn ${className}`} onClick={onOpen}>{label}</button>;
  return (
    <div className={`quick-add ${className}`}>
      <textarea autoFocus aria-label={placeholder} placeholder={placeholder} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (!title.trim()) close(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') close(); }} />
      <div className="row"><Button size="sm" variant="primary" loading={busy} disabled={!title.trim()} onMouseDown={(e) => e.preventDefault()} onClick={submit}>Anlegen</Button><IconButton label="Abbrechen" size="sm" onClick={close}><IconX /></IconButton><span className="muted small right">danach öffnet die Maske</span></div>
      {error && <div className="error small" role="alert">{error}</div>}
    </div>
  );
}

function SubprojectResp({ id }: { id: string }) {
  const { detail } = useProject();
  const s = detail.subprojects.find((x) => x.id === id);
  if (!s) return null;
  return <span className="muted small fw-400">{s.restricted && <span title="Eingeschränkt sichtbar"><IconLock size={12} /><span className="sr-only">eingeschränkt sichtbar</span> </span>}verantwortlich {s.responsible.name ?? '–'}{s.responsible.inherited ? ' (geerbt vom PL)' : ''}{s.startDate && ` · ${fmtDate(s.startDate)} – ${fmtDate(s.endDate)}`} · <Link to={`/projekte/${detail.project.id}/plan#sp-${s.id}`}>Plan</Link></span>;
}

/** Labels am Arbeitspaket umschalten; neues Label anlegen (Name Pflicht, Fehler sichtbar). */
export function LabelPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { detail, reload } = useProject();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('blue');
  const { busy, error, run, setError } = useAsync();
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const add = () => {
    const n = name.trim();
    if (!n) { setError('Name des Labels fehlt.'); return; }
    if (detail.labels.some((l) => l.name.toLowerCase() === n.toLowerCase())) { setError('Label gibt es schon.'); return; }
    void run(async () => { const r = await api.post<{ label: { id: string } }>(`/projects/${detail.project.id}/labels`, { name: n, color }); await reload(); onChange([...value, r.label.id]); setAdding(false); setName(''); });
  };
  return (
    <div className="row gap-1 label-picker">
      {detail.labels.map((l) => <button key={l.id} type="button" className={`lbl full ${l.color} ${value.includes(l.id) ? 'on' : 'off'}`} aria-pressed={value.includes(l.id)} onClick={() => toggle(l.id)}>{l.name}</button>)}
      {!adding ? <button type="button" className="btn sm link" onClick={() => setAdding(true)}>+ Label</button> : (
        <span className="row gap-1">
          <input type="text" aria-label="Name des Labels" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') { setAdding(false); setName(''); setError(null); } }} placeholder="Name" className="w-110" autoFocus />
          <select aria-label="Farbe" value={color} onChange={(e) => setColor(e.target.value)} className="w-auto">{LABEL_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <Button size="sm" loading={busy} onClick={add}>OK</Button>
          {error && <span className="error small" role="alert">{error}</span>}
        </span>
      )}
    </div>
  );
}

/** Auswahl eines Workflows zum Start aus dem Board. */
function WorkflowPicker({ onPick, onClose }: { onPick: (d: WorkflowDef) => void; onClose: () => void }) {
  const { detail } = useProject();
  const d = useData<{ definitions: WorkflowDef[] }>(`/projects/${detail.project.id}/workflows`);
  const defs = (d.data?.definitions ?? []).filter((x) => x.active);
  return (
    <Modal title="Workflow starten" onClose={onClose}>
      {!d.data && <Loading />}
      {d.data && defs.length === 0 && <div className="muted small">Noch kein Workflow definiert. Unter „Workflows“ anlegen.</div>}
      <div className="form">{defs.map((w) => <button key={w.id} className="btn text-left" onClick={() => onPick(w)}><strong>{w.name}</strong>{w.description && <span className="muted small"> · {w.description}</span>}<span className="muted small"> · {w.steps.length} Schritte</span></button>)}</div>
    </Modal>
  );
}

/**
 * Aufgaben in der Karte ihres Arbeitspakets: bleiben beim Arbeitspaket, egal in welchem Status. Häkchen erledigt, Status direkt
 * umschaltbar, Klick auf den Titel öffnet das Arbeitspaket mit der Aufgabe aufgeklappt.
 */
function CardSubtasks({ kids, open: initial, canEdit }: { kids: Task[]; open: boolean; canEdit: boolean }) {
  const { detail, reloadTasks, openTask } = useProject();
  const dialog = useDialog();
  const [open, setOpen] = useState(initial);
  useEffect(() => setOpen(initial), [initial]);
  const { busy, run } = useAsync({ toast: true });
  const done = kids.filter((k) => k.done).length;
  const doneCol = detail.columns.find((c) => c.kind === 'done') ?? detail.columns.find((c) => c.isDone);
  const openCol = detail.columns.find((c) => c.kind === 'active') ?? detail.columns.find((c) => !c.isDone);
  const move = (k: Task, colId: string) => run(async () => { const col = detail.columns.find((c) => c.id === colId); if (col && (await moveTaskTo(dialog.form, k.id, col, null, reviewOptsOf(detail, k.reviewer?.userId)))) await reloadTasks(); });
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="card-subs" onClick={stop} onMouseDown={stop} onKeyDown={stop} onDragStart={(e) => { e.stopPropagation(); if (!(e.target as HTMLElement).closest('[data-subtask]')) e.preventDefault(); }} draggable={false}>
      <button className="card-subs-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Aufgaben einklappen' : 'Aufgaben aufklappen'}>{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />} {done}/{kids.length} Aufgaben</button>
      {open && <ul>{kids.map((k) => <li key={k.id} className={k.done ? 'done' : ''} data-subtask={k.id} draggable={canEdit} title={canEdit ? 'Auf ein anderes Arbeitspaket ziehen, um die Aufgabe dorthin zu verschieben' : undefined}
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(SUBTASK_DRAG, k.id); e.dataTransfer.setData('text/plain', k.title); e.dataTransfer.effectAllowed = 'move'; }}>
        <input type="checkbox" checked={k.done} disabled={!canEdit || busy} title={k.done ? 'Wieder öffnen' : 'Erledigt'} aria-label={`${k.title}: ${k.done ? 'wieder öffnen' : 'erledigt'}`} onChange={() => { const col = k.done ? openCol : doneCol; if (col) void move(k, col.id); }} />
        <button className="sub-title" title="Im Arbeitspaket öffnen" onClick={() => openTask(k.id)}>{k.title}</button>
        {!k.done && <span className="sub-meta">
          <select className="sub-status" value={k.columnId} disabled={!canEdit || busy} title="Status der Aufgabe" aria-label="Status der Aufgabe" onChange={(e) => void move(k, e.target.value)}>{detail.columns.filter((c) => !c.isDone).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          {k.dueDate && <span className={`sub-due ${k.dueDate < today() ? 'overdue' : ''}`}>{fmtDate(k.dueDate)}</span>}
          <span className="sub-who" title={k.responsible.name ?? k.responsible.email ?? ''}>{k.responsible.name ? <Initials name={k.responsible.name} /> : null}</span>
        </span>}
      </li>)}</ul>}
    </div>
  );
}

const HINT_KEY = (id: string) => `pt:assistant-hint:${id}`;
const hintDismissed = (id: string) => { try { return localStorage.getItem(HINT_KEY(id)) === '1'; } catch { return false; } };

/** Persönliches Projekt ohne Assistenten: Hinweis zum Einrichten (Einstellungen › KI), schließbar und je Projekt gemerkt. */
export function AssistantHint({ projectId }: { projectId: string }) {
  const [closed, setClosed] = useState(() => hintDismissed(projectId));
  const st = useData<{ assistant: { id: string } | null }>(closed ? null : `/projects/${projectId}/assistant`, [projectId]);
  if (closed || !st.data || st.data.assistant) return null;
  const close = () => { try { localStorage.setItem(HINT_KEY(projectId), '1'); } catch { /* privater Modus */ } setClosed(true); };
  return (
    <div className="notice ok small mb row between gap-2 assistant-hint" role="status">
      <span><strong>Richte deinen Assistenten ein.</strong> Dein persönlicher KI-Assistent legt aus Chat und Mails Aufgaben und Termine an: <Link to={`/projekte/${projectId}/einstellungen/ki`}>Einstellungen › KI</Link>.</span>
      <IconButton label="Hinweis schließen" size="sm" onClick={close}><IconX /></IconButton>
    </div>
  );
}

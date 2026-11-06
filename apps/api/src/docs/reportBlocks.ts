import type { ReportBlock, ReportBlockType, ReportPeriod, User } from '@projekttool/shared';
import { DEFAULT_REPORT_BLOCKS, REPORT_BLOCK_LABEL } from '@projekttool/shared';
import type { Db } from '../db.js';
import type { AiConfig } from '../ai/client.js';
import { loadTasks } from '../tasks/service.js';
import { evaluateProject, LEVEL_LABEL, type EscalationRow } from '../tasks/escalation.js';
import { computedColor, healthOf } from '../routes/portfolio.js';
import { mdToHtml, sanitizeHtml } from './html.js';
import { managementSummary } from '../ai/service.js';

/**
 * Blockbasierter Management-Report (Regel vor KI): jeder Block liest seine Fakten aus dem Projekt, rendert eine Tabelle
 * oder Liste und wahlweise ein Diagramm als SVG (Balken, Fortschritt, Zeitstrahl – nur rect/text/line/circle, damit die
 * PDF-Ausgabe sie als Vektor zeichnet). Die gesammelten Fakten gehen strukturiert an die Management-Summary (KI-Text
 * des Projektagenten oder regelbasierte Satzbausteine aus denselben Zahlen).
 */
export interface BlockContext {
  today: string;
  lastRunOn?: string | null;
  /** Diagramme erzeugen (Block.chart !== false) */
  graphic?: boolean;
  /** ai: Management-Summary vom Projektagenten (cfg erforderlich), sonst regelbasiert */
  textSource?: 'rules' | 'ai';
  user?: User | null;
  cfg?: AiConfig | null;
  fetchFn?: typeof fetch;
  /** Grund, warum keine KI zur Verfügung steht (erscheint als Hinweis beim KI-Block) */
  aiUnavailable?: string | null;
}

export type ReportFacts = Record<string, unknown> & { project: { id: string; key: string; name: string }; today: string };

export const REPORT_BLOCK_TYPES: ReportBlockType[] = ['summary', 'changes', 'overdue', 'blocked', 'milestones', 'subprojects', 'risks', 'time', 'decisions', 'outlook', 'ai_summary', 'text'];
const PERIODS: ReportPeriod[] = ['since_last', 'week', 'month', 'quarter', 'days'];

// ---- Datum

export const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400_000);
export const d10 = (iso: string | null | undefined) => { if (!iso) return '–'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}.${m}.${y}`; };
const dShort = (iso: string) => { const [, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}.`; };
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monthLabel = (iso: string) => { const [y, m] = iso.slice(0, 10).split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };

/**
 * Zeitraum eines Blocks: seit dem letzten Bericht (ohne: 7 Tage), Woche = 7, Monat = 30, Quartal = 90 Tage oder n Tage.
 * Label „seit 30.10.2026“ bei since_last mit bekanntem Lauf, sonst „letzte 30 Tage“.
 */
export function periodRange(period: ReportPeriod | undefined, days: number | undefined, lastRunOn: string | null | undefined, today: string): { since: string; label: string; days: number } {
  const p = period && PERIODS.includes(period) ? period : 'since_last';
  if (p === 'since_last' && lastRunOn && /^\d{4}-\d{2}-\d{2}$/.test(lastRunOn) && lastRunOn < today) return { since: lastRunOn, label: `seit ${d10(lastRunOn)}`, days: daysBetween(lastRunOn, today) };
  const n = p === 'days' ? Math.max(1, Math.min(365, Math.round(Number(days) || 7))) : p === 'week' || p === 'since_last' ? 7 : p === 'month' ? 30 : 90;
  return { since: addDays(today, -n), label: `letzte ${n} Tage`, days: n };
}

// ---- Normalisierung der Blockliste (Policy, Vorschau, Portfolio)

export function normalizeBlocks(raw: unknown): ReportBlock[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ReportBlock[] = [];
  for (const [i, b] of raw.entries()) {
    if (!b || typeof b !== 'object' || !REPORT_BLOCK_TYPES.includes((b as any).type)) continue;
    const x = b as any;
    const blk: ReportBlock = { id: typeof x.id === 'string' && x.id.trim() ? x.id.trim().slice(0, 40) : `b${i + 1}`, type: x.type };
    if (typeof x.title === 'string' && x.title.trim()) blk.title = x.title.trim().slice(0, 120);
    if (PERIODS.includes(x.period)) blk.period = x.period;
    if (x.days != null && Number.isFinite(Number(x.days))) blk.days = Math.max(1, Math.min(365, Math.round(Number(x.days))));
    if (typeof x.chart === 'boolean') blk.chart = x.chart;
    if (x.limit != null && Number.isFinite(Number(x.limit))) blk.limit = Math.max(1, Math.min(100, Math.round(Number(x.limit))));
    if (typeof x.text === 'string') blk.text = x.text.slice(0, 20000);
    out.push(blk);
    if (out.length >= 30) break;
  }
  return out;
}

// ---- HTML- und SVG-Bausteine

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const COLOR = { green: '#2e7d32', yellow: '#f9a825', red: '#d32f2f', accent: '#1f5eff', grey: '#d9dee7', text: '#111111', muted: '#666666', light: '#f3f5f9', done: '#2e7d32', open: '#9aa7bd' } as const;
const AMPEL_LABEL = { green: 'Grün', yellow: 'Gelb', red: 'Rot' } as const;
type Ampel = 'green' | 'yellow' | 'red';
const hhmm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;

function table(head: string[], rows: string[][]): string {
  if (!rows.length) return '<p>–</p>';
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
const list = (xs: string[]) => (xs.length ? `<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p>–</p>');
const more = (total: number, shown: number) => (total > shown ? `<p>… und ${total - shown} weitere</p>` : '');

const svgOpen = (w: number, h: number, label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">`;
const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 0) => `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(Math.max(0, w))}" height="${r1(h)}" rx="${rx}" fill="${fill}"></rect>`;
const text = (x: number, y: number, s: string, o: { size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; bold?: boolean } = {}) =>
  `<text x="${r1(x)}" y="${r1(y)}" font-size="${o.size ?? 11}" fill="${o.fill ?? COLOR.text}" text-anchor="${o.anchor ?? 'start'}"${o.bold ? ' font-weight="bold"' : ''} font-family="Helvetica, Arial, sans-serif">${esc(s)}</text>`;
const line = (x1: number, y1: number, x2: number, y2: number, stroke: string = COLOR.grey, w = 1, dash?: string) => `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}></line>`;
const circle = (cx: number, cy: number, r: number, fill: string) => `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r}" fill="${fill}"></circle>`;
const r1 = (n: number) => Math.round(n * 10) / 10;
/** Zeitstempel aus der Datenbank (Date oder String) als ISO-Text */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const chart = (svg: string) => `<div class="report-chart">${svg}</div>`;
const cutLabel = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Horizontale Balken: Beschriftung links, Balken proportional zum Maximum, Wert rechts. */
function hbars(rows: { label: string; value: number; color?: string; valueText?: string; secondary?: number; secondaryColor?: string }[], title: string, unit = ''): string {
  const W = 600, rowH = 22, labelW = 190, top = 6;
  const H = top + rows.length * rowH + 4;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.value, r.secondary ?? 0)));
  const barW = W - labelW - 70;
  let s = svgOpen(W, H, title);
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    s += text(labelW - 8, y + 15, cutLabel(r.label, 32), { anchor: 'end', size: 10.5 });
    s += rect(labelW, y + 4, barW, 14, COLOR.light, 3);
    if (r.secondary != null) s += rect(labelW, y + 4, (barW * r.secondary) / max, 14, r.secondaryColor ?? COLOR.grey, 3);
    s += rect(labelW, y + 4, (barW * r.value) / max, 14, r.color ?? COLOR.accent, 3);
    s += text(labelW + barW + 6, y + 15, r.valueText ?? `${r.value}${unit}`, { size: 10.5, fill: COLOR.muted });
  });
  return chart(s + '</svg>');
}

/** Gruppierte Säulen je Kategorie (z. B. Woche): zwei Reihen mit Legende. */
function columns(cats: { label: string; a: number; b: number }[], names: [string, string], title: string): string {
  const W = 600, H = 170, left = 36, bottom = 30, top = 24;
  const max = Math.max(1, ...cats.flatMap((c) => [c.a, c.b]));
  const plotH = H - top - bottom, plotW = W - left - 10;
  const slot = plotW / Math.max(1, cats.length), bw = Math.min(28, slot / 3);
  let s = svgOpen(W, H, title);
  const steps = Math.min(4, max);
  for (let i = 0; i <= steps; i++) {
    const v = (max * i) / steps, y = top + plotH - (plotH * i) / steps;
    s += line(left, y, W - 10, y, i === 0 ? '#9aa7bd' : COLOR.grey);
    s += text(left - 6, y + 4, String(Math.round(v)), { anchor: 'end', size: 9, fill: COLOR.muted });
  }
  cats.forEach((c, i) => {
    const x = left + i * slot + slot / 2;
    s += rect(x - bw - 2, top + plotH - (plotH * c.a) / max, bw, (plotH * c.a) / max, COLOR.done, 2);
    s += rect(x + 2, top + plotH - (plotH * c.b) / max, bw, (plotH * c.b) / max, COLOR.accent, 2);
    s += text(x, H - 12, c.label, { anchor: 'middle', size: 9.5, fill: COLOR.muted });
  });
  s += rect(left, 4, 10, 10, COLOR.done, 2) + text(left + 14, 13, names[0], { size: 10 });
  s += rect(left + 110, 4, 10, 10, COLOR.accent, 2) + text(left + 124, 13, names[1], { size: 10 });
  return chart(s + '</svg>');
}

/** Ampel als Text mit Farbe (kein Symbol: die PDF-Schrift kennt keine Kreise) */
const ampelDot = (c: Ampel | null) => (c ? `<span style="color: ${COLOR[c]}"><strong>${AMPEL_LABEL[c]}</strong></span>` : '–');

// ---- Projektdaten (einmal je Bericht geladen, von allen Blöcken genutzt)

type TaskRow = Awaited<ReturnType<typeof loadTasks>>[number];

class ProjectData {
  private tasksP?: Promise<TaskRow[]>;
  private escP?: Promise<EscalationRow[]>;
  private subsP?: Promise<{ id: string; name: string }[]>;
  constructor(readonly db: Db, readonly project: { id: string; key: string; name: string; health: any }, readonly today: string) {}
  tasks() { return (this.tasksP ??= loadTasks(this.db, `t.project_id = $1 and t.archived_at is null and t.deleted_at is null`, [this.project.id])); }
  escalations() { return (this.escP ??= evaluateProject(this.db, this.project.id, this.today).catch(() => [] as EscalationRow[])); }
  subprojects() { return (this.subsP ??= this.db.query(`select id, name from subprojects where project_id = $1 order by position, name`, [this.project.id]).then((r) => r.rows)); }
  code(t: { number: number }) { return `${this.project.key}-${t.number}`; }
  async summary() {
    const all = await this.tasks();
    const tasks = all.filter((t) => !t.parentId);
    const open = tasks.filter((t) => !t.done);
    const done = tasks.length - open.length;
    const overdue = open.filter((t) => t.dueDate && t.dueDate < this.today);
    const blocked = open.filter((t) => t.blocked);
    const escalated = open.filter((t) => t.escalationLevel >= 2);
    const escalations = (await this.escalations()).filter((e) => e.targetLevel > 0);
    const dueWeek = open.filter((t) => t.dueDate && t.dueDate >= this.today && t.dueDate <= addDays(this.today, 7));
    const planned = tasks.filter((t) => t.dueDate && t.dueDate <= this.today);
    const plannedDone = planned.filter((t) => t.done).length;
    const minutes = (await this.db.maybeOne(`select coalesce(sum(minutes),0)::int as m from time_entries where project_id = $1`, [this.project.id]).catch(() => null))?.m ?? 0;
    const stats = { open: open.length, overdue: overdue.length, blocked: blocked.length, escalated: escalated.length, dueWeek: dueWeek.length };
    const health = healthOf(this.project.health);
    const computed = computedColor(stats);
    return {
      color: (health.color ?? computed) as Ampel, computed, healthSet: health.color, healthNote: health.note,
      total: tasks.length, open: open.length, done, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
      planned: planned.length, plannedDone, plannedPct: planned.length ? Math.round((plannedDone / planned.length) * 100) : 100,
      overdue: overdue.length, blocked: blocked.length, escalations: escalations.length, escalationsHigh: escalations.filter((e) => e.targetLevel >= 2).length, dueWeek: dueWeek.length, minutes
    };
  }
}

// ---- Blöcke

interface Rendered { html: string; facts?: unknown }
type Renderer = (data: ProjectData, block: ReportBlock, ctx: BlockContext) => Promise<Rendered>;

const summaryBlock: Renderer = async (data, block, ctx) => {
  const s = await data.summary();
  const rows: string[][] = [
    ['Ampel', `${ampelDot(s.color)}${s.healthSet ? ' (laut Projektleitung' + (s.healthNote ? `: ${esc(s.healthNote)}` : '') + ')' : ' (berechnet)'}`],
    ['Fortschritt', `${s.done} von ${s.total} Arbeitspaketen erledigt (${s.pct} %)`],
    ['Soll / Ist (fällig bis heute)', `${s.planned} geplant / ${s.plannedDone} erledigt (${s.plannedPct} %)`],
    ['Arbeitspakete gesamt / offen / erledigt', `${s.total} / ${s.open} / ${s.done}`],
    ['Überfällig', String(s.overdue)], ['Blockiert', String(s.blocked)], ['Eskalationen', String(s.escalations)],
    ['Gebuchte Zeit (gesamt)', hhmm(s.minutes)]
  ];
  let html = '';
  if (ctx.graphic !== false && block.chart !== false) {
    const W = 600, H = 92;
    let svg = svgOpen(W, H, 'Fortschritt und Ampel');
    svg += circle(16, 18, 11, COLOR[s.color]) + text(34, 22, `Ampel ${AMPEL_LABEL[s.color]}`, { size: 12, bold: true });
    svg += text(W, 22, `Stand ${d10(ctx.today)}`, { anchor: 'end', size: 10, fill: COLOR.muted });
    svg += rect(6, 34, W - 12, 16, COLOR.light, 8) + rect(6, 34, ((W - 12) * s.pct) / 100, 16, COLOR.done, 8);
    const soll = ((W - 12) * (s.total ? s.planned / s.total : 0)) / 1;
    svg += line(6 + soll, 30, 6 + soll, 54, COLOR.text, 1.5) + text(Math.min(W - 40, Math.max(30, 6 + soll)), 64, `Soll ${s.planned}`, { anchor: 'middle', size: 9, fill: COLOR.muted });
    svg += text(W / 2, 46, `${s.pct} % erledigt (${s.done} / ${s.total})`, { anchor: 'middle', size: 10, fill: s.pct > 55 ? '#ffffff' : COLOR.text, bold: true });
    const tiles: [string, string, string][] = [['Überfällig', String(s.overdue), s.overdue ? COLOR.red : COLOR.done], ['Blockiert', String(s.blocked), s.blocked ? COLOR.red : COLOR.done], ['Eskalationen', String(s.escalations), s.escalations ? COLOR.yellow : COLOR.done], ['Fällig 7 Tage', String(s.dueWeek), COLOR.accent]];
    const tw = (W - 12 - 3 * 8) / 4;
    tiles.forEach(([k, v, c], i) => { const x = 6 + i * (tw + 8); svg += rect(x, 70, tw, 20, COLOR.light, 4) + rect(x, 70, 4, 20, c, 2) + text(x + 10, 84, k, { size: 9.5, fill: COLOR.muted }) + text(x + tw - 8, 84, v, { anchor: 'end', size: 11, bold: true }); });
    html += chart(svg + '</svg>');
  }
  html += table(['Kennzahl', 'Wert'], rows);
  return { html, facts: s };
};

const changesBlock: Renderer = async (data, block, ctx) => {
  const { since, label } = periodRange(block.period, block.days, ctx.lastRunOn, ctx.today);
  const limit = block.limit ?? 15;
  const tasks = await data.tasks();
  const inPeriod = (ts: string) => ts.slice(0, 10) >= since;
  const done = tasks.filter((t) => t.done && inPeriod(iso(t.updatedAt))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const created = tasks.filter((t) => inPeriod(iso(t.createdAt))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const audit = await data.db.query(
    `select a.action, a.details, a.created_at, t.number, t.title from audit_log a join tasks t on t.id::text = a.object_id
     where a.project_id = $1 and a.object_type = 'task' and a.created_at >= $2::date and t.deleted_at is null
       and (a.action = 'task.move' or (a.action = 'task.update' and (a.details ? 'dueDate' or a.details ? 'responsibleUserId' or a.details ? 'columnId')))
     order by a.created_at desc limit 200`, [data.project.id, since]).catch(() => ({ rows: [] as any[] }));
  const seen = new Set<string>();
  const dates: { code: string; title: string; to: string | null; on: string }[] = [];
  const status: { code: string; title: string; from: string; to: string; on: string }[] = [];
  const assigned: { code: string; title: string; to: string; on: string }[] = [];
  const names = new Map<string, string>();
  const cols = audit.rows.some((a: any) => a.details?.columnId) ? new Map((await data.db.query(`select id, name from board_columns where project_id = $1`, [data.project.id])).rows.map((c: any) => [c.id, c.name as string])) : new Map<string, string>();
  for (const a of audit.rows) {
    const code = data.code(a); const on = iso(a.created_at).slice(0, 10);
    if (a.action === 'task.move' && a.details?.to) { if (!seen.has('m' + code)) { seen.add('m' + code); status.push({ code, title: a.title, from: String(a.details.from ?? '–'), to: String(a.details.to), on }); } continue; }
    if (a.details?.columnId && !seen.has('m' + code)) { seen.add('m' + code); status.push({ code, title: a.title, from: '–', to: cols.get(a.details.columnId) ?? 'anderer Status', on }); }
    if ('dueDate' in (a.details ?? {}) && !seen.has('d' + code)) { seen.add('d' + code); dates.push({ code, title: a.title, to: a.details.dueDate ?? null, on }); }
    if ('responsibleUserId' in (a.details ?? {}) && !seen.has('r' + code)) {
      seen.add('r' + code);
      const uid = a.details.responsibleUserId;
      let name = uid ? names.get(uid) : '–';
      if (uid && !name) { name = (await data.db.maybeOne(`select name from users where id = $1`, [uid]).catch(() => null))?.name ?? '?'; names.set(uid, name!); }
      assigned.push({ code, title: a.title, to: name ?? '–', on });
    }
  }
  let html = `<p>Zeitraum: ${esc(label)} (bis ${d10(ctx.today)})</p>`;
  if (ctx.graphic !== false && block.chart !== false) {
    const weeks: { label: string; a: number; b: number }[] = [];
    const span = Math.max(1, daysBetween(since, ctx.today));
    const step = span <= 14 ? 1 : 7;
    for (let s = since; s < ctx.today; s = addDays(s, step)) {
      const e = addDays(s, step);
      weeks.push({ label: step === 1 ? dShort(s) : `ab ${dShort(s)}`, a: done.filter((t) => iso(t.updatedAt).slice(0, 10) >= s && iso(t.updatedAt).slice(0, 10) < e).length, b: created.filter((t) => iso(t.createdAt).slice(0, 10) >= s && iso(t.createdAt).slice(0, 10) < e).length });
      if (weeks.length >= 16) break;
    }
    if (weeks.length) html += columns(weeks, ['erledigt', 'neu'], `Erledigt und neu ${label}`);
  }
  html += `<h3>Erledigt (${done.length})</h3>${list(done.slice(0, limit).map((t) => `${esc(data.code(t))} ${esc(t.title)}`))}${more(done.length, limit)}`;
  html += `<h3>Neu angelegt (${created.length})</h3>${list(created.slice(0, limit).map((t) => `${esc(data.code(t))} ${esc(t.title)}${t.dueDate ? ` (fällig ${d10(t.dueDate)})` : ''}`))}${more(created.length, limit)}`;
  html += `<h3>Termine verschoben (${dates.length})</h3>${list(dates.slice(0, limit).map((x) => `${esc(x.code)} ${esc(x.title)} → ${x.to ? d10(x.to) : 'ohne Termin'} (am ${d10(x.on)})`))}`;
  html += `<h3>Statuswechsel (${status.length})</h3>${list(status.slice(0, limit).map((x) => `${esc(x.code)} ${esc(x.title)}: ${esc(x.from)} → ${esc(x.to)} (am ${d10(x.on)})`))}`;
  html += `<h3>Zuständigkeit gewechselt (${assigned.length})</h3>${list(assigned.slice(0, limit).map((x) => `${esc(x.code)} ${esc(x.title)} → ${esc(x.to)} (am ${d10(x.on)})`))}`;
  return { html, facts: { since, label, done: done.slice(0, limit).map((t) => t.title), created: created.slice(0, limit).map((t) => t.title), doneCount: done.length, createdCount: created.length, datesMoved: dates.length, statusChanges: status.length, reassigned: assigned.length } };
};

const overdueBlock: Renderer = async (data, block, ctx) => {
  const limit = block.limit ?? 10;
  const rows = (await data.tasks()).filter((t) => !t.done && t.dueDate && t.dueDate < ctx.today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const facts = rows.slice(0, limit).map((t) => ({ code: data.code(t), title: t.title, dueDate: t.dueDate, days: daysBetween(t.dueDate!, ctx.today), responsible: t.responsible.name ?? t.responsible.email ?? '–' }));
  return { html: table(['Kennung', 'Arbeitspaket', 'Fällig', 'Tage', 'Zuständig'], facts.map((f) => [esc(f.code), esc(f.title), d10(f.dueDate), String(f.days), esc(f.responsible)])) + more(rows.length, limit), facts: { count: rows.length, items: facts } };
};

const blockedBlock: Renderer = async (data, block) => {
  const limit = block.limit ?? 10;
  const blocked = (await data.tasks()).filter((t) => !t.done && t.blocked);
  const esc$ = (await data.escalations()).filter((e) => e.targetLevel > 0);
  const html = `<h3>Blockiert (${blocked.length})</h3>${table(['Kennung', 'Arbeitspaket', 'Grund', 'Zuständig'], blocked.slice(0, limit).map((t) => [esc(data.code(t)), esc(t.title), esc(t.blockedReason ?? '–'), esc(t.responsible.name ?? t.responsible.email ?? '–')]))}${more(blocked.length, limit)}` +
    `<h3>Eskalationen (${esc$.length})</h3>${table(['Arbeitspaket', 'Stufe', 'Grund', 'Zuständig'], esc$.slice(0, limit).map((e) => [esc(e.title), esc(LEVEL_LABEL[e.targetLevel] ?? String(e.targetLevel)), esc(e.reason), esc(e.responsible ?? '–')]))}${more(esc$.length, limit)}`;
  return { html, facts: { blocked: blocked.slice(0, limit).map((t) => ({ code: data.code(t), title: t.title, reason: t.blockedReason })), escalations: esc$.slice(0, limit).map((e) => ({ title: e.title, level: e.targetLevel, reason: e.reason })) } };
};

const milestonesBlock: Renderer = async (data, block, ctx) => {
  const limit = block.limit ?? 5;
  const { since, label } = periodRange(block.period, block.days, ctx.lastRunOn, ctx.today);
  // Status „erreicht“ (reached_at) geht vor dem Datum: erreicht im Zeitraum = bestätigt im Zeitraum; offene mit Datum in der
  // Vergangenheit sind überfällig (nicht erreicht). Ohne Status (Altbestand) zählt wie bisher das Datum.
  const anyStatus = Boolean(await data.db.maybeOne(`select 1 from milestones where project_id = $1 and reached_at is not null limit 1`, [data.project.id]));
  const rows = (await data.db.query(`select m.name, m.date, m.reached_at, s.name as sub from milestones m left join subprojects s on s.id = m.subproject_id where m.project_id = $1 and (m.date >= $2 or m.reached_at >= $2::date or (m.reached_at is null and m.date < $3)) order by m.date`, [data.project.id, since, ctx.today])).rows
    .map((m: any) => ({ name: m.name as string, date: iso(m.date).slice(0, 10), sub: (m.sub ?? null) as string | null, reachedOn: m.reached_at ? iso(m.reached_at).slice(0, 10) : null as string | null }));
  const upcoming = rows.filter((m) => !m.reachedOn && m.date >= ctx.today).slice(0, limit).map((m) => ({ ...m, days: daysBetween(ctx.today, m.date) }));
  const reached = rows.filter((m) => (m.reachedOn ? m.reachedOn >= since : !anyStatus && m.date >= since && m.date < ctx.today))
    .map((m) => ({ ...m, days: -daysBetween(m.reachedOn ?? m.date, ctx.today) }));
  const missed = anyStatus ? rows.filter((m) => !m.reachedOn && m.date < ctx.today).map((m) => ({ ...m, days: -daysBetween(m.date, ctx.today) })) : [];
  let html = '';
  if (ctx.graphic !== false && block.chart !== false && (upcoming.length || reached.length || missed.length)) {
    const all = [...reached, ...missed, ...upcoming].sort((a, b) => a.date.localeCompare(b.date));
    const W = 600, H = 70;
    const from = all[0].date < ctx.today ? all[0].date : ctx.today, to = all[all.length - 1].date > ctx.today ? all[all.length - 1].date : ctx.today;
    const span = Math.max(1, daysBetween(from, to));
    const px = (d: string) => 20 + ((W - 40) * daysBetween(from, d)) / span;
    let svg = svgOpen(W, H, 'Meilensteine auf dem Zeitstrahl');
    svg += line(20, 36, W - 20, 36, '#9aa7bd', 2);
    svg += line(px(ctx.today), 22, px(ctx.today), 50, COLOR.accent, 1.5, '3,2') + text(px(ctx.today), 62, 'heute', { anchor: 'middle', size: 9, fill: COLOR.accent });
    all.forEach((m, i) => { const x = px(m.date); const isReached = reached.includes(m as any); svg += circle(x, 36, 6, isReached ? COLOR.done : m.date < ctx.today ? COLOR.red : COLOR.yellow) + text(x, i % 2 ? 54 : 18, cutLabel(`${m.name} ${dShort(m.date)}`, 26), { anchor: 'middle', size: 9 }); });
    html += chart(svg + '</svg>');
  }
  html += `<h3>Nächste Meilensteine</h3>${table(['Datum', 'Meilenstein', 'Teilprojekt', 'In Tagen'], upcoming.map((m) => [d10(m.date), esc(m.name), esc(m.sub ?? '–'), String(m.days)]))}`;
  html += `<h3>Erreicht (${label})</h3>${table(['Geplant', 'Erreicht am', 'Meilenstein', 'Teilprojekt'], reached.map((m) => [d10(m.date), m.reachedOn ? d10(m.reachedOn) : '–', esc(m.name), esc(m.sub ?? '–')]))}`;
  if (missed.length) html += `<h3>Überfällig, nicht erreicht (${missed.length})</h3>${table(['Datum', 'Meilenstein', 'Teilprojekt', 'Seit Tagen'], missed.map((m) => [d10(m.date), esc(m.name), esc(m.sub ?? '–'), String(-m.days)]))}`;
  return { html, facts: { upcoming, reached, missed } };
};

const subprojectsBlock: Renderer = async (data, block, ctx) => {
  const subs = await data.subprojects();
  const tasks = (await data.tasks()).filter((t) => !t.parentId);
  const rows = [...subs, { id: null as string | null, name: 'Ohne Teilprojekt' }].map((s) => {
    const ts = tasks.filter((t) => (t.subprojectId ?? null) === s.id);
    const done = ts.filter((t) => t.done).length;
    return { name: s.name, total: ts.length, done, open: ts.length - done, overdue: ts.filter((t) => !t.done && t.dueDate && t.dueDate < ctx.today).length, blocked: ts.filter((t) => !t.done && t.blocked).length, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
  }).filter((r) => r.total > 0 || r.name !== 'Ohne Teilprojekt');
  let html = '';
  if (ctx.graphic !== false && block.chart !== false && rows.length) html += hbars(rows.map((r) => ({ label: r.name, value: r.pct, color: r.overdue || r.blocked ? COLOR.yellow : COLOR.done, valueText: `${r.pct} % (${r.done}/${r.total})` })), 'Fortschritt je Teilprojekt');
  html += table(['Teilprojekt', 'Gesamt', 'Erledigt', 'Offen', 'Überfällig', 'Blockiert', 'Fortschritt'], rows.map((r) => [esc(r.name), String(r.total), String(r.done), String(r.open), String(r.overdue), String(r.blocked), `${r.pct} %`]));
  return { html, facts: rows };
};

const KIND_LABEL: Record<string, string> = { risk: 'Risiko', assumption: 'Annahme', issue: 'Issue', decision: 'Entscheidung' };
const RAID_STATUS: Record<string, string> = { open: 'offen', mitigated: 'in Behandlung', closed: 'geschlossen' };

const risksBlock: Renderer = async (data, block, ctx) => {
  const limit = block.limit ?? 10;
  const rows = (await data.db.query(`select r.number, r.kind, r.title, r.status, r.probability, r.impact, r.due_date, u.name as owner from raid_items r left join users u on u.id = r.owner_user_id where r.project_id = $1 and r.status <> 'closed' order by coalesce(r.probability * r.impact, 0) desc, r.kind, r.number`, [data.project.id]).catch(() => ({ rows: [] as any[] }))).rows
    .map((r: any) => ({ number: r.number, kind: r.kind as string, title: r.title as string, status: r.status as string, probability: r.probability as number | null, impact: r.impact as number | null, score: r.probability && r.impact ? r.probability * r.impact : null, owner: (r.owner ?? null) as string | null, dueDate: r.due_date ? iso(r.due_date).slice(0, 10) : null }));
  let html = '';
  const risks = rows.filter((r) => r.kind === 'risk' && r.probability && r.impact);
  if (ctx.graphic !== false && block.chart !== false && risks.length) {
    const cell = 34, left = 70, top = 16, W = 600, H = top + 5 * cell + 32;
    let svg = svgOpen(W, H, 'Risikomatrix');
    for (let p = 1; p <= 5; p++) for (let i = 1; i <= 5; i++) {
      const score = p * i, x = left + (i - 1) * cell, y = top + (5 - p) * cell;
      svg += rect(x, y, cell - 2, cell - 2, score >= 15 ? '#f8d7da' : score >= 8 ? '#fff3cd' : '#e2f0e4', 3);
      const n = risks.filter((r) => r.probability === p && r.impact === i).length;
      if (n) svg += circle(x + cell / 2 - 1, y + cell / 2 - 1, 10, score >= 15 ? COLOR.red : score >= 8 ? COLOR.yellow : COLOR.done) + text(x + cell / 2 - 1, y + cell / 2 + 3, String(n), { anchor: 'middle', size: 10, fill: '#ffffff', bold: true });
    }
    for (let k = 1; k <= 5; k++) { svg += text(left - 8, top + (5 - k) * cell + cell / 2 + 3, String(k), { anchor: 'end', size: 9, fill: COLOR.muted }); svg += text(left + (k - 1) * cell + cell / 2 - 1, top + 5 * cell + 12, String(k), { anchor: 'middle', size: 9, fill: COLOR.muted }); }
    svg += text(left - 8, top + 5 * cell + 12, 'W / A', { anchor: 'end', size: 9, fill: COLOR.muted });
    svg += text(left, top + 5 * cell + 26, 'Wahrscheinlichkeit nach oben, Auswirkung nach rechts', { size: 8.5, fill: COLOR.muted });
    const lx = left + 5 * cell + 30;
    svg += text(lx, top + 14, `${risks.length} bewertete Risiken`, { size: 11, bold: true });
    svg += circle(lx + 6, top + 36, 6, COLOR.red) + text(lx + 18, top + 40, `kritisch (≥ 15): ${risks.filter((r) => r.score! >= 15).length}`, { size: 10 });
    svg += circle(lx + 6, top + 56, 6, COLOR.yellow) + text(lx + 18, top + 60, `erhöht (8–14): ${risks.filter((r) => r.score! >= 8 && r.score! < 15).length}`, { size: 10 });
    svg += circle(lx + 6, top + 76, 6, COLOR.done) + text(lx + 18, top + 80, `gering (< 8): ${risks.filter((r) => r.score! < 8).length}`, { size: 10 });
    html += chart(svg + '</svg>');
  }
  html += table(['Nr.', 'Art', 'Titel', 'Status', 'W×A', 'Verantwortlich', 'Termin'], rows.slice(0, limit).map((r) => [`R-${r.number}`, esc(KIND_LABEL[r.kind] ?? r.kind), esc(r.title), esc(RAID_STATUS[r.status] ?? r.status), r.score ? `${r.probability}×${r.impact} = ${r.score}` : '–', esc(r.owner ?? '–'), d10(r.dueDate)])) + more(rows.length, limit);
  return { html, facts: { open: rows.length, critical: rows.filter((r) => (r.score ?? 0) >= 15).length, openDecisions: rows.filter((r) => r.kind === 'decision').length, items: rows.slice(0, limit) } };
};

const timeBlock: Renderer = async (data, block, ctx) => {
  const { since, label } = periodRange(block.period, block.days, ctx.lastRunOn, ctx.today);
  const byUser = (await data.db.query(`select u.name, coalesce(sum(e.minutes),0)::int as m from time_entries e join users u on u.id = e.user_id where e.project_id = $1 and e.date >= $2::date group by u.name order by m desc`, [data.project.id, since]).catch(() => ({ rows: [] as any[] }))).rows as { name: string; m: number }[];
  const bySub = (await data.db.query(`select coalesce(s.name, 'Ohne Teilprojekt') as name, coalesce(sum(e.minutes),0)::int as m from time_entries e left join tasks t on t.id = e.task_id left join subprojects s on s.id = t.subproject_id where e.project_id = $1 and e.date >= $2::date group by 1 order by m desc`, [data.project.id, since]).catch(() => ({ rows: [] as any[] }))).rows as { name: string; m: number }[];
  const total = byUser.reduce((a, r) => a + r.m, 0);
  let html = `<p>Zeitraum: ${esc(label)} · gesamt ${hhmm(total)}</p>`;
  if (ctx.graphic !== false && block.chart !== false && byUser.length) html += hbars(byUser.slice(0, 12).map((r) => ({ label: r.name, value: r.m, valueText: hhmm(r.m) })), `Gebuchte Zeit je Person ${label}`);
  html += `<h3>Je Person</h3>${table(['Person', 'Stunden'], byUser.map((r) => [esc(r.name), hhmm(r.m)]))}`;
  html += `<h3>Je Teilprojekt</h3>${table(['Teilprojekt', 'Stunden'], bySub.map((r) => [esc(r.name), hhmm(r.m)]))}`;
  return { html, facts: { since, label, totalMinutes: total, byUser, bySubproject: bySub } };
};

const decisionsBlock: Renderer = async (data, block, ctx) => {
  const { since, label } = periodRange(block.period, block.days, ctx.lastRunOn, ctx.today);
  const limit = block.limit ?? 15;
  const items: { on: string; kind: string; title: string; body: string | null }[] = [];
  const raid = await data.db.query(`select number, title, mitigation, decided_on, status from raid_items where project_id = $1 and kind = 'decision' and decided_on is not null and decided_on >= $2::date order by decided_on desc`, [data.project.id, since]).catch(() => ({ rows: [] as any[] }));
  for (const r of raid.rows) items.push({ on: iso(r.decided_on).slice(0, 10), kind: 'Entscheidung', title: `R-${r.number} ${r.title}`, body: r.mitigation ?? null });
  const notes = await data.db.query(`select distinct on (n.title) n.title, n.body, n.event, n.created_at from notifications n where n.project_id = $1 and n.event in ('decision', 'approval') and n.created_at >= $2::date order by n.title, n.created_at desc`, [data.project.id, since]).catch(() => ({ rows: [] as any[] }));
  for (const n of notes.rows) items.push({ on: iso(n.created_at).slice(0, 10), kind: n.event === 'approval' ? 'Bestätigung' : 'Entscheidung', title: n.title, body: n.body ?? null });
  if (!items.length) {
    // Fallback: Log-Einträge mit erkennbarer Entscheidung oder Bestätigung
    const comments = await data.db.query(`select c.body, c.created_at, t.number, t.title from task_comments c join tasks t on t.id = c.task_id where t.project_id = $1 and c.created_at >= $2::date and c.body ~* '(entschieden|entscheidung|bestätigt|freigegeben|genehmigt)' order by c.created_at desc limit 30`, [data.project.id, since]).catch(() => ({ rows: [] as any[] }));
    for (const c of comments.rows) items.push({ on: iso(c.created_at).slice(0, 10), kind: 'Log', title: `${data.code(c)} ${c.title}`, body: String(c.body).slice(0, 300) });
  }
  items.sort((a, b) => b.on.localeCompare(a.on));
  const html = `<p>Zeitraum: ${esc(label)}</p>` + table(['Datum', 'Art', 'Betreff', 'Inhalt'], items.slice(0, limit).map((i) => [d10(i.on), esc(i.kind), esc(i.title), esc(i.body ?? '–')])) + more(items.length, limit);
  return { html, facts: { since, label, items: items.slice(0, limit) } };
};

const outlookBlock: Renderer = async (data, block, ctx) => {
  const days = block.days ?? 14, limit = block.limit ?? 10;
  const until = addDays(ctx.today, days);
  const tasks = (await data.tasks()).filter((t) => !t.done && t.dueDate && t.dueDate >= ctx.today && t.dueDate <= until).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const ms = (await data.db.query(`select name, date from milestones where project_id = $1 and date >= $2 and date <= $3 order by date`, [data.project.id, ctx.today, until])).rows.map((m: any) => ({ name: m.name as string, date: iso(m.date).slice(0, 10) }));
  const meetings = (await data.db.query(`select title, starts_at, location, tentative from meetings where project_id = $1 and starts_at >= $2::date and starts_at < ($3::date + 1) order by starts_at`, [data.project.id, ctx.today, until]).catch(() => ({ rows: [] as any[] }))).rows
    .map((m: any) => ({ title: m.title as string, startsAt: new Date(m.starts_at).toISOString(), when: new Date(m.starts_at).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }), location: (m.location ?? null) as string | null, tentative: Boolean(m.tentative) }));
  const html = `<p>Horizont: ${days} Tage (bis ${d10(until)})</p>` +
    `<h3>Fällig (${tasks.length})</h3>${table(['Fällig', 'Kennung', 'Arbeitspaket', 'Zuständig'], tasks.slice(0, limit).map((t) => [d10(t.dueDate), esc(data.code(t)), esc(t.title), esc(t.responsible.name ?? t.responsible.email ?? '–')]))}${more(tasks.length, limit)}` +
    `<h3>Meilensteine</h3>${list(ms.map((m) => `${d10(m.date)} – ${esc(m.name)}`))}` +
    `<h3>Besprechungen</h3>${list(meetings.map((m) => `${esc(m.when)} – ${esc(m.title)}${m.location ? ` (${esc(m.location)})` : ''}${m.tentative ? ' – vorläufig' : ''}`))}`;
  return { html, facts: { days, dueCount: tasks.length, due: tasks.slice(0, limit).map((t) => ({ code: data.code(t), title: t.title, dueDate: t.dueDate })), milestones: ms, meetings: meetings.map((m) => ({ title: m.title, startsAt: m.startsAt, tentative: m.tentative })) } };
};

const textBlock: Renderer = async (_data, block) => ({ html: mdToHtml(block.text ?? '') || '<p>–</p>' });

/** Regelbasierte Management-Summary aus den Fakten (Satzbausteine, keine KI). */
export function ruleSummary(facts: ReportFacts): string {
  const s = facts.summary as Awaited<ReturnType<ProjectData['summary']>> | undefined;
  if (!s) return '<p>Keine Kennzahlen vorhanden.</p>';
  const risks = facts.risks as { open: number; critical: number; openDecisions: number } | undefined;
  const ms = facts.milestones as { upcoming: { name: string; date: string; days: number }[] } | undefined;
  const out = facts.outlook as { days: number; dueCount: number } | undefined;
  const name = `„${facts.project.name}“`;
  const lage = s.color === 'green' ? `Das Projekt ${name} liegt im Plan.` : s.color === 'yellow' ? `Das Projekt ${name} ist in Verzug (${s.overdue} überfällig${s.blocked ? `, ${s.blocked} blockiert` : ''}).` : `Das Projekt ${name} steht auf Rot: ${s.overdue} überfällig, ${s.blocked} blockiert, ${s.escalations} Eskalationen.`;
  const note = s.healthSet && s.healthNote ? ` Einschätzung der Projektleitung: ${s.healthNote}.` : '';
  const fortschritt = `${s.done} von ${s.total} Arbeitspaketen sind erledigt (${s.pct} %); bis heute waren ${s.planned} fällig, davon ${s.plannedDone} erledigt (Soll/Ist ${s.plannedPct} %).`;
  const risiko = risks ? `${risks.open} offene RAID-Einträge, davon ${risks.critical} kritische Risiken (Score ≥ 15); ${s.blocked} blockierte Arbeitspakete, ${s.escalations} Eskalationen.` : `${s.blocked} blockierte Arbeitspakete, ${s.escalations} Eskalationen.`;
  const bedarf = (risks?.openDecisions ?? 0) + s.escalationsHigh > 0 ? `Entscheidungsbedarf: ${risks?.openDecisions ?? 0} offene Entscheidungen im RAID-Register${s.escalationsHigh ? `, ${s.escalationsHigh} Eskalationen ab Stufe 2 bei der Projektleitung` : ''}.` : 'Kein Entscheidungsbedarf erkennbar.';
  const next = ms?.upcoming?.[0];
  const schritte = `${next ? `Nächster Meilenstein „${next.name}“ am ${d10(next.date)} (in ${next.days} Tagen). ` : 'Keine weiteren Meilensteine geplant. '}${out ? `${out.dueCount} Arbeitspakete werden in den nächsten ${out.days} Tagen fällig.` : `${s.dueWeek} Arbeitspakete werden in den nächsten 7 Tagen fällig.`}`;
  return `<p><strong>Lage.</strong> ${esc(lage)}${esc(note)}</p><p><strong>Fortschritt.</strong> ${esc(fortschritt)}</p><p><strong>Risiken.</strong> ${esc(risiko)}</p><p><strong>Entscheidungsbedarf.</strong> ${esc(bedarf)}</p><p><strong>Nächste Schritte.</strong> ${esc(schritte)}</p>`;
}

const RENDERERS: Record<Exclude<ReportBlockType, 'ai_summary'>, Renderer> = { summary: summaryBlock, changes: changesBlock, overdue: overdueBlock, blocked: blockedBlock, milestones: milestonesBlock, subprojects: subprojectsBlock, risks: risksBlock, time: timeBlock, decisions: decisionsBlock, outlook: outlookBlock, text: textBlock };

const heading = (block: ReportBlock) => `<h2>${esc(block.title?.trim() || REPORT_BLOCK_LABEL[block.type])}</h2>`;

/**
 * Alle Blöcke eines Berichts rendern. Fakten für die Summary (Gesamtstand, Risiken, Meilensteine, Ausblick) werden auch dann
 * erhoben, wenn der jeweilige Block nicht im Bericht steht; der KI-Block wird zuletzt gerendert und an seiner Position eingesetzt.
 */
export async function renderReportBlocks(db: Db, projectId: string, blocks: ReportBlock[] | undefined, ctx: BlockContext): Promise<{ html: string; facts: ReportFacts; textSource: 'rules' | 'ai' }> {
  const pr = await db.one(`select id, key, name, health from projects where id = $1`, [projectId]);
  const data = new ProjectData(db, pr, ctx.today);
  const facts: ReportFacts = { project: { id: pr.id, key: pr.key, name: pr.name }, today: ctx.today };
  const list = blocks && blocks.length ? blocks : DEFAULT_REPORT_BLOCKS;
  const parts: string[] = [];
  const pending: number[] = [];
  for (const block of list) {
    if (block.type === 'ai_summary') { pending.push(parts.length); parts.push(''); continue; }
    const r = await RENDERERS[block.type](data, block, ctx).catch((e) => ({ html: `<p>Block konnte nicht erzeugt werden: ${esc(String(e?.message ?? e))}</p>`, facts: undefined } as Rendered));
    if (r.facts !== undefined && !(block.type in facts)) facts[block.type] = r.facts;
    parts.push(heading(block) + r.html);
  }
  let textSource: 'rules' | 'ai' = 'rules';
  if (pending.length) {
    // Fakten für die Summary vervollständigen (ohne HTML-Ausgabe)
    for (const t of ['summary', 'overdue', 'blocked', 'milestones', 'risks', 'outlook'] as const) {
      if (!(t in facts)) { const r = await RENDERERS[t](data, { id: `f-${t}`, type: t, chart: false }, { ...ctx, graphic: false }).catch(() => null); if (r?.facts !== undefined) facts[t] = r.facts; }
    }
    let body = '';
    let marker = '';
    if (ctx.textSource === 'ai' && ctx.cfg && ctx.user) {
      try {
        const md = await managementSummary(db, ctx.cfg, ctx.fetchFn ?? fetch, ctx.user, projectId, facts);
        body = mdToHtml(md);
        marker = '<p><em>(KI-Text, geprüft von: –)</em></p>';
        textSource = 'ai';
      } catch (e: any) {
        body = ruleSummary(facts);
        marker = `<p><em>(regelbasiert – KI nicht verfügbar: ${esc(String(e?.message ?? e).slice(0, 200))})</em></p>`;
      }
    } else {
      body = ruleSummary(facts);
      marker = `<p><em>(regelbasiert${ctx.textSource === 'ai' && ctx.aiUnavailable ? ` – KI nicht verfügbar: ${esc(ctx.aiUnavailable.slice(0, 200))}` : ''})</em></p>`;
    }
    for (const i of pending) parts[i] = heading(list.find((b) => b.type === 'ai_summary')!) + body + marker;
  }
  return { html: sanitizeHtml(parts.join('\n')), facts, textSource };
}

// ---- Portfolio-Management-Report über mehrere Projekte

export interface PortfolioReportOptions {
  today: string;
  period?: ReportPeriod;
  days?: number;
  graphic?: boolean;
  /** Zusätzliche Blöcke je Projekt (changes, milestones, outlook) */
  blocks?: ReportBlock[];
  limit?: number;
}

const PORTFOLIO_BLOCK_TYPES: ReportBlockType[] = ['changes', 'milestones', 'outlook', 'overdue', 'blocked', 'risks'];

export async function renderPortfolioReport(db: Db, projects: { id: string; key: string; name: string; health: any; lastRunOn?: string | null }[], opts: PortfolioReportOptions): Promise<{ html: string; facts: Record<string, unknown>[] }> {
  const { since, label } = periodRange(opts.period, opts.days, null, opts.today);
  const rows: { project: typeof projects[number]; s: Awaited<ReturnType<ProjectData['summary']>>; nextMs: { name: string; date: string } | null; data: ProjectData }[] = [];
  for (const p of projects) {
    const data = new ProjectData(db, p, opts.today);
    const s = await data.summary();
    const ms = await db.maybeOne(`select name, date from milestones where project_id = $1 and date >= $2 order by date limit 1`, [p.id, opts.today]);
    rows.push({ project: p, s, nextMs: ms ? { name: ms.name, date: iso(ms.date).slice(0, 10) } : null, data });
  }
  const order: Record<Ampel, number> = { red: 0, yellow: 1, green: 2 };
  rows.sort((a, b) => order[a.s.color] - order[b.s.color] || a.project.name.localeCompare(b.project.name));
  let html = `<h2>Gesamtübersicht</h2><p>Stand ${d10(opts.today)} · ${rows.length} Projekte · Zeitraum der Detailblöcke: ${esc(label)}</p>`;
  if (opts.graphic !== false && rows.length) {
    html += hbars(rows.map((r) => ({ label: `${r.project.key} ${r.project.name}`, value: r.s.pct, color: COLOR[r.s.color], valueText: `${r.s.pct} % · ${r.s.overdue} überfällig · ${r.s.blocked} blockiert` })), 'Fortschritt und Ampel je Projekt');
  }
  html += table(['Projekt', 'Ampel', 'Fortschritt', 'Soll / Ist', 'Überfällig', 'Blockiert', 'Eskalationen', 'Nächster Meilenstein'],
    rows.map((r) => [`${esc(r.project.key)} ${esc(r.project.name)}`, ampelDot(r.s.color), `${r.s.pct} % (${r.s.done}/${r.s.total})`, `${r.s.planned} / ${r.s.plannedDone}`, String(r.s.overdue), String(r.s.blocked), String(r.s.escalations), r.nextMs ? `${d10(r.nextMs.date)} ${esc(r.nextMs.name)}` : '–']));
  const extra = (opts.blocks ?? []).filter((b) => PORTFOLIO_BLOCK_TYPES.includes(b.type));
  const facts: Record<string, unknown>[] = [];
  for (const r of rows) {
    const f: Record<string, unknown> = { project: { id: r.project.id, key: r.project.key, name: r.project.name }, summary: r.s, nextMilestone: r.nextMs };
    if (extra.length) {
      html += `<h2>${esc(r.project.key)} ${esc(r.project.name)}</h2><p>${ampelDot(r.s.color)} · ${r.s.pct} % erledigt · ${r.s.overdue} überfällig · ${r.s.blocked} blockiert</p>`;
      for (const b of extra) {
        const blk: ReportBlock = { ...b, period: b.period ?? opts.period ?? 'days', days: b.days ?? opts.days, limit: b.limit ?? opts.limit ?? 8 };
        if (blk.period === 'days' && !blk.days) blk.days = daysBetween(since, opts.today);
        const out = await RENDERERS[b.type as Exclude<ReportBlockType, 'ai_summary'>](r.data, blk, { today: opts.today, graphic: opts.graphic }).catch((e) => ({ html: `<p>Block konnte nicht erzeugt werden: ${esc(String(e?.message ?? e))}</p>` } as Rendered));
        html += `<h3>${esc(b.title?.trim() || REPORT_BLOCK_LABEL[b.type])}</h3>${out.html.replace(/<h3>/g, '<h4>').replace(/<\/h3>/g, '</h4>')}`;
        if (out.facts !== undefined) f[b.type] = out.facts;
      }
    }
    facts.push(f);
  }
  return { html: sanitizeHtml(html), facts };
}

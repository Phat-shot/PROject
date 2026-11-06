import type { ImportField, ImportResult, ImportRowResult } from '@projekttool/shared';
import { IMPORT_FIELDS } from '@projekttool/shared';
import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import { audit } from '../audit.js';
import { badRequest } from '../errors.js';
import { insertTask } from './service.js';

/**
 * CSV-Import von Arbeitspaketen, Aufgaben und Checklistenpunkten (Projekt › Einstellungen › Daten). Gegenstück zum CSV-Export
 * des Boards (Kennung;Titel;Status;Teilprojekt;Zuständig;Start;Fällig;Priorität;Labels;…) und des Plans (Art;Bezeichnung;…):
 * beide lassen sich wieder einlesen. Ebene über die Spalte „Art“, „Ebene“ (1/2/3 oder Gliederung 1.2.3) oder „Übergeordnet“
 * (Kennung einer Zeile der Datei oder eines bestehenden Arbeitspakets); ohne Angabe gehört eine Aufgabe zum Arbeitspaket darüber.
 * Trockenlauf prüft nur; der Import läuft in einer Transaktion und nur ohne Fehler (alles oder nichts).
 */

/** CSV lesen: Trennzeichen ; , oder Tab (aus der Kopfzeile), Anführungszeichen mit "" als Escape, Zeilenumbrüche in Feldern, BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => firstLine.split(c).length - 1;
  const delim = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Spaltenzuordnung aus der Kopfzeile (Aliase); jedes Feld höchstens einmal, sonst „nicht übernehmen“. */
export function detectMapping(headers: string[]): ImportField[] {
  const used = new Set<ImportField>();
  return headers.map((h) => {
    const n = norm(h);
    // Plan-Export: „Bezeichnung“ ist der Titel, „Ende“ die Deadline
    const f = IMPORT_FIELDS.find((x) => x.key !== 'ignore' && !used.has(x.key) && x.aliases.includes(n));
    if (!f) return 'ignore';
    used.add(f.key);
    return f.key;
  });
}

/** Datum: JJJJ-MM-TT, TT.MM.JJJJ, TT.MM.JJ, TT/MM/JJJJ; null = leer; undefined = ungültig. */
export function parseDate(v: string): string | null | undefined {
  const s = v.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/))) { d = +r[1]; m = +r[2]; y = r[3].length === 2 ? 2000 + +r[3] : +r[3]; }
  else return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

const PRIO: Record<string, string> = { niedrig: 'low', low: 'low', gering: 'low', normal: 'normal', mittel: 'normal', medium: 'normal', hoch: 'high', high: 'high', kritisch: 'critical', critical: 'critical', sehr_hoch: 'critical' };
const KIND: Record<string, ImportRowResult['kind']> = {
  arbeitspaket: 'ap', ap: 'ap', 'work package': 'ap', workpackage: 'ap', paket: 'ap',
  aufgabe: 'aufgabe', task: 'aufgabe', unteraufgabe: 'aufgabe', subtask: 'aufgabe',
  checklistenpunkt: 'item', checkliste: 'item', punkt: 'item', item: 'item', 'checklist item': 'item',
  teilprojekt: 'subproject', subproject: 'subproject', phase: 'subproject',
  meilenstein: 'skip', milestone: 'skip'
};
const YES = new Set(['ja', 'x', 'yes', 'true', '1', 'erledigt', 'done']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ImportInput { csv: string; mapping?: ImportField[] | null; dryRun?: boolean }
interface Planned extends ImportRowResult {
  key: string | null; description: string | null; subproject: string | null; responsibleUserId: string | null; responsibleEmail: string | null;
  start: string | null; due: string | null; priority: string; labels: string[]; columnId: string | null; done: boolean;
  /** Eltern: Zeile der Datei oder bestehender Task */
  parentRow: Planned | null; parentTaskId: string | null;
}

/** Datei prüfen und (ohne Trockenlauf, ohne Fehler) in einer Transaktion anlegen. */
export async function importCsv(db: Db, input: ImportInput, ctx: { projectId: string; user: { id: string; orgId: string } }): Promise<ImportResult & { headers: string[]; mapping: ImportField[] }> {
  const table = parseCsv(String(input.csv ?? ''));
  if (table.length < 2) throw badRequest('Die Datei braucht eine Kopfzeile und mindestens eine Datenzeile');
  if (table.length > 2001) throw badRequest('Höchstens 2000 Zeilen je Import');
  const headers = table[0].map((h) => h.trim());
  const mapping = input.mapping && input.mapping.length === headers.length ? input.mapping.map((m) => (IMPORT_FIELDS.some((f) => f.key === m) ? m : 'ignore')) : detectMapping(headers);
  if (!mapping.includes('title')) throw badRequest('Keine Spalte für den Titel zugeordnet');
  const get = (row: string[], f: ImportField) => { const i = mapping.indexOf(f); return i >= 0 ? String(row[i] ?? '').trim() : ''; };

  const project = await db.one(`select id, key from projects where id = $1`, [ctx.projectId]);
  const members = (await db.query(`select u.id, lower(u.email) as email, lower(u.name) as name, u.kind from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.active`, [ctx.projectId])).rows;
  const columns = (await db.query(`select id, name, kind, is_done from board_columns where project_id = $1 order by position`, [ctx.projectId])).rows;
  const subs = new Map<string, string>((await db.query(`select id, name from subprojects where project_id = $1`, [ctx.projectId])).rows.map((r: any) => [norm(r.name), r.id]));
  const labels = new Map<string, string>((await db.query(`select id, name from labels where project_id = $1`, [ctx.projectId])).rows.map((r: any) => [norm(r.name), r.id]));
  const existing = new Map<number, { id: string; parent_id: string | null; title: string }>((await db.query(`select id, number, parent_id, title from tasks where project_id = $1 and deleted_at is null`, [ctx.projectId])).rows.map((r: any) => [Number(r.number), r]));
  const defaultCol = (columns.find((c: any) => c.kind === 'active') ?? columns.find((c: any) => !c.is_done) ?? columns[0])?.id ?? null;

  const rows: Planned[] = [];
  const byKey = new Map<string, Planned>();
  let lastAp: Planned | null = null, lastAufgabe: Planned | null = null;
  const levelStack: Planned[] = [];
  let ctxSub: string | null = null;
  const newSubs = new Set<string>(); const newLabels = new Set<string>();

  for (const [i, raw] of table.slice(1).entries()) {
    const line = i + 1;
    const errors: string[] = []; const warnings: string[] = [];
    const title = get(raw, 'title');
    const kindRaw = norm(get(raw, 'kind'));
    let kind: ImportRowResult['kind'] | null = kindRaw ? KIND[kindRaw] ?? null : null;
    if (kindRaw && !kind) errors.push(`Art „${get(raw, 'kind')}“ unbekannt (Arbeitspaket, Aufgabe, Checklistenpunkt)`);
    const levelRaw = get(raw, 'level');
    let level: number | null = null;
    if (levelRaw) {
      if (/^\d+$/.test(levelRaw)) level = Number(levelRaw);
      else if (/^\d+(\.\d+)*\.?$/.test(levelRaw)) level = levelRaw.replace(/\.$/, '').split('.').length;
      if (!level || level < 1 || level > 3) { errors.push(`Ebene „${levelRaw}“: 1 (Arbeitspaket), 2 (Aufgabe) oder 3 (Checklistenpunkt)`); level = null; }
    }
    const parentRef = get(raw, 'parent');
    const p: Planned = {
      line, kind: 'ap', title, parentLine: null, errors, warnings, key: get(raw, 'key') || null, description: get(raw, 'description') || null,
      subproject: get(raw, 'subproject') || null, responsibleUserId: null, responsibleEmail: null, start: null, due: null, priority: 'normal', labels: [],
      columnId: null, done: false, parentRow: null, parentTaskId: null
    };
    // Plan-Export: Zeile „Teilprojekt“ gilt für die folgenden Zeilen, Meilensteine werden nicht übernommen
    if (kind === 'subproject') {
      p.kind = 'subproject';
      if (!title) errors.push('Titel fehlt');
      else if (title !== 'Ohne Teilprojekt') { ctxSub = title; if (!subs.has(norm(title))) { newSubs.add(norm(title)); warnings.push('Teilprojekt wird angelegt'); } }
      else ctxSub = null;
      rows.push(p); continue;
    }
    if (kind === 'skip') { p.kind = 'skip'; warnings.push('Meilensteine werden nicht importiert (im Plan anlegen)'); rows.push(p); continue; }
    if (!title) errors.push('Titel fehlt');

    // Eltern: Spalte „Übergeordnet“ (Zeile der Datei oder bestehender Task), sonst Ebene, sonst Art mit der Zeile darüber
    if (parentRef) {
      const inFile = byKey.get(norm(parentRef));
      const num = parentRef.match(new RegExp(`^(?:${project.key}-)?(\\d+)$`, 'i'));
      if (inFile) p.parentRow = inFile;
      else if (num && existing.has(Number(num[1]))) p.parentTaskId = existing.get(Number(num[1]))!.id;
      else errors.push(`Übergeordnet „${parentRef}“ nicht gefunden (Kennung einer Zeile darüber oder eines Arbeitspakets)`);
      const parentKind = p.parentRow ? p.parentRow.kind : p.parentTaskId ? (existing.get(Number(num![1]))!.parent_id ? 'aufgabe' : 'ap') : null;
      const derived = parentKind === 'ap' ? 'aufgabe' : parentKind === 'aufgabe' ? 'item' : null;
      if (parentKind && !derived) errors.push('Unter einem Checklistenpunkt geht nichts mehr');
      if (kind && derived && kind !== derived) errors.push(`Art passt nicht zu „Übergeordnet“ (erwartet: ${derived === 'aufgabe' ? 'Aufgabe' : 'Checklistenpunkt'})`);
      kind = derived ?? kind;
    } else if (level) {
      const want: ImportRowResult['kind'] = level === 1 ? 'ap' : level === 2 ? 'aufgabe' : 'item';
      if (kind && kind !== want) errors.push('Art passt nicht zur Ebene');
      kind = want;
      if (level > 1) { p.parentRow = levelStack[level - 2] ?? null; if (!p.parentRow) errors.push(`Ebene ${level} ohne Zeile der Ebene ${level - 1} darüber`); }
    } else if (kind === 'aufgabe') {
      p.parentRow = lastAp; if (!lastAp) errors.push('Aufgabe ohne Arbeitspaket darüber (Spalte „Übergeordnet“ oder „Ebene“ angeben)');
    } else if (kind === 'item') {
      p.parentRow = lastAufgabe; if (!lastAufgabe) errors.push('Checklistenpunkt ohne Aufgabe darüber');
    }
    p.kind = kind ?? 'ap';
    if (p.parentRow) {
      p.parentLine = p.parentRow.line;
      if (p.parentRow.errors.length) errors.push(`Übergeordnete Zeile ${p.parentRow.line} hat Fehler`);
      if (p.parentRow.kind === 'item' || (p.kind === 'aufgabe' && p.parentRow.kind !== 'ap') || (p.kind === 'item' && p.parentRow.kind !== 'aufgabe')) errors.push(p.kind === 'item' ? 'Checklistenpunkte gehören zu Aufgaben' : 'Aufgaben gehören zu Arbeitspaketen');
    }
    if (p.parentTaskId) {
      const ex = [...existing.values()].find((x) => x.id === p.parentTaskId)!;
      if (p.kind === 'item' && !ex.parent_id) errors.push('Checklistenpunkte gehören zu Aufgaben, nicht zu Arbeitspaketen');
    }

    // Felder
    const start = parseDate(get(raw, 'start')); const due = parseDate(get(raw, 'due'));
    if (start === undefined) errors.push(`Start „${get(raw, 'start')}“ ist kein Datum (TT.MM.JJJJ oder JJJJ-MM-TT)`); else p.start = start;
    if (due === undefined) errors.push(`Deadline „${get(raw, 'due')}“ ist kein Datum (TT.MM.JJJJ oder JJJJ-MM-TT)`); else p.due = due;
    if (p.start && p.due && p.start > p.due) errors.push('Start liegt nach der Deadline');
    const prio = norm(get(raw, 'priority')).replace(' ', '_');
    if (prio) { if (PRIO[prio]) p.priority = PRIO[prio]; else warnings.push(`Priorität „${get(raw, 'priority')}“ unbekannt, normal angenommen`); }
    const resp = get(raw, 'responsible');
    if (resp) {
      const m = members.find((x: any) => x.email === resp.toLowerCase()) ?? members.find((x: any) => x.name === resp.toLowerCase());
      if (m && m.kind === 'agent') errors.push(`${resp} ist ein KI-Agent; Agenten weist die PL im Board zu`);
      else if (m) p.responsibleUserId = m.id;
      else if (EMAIL.test(resp)) { p.responsibleEmail = resp.toLowerCase(); warnings.push(`${resp} ist kein Mitglied: externe Zuständigkeit`); }
      else errors.push(`Zuständig „${resp}“: kein Mitglied mit diesem Namen oder dieser E-Mail`);
    }
    const sp = p.subproject ?? (p.kind === 'ap' ? ctxSub : null);
    if (p.kind !== 'ap' && p.subproject) warnings.push('Teilprojekt folgt dem Arbeitspaket');
    p.subproject = p.kind === 'ap' ? sp : null;
    if (p.subproject && !subs.has(norm(p.subproject)) && !newSubs.has(norm(p.subproject))) { newSubs.add(norm(p.subproject)); warnings.push(`Teilprojekt „${p.subproject}“ wird angelegt`); }
    p.labels = get(raw, 'labels').split(/[,|]/).map((x) => x.trim()).filter(Boolean);
    if (p.kind === 'item' && p.labels.length) warnings.push('Checklistenpunkte haben keine Labels');
    for (const l of p.kind === 'item' ? [] : p.labels) if (!labels.has(norm(l)) && !newLabels.has(norm(l))) { newLabels.add(norm(l)); warnings.push(`Label „${l}“ wird angelegt`); }
    const status = get(raw, 'status');
    if (status) {
      const c = columns.find((x: any) => norm(x.name) === norm(status));
      if (p.kind === 'item') p.done = YES.has(norm(status)) || Boolean(c?.is_done);
      else if (c) { p.columnId = c.id; p.done = c.is_done; }
      else if (YES.has(norm(status))) { p.columnId = columns.find((x: any) => x.is_done)?.id ?? null; p.done = true; }
      else warnings.push(`Status „${status}“ ist keine Spalte, ${columns.find((x: any) => x.id === defaultCol)?.name ?? 'erste Spalte'} angenommen`);
    }
    if (p.kind === 'item' && (p.start || p.due || p.description)) warnings.push('Checklistenpunkte haben keine Termine und keine Beschreibung');
    if (p.key) {
      if (byKey.has(norm(p.key))) warnings.push(`Kennung „${p.key}“ doppelt; „Übergeordnet“ verweist auf die erste`);
      else byKey.set(norm(p.key), p);
      const num = p.key.match(new RegExp(`^${project.key}-(\\d+)$`, 'i'));
      if (num && existing.has(Number(num[1]))) warnings.push(`${p.key} gibt es schon; es wird ein neues ${p.kind === 'ap' ? 'Arbeitspaket' : 'Element'} angelegt`);
    }
    if (p.kind === 'ap') { lastAp = p; lastAufgabe = null; levelStack.length = 0; levelStack[0] = p; }
    else if (p.kind === 'aufgabe') { lastAufgabe = p; levelStack.length = Math.min(levelStack.length, 1); levelStack[1] = p; }
    rows.push(p);
  }

  const counts = {
    ap: rows.filter((r) => r.kind === 'ap').length, aufgabe: rows.filter((r) => r.kind === 'aufgabe').length, item: rows.filter((r) => r.kind === 'item').length,
    errors: rows.filter((r) => r.errors.length).length, subprojects: newSubs.size, labels: newLabels.size
  };
  const out = (created?: ImportResult['created']) => ({
    dryRun: Boolean(input.dryRun), headers, mapping, counts, created,
    rows: rows.map(({ line, kind, title, parentLine, errors, warnings }) => ({ line, kind, title, parentLine, errors, warnings }))
  });
  if (input.dryRun) return out();
  if (counts.errors) throw badRequest(`Import abgebrochen: ${counts.errors} Zeile(n) mit Fehlern. Bitte korrigieren und erneut prüfen.`, out());

  const created = await withTransaction(db, async (tx) => {
    const subId = async (name: string | null) => {
      if (!name) return null;
      const k = norm(name);
      if (!subs.has(k)) {
        const pos = await tx.one(`select coalesce(max(position), -1) + 1 as p from subprojects where project_id = $1`, [ctx.projectId]);
        subs.set(k, (await tx.one(`insert into subprojects (project_id, name, position) values ($1,$2,$3) returning id`, [ctx.projectId, name.trim(), pos.p])).id);
      }
      return subs.get(k)!;
    };
    const labelId = async (name: string) => {
      const k = norm(name);
      if (!labels.has(k)) {
        const pos = await tx.one(`select coalesce(max(position), -1) + 1 as p from labels where project_id = $1`, [ctx.projectId]);
        labels.set(k, (await tx.one(`insert into labels (project_id, name, color, position) values ($1,$2,'gray',$3) returning id`, [ctx.projectId, name.trim(), pos.p])).id);
      }
      return labels.get(k)!;
    };
    for (const r of rows) if (r.kind === 'subproject' && r.title !== 'Ohne Teilprojekt') await subId(r.title);
    const ids = new Map<Planned, string>();
    const n = { ap: 0, aufgabe: 0, item: 0 };
    for (const r of rows) {
      if (r.kind === 'subproject' || r.kind === 'skip') continue;
      const parentId = r.parentRow ? ids.get(r.parentRow)! : r.parentTaskId;
      if (r.kind === 'item') {
        const pos = await tx.one(`select coalesce(max(position), -1) + 1 as p from checklist_items where task_id = $1`, [parentId]);
        await tx.query(`insert into checklist_items (task_id, title, done, responsible_user_id, responsible_email, position) values ($1,$2,$3,$4,$5,$6)`, [parentId, r.title, r.done, r.responsibleUserId, r.responsibleEmail, pos.p]);
        n.item++; continue;
      }
      const parentSub = parentId ? (await tx.one(`select subproject_id from tasks where id = $1`, [parentId])).subproject_id : null;
      const t = await insertTask(tx, { projectId: ctx.projectId, subprojectId: parentId ? parentSub : await subId(r.subproject), columnId: r.columnId ?? defaultCol, title: r.title, description: r.description, priority: r.priority,
        startDate: r.start, dueDate: r.due, responsibleUserId: r.responsibleUserId, responsibleEmail: r.responsibleEmail, createdBy: ctx.user.id, parentId: parentId ?? null });
      ids.set(r, t.id);
      for (const l of r.labels) await tx.query(`insert into task_labels (task_id, label_id) values ($1,$2) on conflict do nothing`, [t.id, await labelId(l)]);
      if (r.responsibleEmail) await tx.query(`insert into project_contacts (project_id, email) values ($1,$2) on conflict do nothing`, [ctx.projectId, r.responsibleEmail]);
      n[r.kind]++;
    }
    await audit(tx, { orgId: ctx.user.orgId, projectId: ctx.projectId, userId: ctx.user.id, action: 'project.import', objectType: 'project', objectId: ctx.projectId, details: { ...n, subprojects: counts.subprojects, labels: counts.labels, rows: rows.length } });
    return n;
  });
  return out(created);
}

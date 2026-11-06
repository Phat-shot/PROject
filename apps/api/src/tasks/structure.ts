import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { badRequest } from '../errors.js';
import { dispatch } from '../notify.js';
import { queueAgentRun } from '../ai/agentEvents.js';
import { dateStr, insertTask, moveTask, touchTask } from './service.js';

/**
 * Struktur ändern (Konzept: Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Checklistenpunkt): Aufgaben unter ein anderes
 * Arbeitspaket hängen oder zum Arbeitspaket machen, Arbeitspakete einem Teilprojekt zuordnen, Checklistenpunkte zu Aufgaben
 * machen, verschieben oder Aufgaben wieder zu Checklistenpunkten machen. Checklistenpunkte gehören zu Aufgaben: Ziel von
 * Verschieben und Umwandeln ist immer eine Aufgabe; Punkte am Arbeitspaket (Altbestand) wandern per convert in eine Aufgabe. Nutzen Routen (Personen) und Agenten (Aktionen)
 * gleichermaßen; Rechte prüft der Aufrufer. Alles hängt am Arbeitspaket über task_id (Checkliste, Anhänge, Log, Zeiten,
 * Mails, Buchungen), deshalb nimmt eine Aufgabe beim Umhängen alles mit; nur das Teilprojekt folgt dem neuen Arbeitspaket.
 */
export interface StructureActor { id: string; name: string; orgId: string; /** agent: Log-Einträge mit Quelle ai */ kind: 'person' | 'agent' }

const src = (a: StructureActor) => (a.kind === 'agent' ? 'ai' : 'system');
const who = (a: StructureActor) => (a.kind === 'agent' ? `${a.name} (KI-Agent)` : a.name);
const log = (db: Db, a: StructureActor, taskId: string, body: string) => db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,$4)`, [taskId, a.id, body, src(a)]);
const code = (t: { project_key?: string; number: number }, key?: string) => `${t.project_key ?? key}-${t.number}`;

async function taskRow(db: Db, id: string): Promise<any | null> {
  return db.maybeOne(`select t.*, c.is_done, p.key as project_key, (select count(*)::int from tasks x where x.parent_id = t.id and x.deleted_at is null) as subs from tasks t join projects p on p.id = t.project_id join board_columns c on c.id = t.column_id where t.id = $1 and t.deleted_at is null`, [id]);
}

/** Zuständige Person (direkt oder vom Über-AP geerbt) über eine Verschiebung informieren (Klasse assigned, wie Zuweisung). */
async function notifyMoved(db: Db, actor: StructureActor, t: any, title: string, body: string) {
  const resp = t.responsible_user_id ?? (t.parent_id ? (await db.maybeOne(`select responsible_user_id from tasks where id = $1`, [t.parent_id]))?.responsible_user_id : null);
  if (!resp || resp === actor.id) return;
  const u = await db.maybeOne(`select kind from users where id = $1`, [resp]);
  if (u?.kind === 'agent') { queueAgentRun(t.id, 'task_changed'); return; }
  await dispatch(db, { event: 'assigned', projectId: t.project_id, taskId: t.id, users: [resp], type: 'task.assigned', title, body, link: `/projekte/${t.project_id}/board?task=${t.id}`, ref: { type: 'task', id: t.id }, actorId: actor.id });
}

export interface ReparentInput { parentId: string | null; subprojectId?: string | null }

/**
 * Aufgabe → anderes Arbeitspaket desselben Projekts; Aufgabe → Arbeitspaket (parentId null: bekommt die Spalte des bisherigen
 * Arbeitspakets, Teilprojekt wählbar, sonst das bisherige); Arbeitspaket → Teilprojekt (parentId null mit subprojectId).
 * Keine zweite Ebene (Ziel muss ein Arbeitspaket sein), ein Arbeitspaket mit eigenen Aufgaben lässt sich nicht unterordnen.
 */
export async function reparentTask(db: Db, actor: StructureActor, taskId: string, p: ReparentInput): Promise<{ changed: boolean; task: any }> {
  const t = await taskRow(db, taskId);
  if (!t) throw badRequest('Arbeitspaket nicht gefunden');
  const details: Record<string, unknown> = {};
  if (p.parentId) {
    if (p.parentId === t.id) throw badRequest('Ein Arbeitspaket kann nicht unter sich selbst hängen');
    const parent = await taskRow(db, p.parentId);
    if (!parent || parent.project_id !== t.project_id) throw badRequest('Ziel-Arbeitspaket gehört nicht zum Projekt');
    if (parent.parent_id) throw badRequest(`${code(parent)} ist eine Aufgabe; Aufgaben haben keine eigenen Aufgaben`);
    if (t.subs > 0) throw badRequest(`${code(t)} hat eigene Aufgaben und kann nicht unter ein Arbeitspaket (nur eine Ebene)`);
    if (parent.archived_at) throw badRequest(`${code(parent)} ist archiviert`);
    if (t.parent_id === parent.id) return { changed: false, task: t };
    const oldParent = t.parent_id ? await taskRow(db, t.parent_id) : null;
    const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1 and parent_id = $2`, [t.column_id, parent.id]);
    await db.query(`update tasks set parent_id = $2, subproject_id = $3, position = $4, updated_at = now() where id = $1`, [t.id, parent.id, parent.subproject_id, pos.p]);
    details.parentId = parent.id; details.fromParentId = oldParent?.id ?? null;
    const label = `${code(t)} „${t.title}“`;
    if (oldParent) {
      await log(db, actor, oldParent.id, `Aufgabe ${label} nach ${code(parent)} „${parent.title}“ verschoben (${who(actor)})`);
      await log(db, actor, t.id, `Verschoben: von ${code(oldParent)} „${oldParent.title}“ unter ${code(parent)} „${parent.title}“ (${who(actor)})`);
    } else await log(db, actor, t.id, `Arbeitspaket wurde Aufgabe unter ${code(parent)} „${parent.title}“ (${who(actor)})`);
    await log(db, actor, parent.id, `Aufgabe ${label} ${oldParent ? `aus ${code(oldParent)} ` : ''}hierher verschoben (${who(actor)})`);
    await notifyMoved(db, actor, { ...t, parent_id: parent.id }, `Verschoben: ${t.title}`, `jetzt unter ${code(parent)} „${parent.title}“ (${who(actor)})`);
  } else if (t.parent_id) {
    // Aufgabe wird Arbeitspaket
    const oldParent = await taskRow(db, t.parent_id);
    const sp = p.subprojectId === undefined ? oldParent?.subproject_id ?? null : p.subprojectId;
    if (sp && !(await db.maybeOne(`select 1 from subprojects where id = $1 and project_id = $2`, [sp, t.project_id]))) throw badRequest('Teilprojekt gehört nicht zum Projekt');
    await db.query(`update tasks set parent_id = null, subproject_id = $2, updated_at = now() where id = $1`, [t.id, sp]);
    if (oldParent && !t.is_done) await moveTask(db, t.id, oldParent.column_id, null);
    details.parentId = null; details.fromParentId = oldParent?.id ?? null; details.subprojectId = sp;
    if (oldParent) await log(db, actor, oldParent.id, `Aufgabe ${code(t)} „${t.title}“ zum eigenen Arbeitspaket gemacht (${who(actor)})`);
    await log(db, actor, t.id, `Jetzt eigenes Arbeitspaket${oldParent ? ` (vorher Aufgabe unter ${code(oldParent)} „${oldParent.title}“)` : ''} (${who(actor)})`);
    await notifyMoved(db, actor, { ...t, parent_id: null }, `Jetzt eigenes Arbeitspaket: ${t.title}`, `von ${who(actor)}`);
  } else {
    // Arbeitspaket: Teilprojekt setzen oder entfernen, Aufgaben folgen
    if (p.subprojectId === undefined) return { changed: false, task: t };
    const sp = p.subprojectId;
    if (sp && !(await db.maybeOne(`select 1 from subprojects where id = $1 and project_id = $2`, [sp, t.project_id]))) throw badRequest('Teilprojekt gehört nicht zum Projekt');
    if ((t.subproject_id ?? null) === (sp ?? null)) return { changed: false, task: t };
    await db.query(`update tasks set subproject_id = $2, updated_at = now() where id = $1`, [t.id, sp]);
    await db.query(`update tasks set subproject_id = $2 where parent_id = $1`, [t.id, sp]);
    const name = sp ? (await db.one(`select name from subprojects where id = $1`, [sp])).name : null;
    const old = t.subproject_id ? (await db.maybeOne(`select name from subprojects where id = $1`, [t.subproject_id]))?.name : null;
    details.subprojectId = sp; details.fromSubprojectId = t.subproject_id ?? null;
    await log(db, actor, t.id, `Teilprojekt: ${old ? `„${old}“` : 'keines'} → ${name ? `„${name}“` : 'keines'} (${who(actor)})`);
  }
  await touchTask(db, t.id);
  await audit(db, { orgId: actor.orgId, projectId: t.project_id, userId: actor.id, action: 'task.reparent', objectType: 'task', objectId: t.id, details: { ...details, by: who(actor) } });
  return { changed: true, task: await taskRow(db, t.id) };
}

export interface PromoteInput { title?: string | null; dueDate?: string | null; startDate?: string | null; responsibleUserId?: string | null; responsibleEmail?: string | null }

/** Checklistenpunkt → Aufgabe am Arbeitspaket (bei der Checkliste einer Aufgabe: am Arbeitspaket darüber); der Punkt wird entfernt, Mails dazu bleiben am Arbeitspaket. */
export async function promoteItem(db: Db, actor: StructureActor, taskId: string, itemId: string, p: PromoteInput = {}): Promise<{ id: string; number: number; title: string }> {
  const t = await taskRow(db, taskId);
  if (!t) throw badRequest('Arbeitspaket nicht gefunden');
  const item = await db.maybeOne(`select * from checklist_items where id = $1 and task_id = $2`, [itemId, taskId]);
  if (!item) throw badRequest('Checklistenpunkt nicht gefunden');
  const ap = t.parent_id ? await taskRow(db, t.parent_id) : t;
  if (!ap) throw badRequest('Arbeitspaket nicht gefunden');
  const title = String(p.title ?? '').trim().slice(0, 200) || String(item.title).trim().slice(0, 200);
  const responsibleUserId = p.responsibleUserId !== undefined ? p.responsibleUserId : item.responsible_user_id ?? null;
  const responsibleEmail = p.responsibleEmail !== undefined ? p.responsibleEmail?.trim().toLowerCase() || null : responsibleUserId ? null : item.responsible_email ?? null;
  const r = await insertTask(db, { projectId: t.project_id, subprojectId: ap.subproject_id, columnId: item.done ? (await db.maybeOne(`select id from board_columns where project_id = $1 and is_done order by position limit 1`, [t.project_id]))?.id ?? null : null, title, dueDate: p.dueDate ?? null, startDate: p.startDate ?? null, responsibleUserId, responsibleEmail, createdBy: actor.id, parentId: ap.id });
  await db.query(`update mail_task_links set checklist_item_id = null where checklist_item_id = $1`, [item.id]);
  await db.query(`delete from checklist_items where id = $1`, [item.id]);
  const ref = code({ number: r.number }, t.project_key);
  await log(db, actor, ap.id, `Checklistenpunkt „${item.title}“${t.id !== ap.id ? ` (aus ${code(t)})` : ''} wurde Aufgabe ${ref} „${title}“${p.dueDate ? `, Termin ${p.dueDate}` : ''} (${who(actor)})`);
  await log(db, actor, r.id, `Entstanden aus dem Checklistenpunkt „${item.title}“ von ${code(ap)} (${who(actor)})`);
  await touchTask(db, ap.id);
  await audit(db, { orgId: actor.orgId, projectId: t.project_id, userId: actor.id, action: 'task.promote_item', objectType: 'task', objectId: r.id, details: { from: ap.id, item: item.title, title, by: who(actor) } });
  if (responsibleUserId && responsibleUserId !== actor.id) {
    const u = await db.maybeOne(`select kind from users where id = $1`, [responsibleUserId]);
    if (u?.kind === 'agent') queueAgentRun(r.id, 'assigned');
    else await dispatch(db, { event: 'assigned', projectId: t.project_id, taskId: r.id, type: 'task.assigned', title: `Dir zugewiesen: ${title}`, body: `von ${who(actor)}`, link: `/projekte/${t.project_id}/board?task=${r.id}`, ref: { type: 'task', id: r.id }, actorId: actor.id });
  }
  return { id: r.id, number: r.number, title };
}

/** Warum eine Aufgabe nicht zum Checklistenpunkt werden kann (null = geht); was dabei verloren geht, fasst das Log zusammen. */
export async function demoteBlocker(db: Db, taskId: string): Promise<string | null> {
  const t = await taskRow(db, taskId);
  if (!t) return 'Arbeitspaket nicht gefunden';
  if (!t.parent_id) return 'Nur Aufgaben lassen sich zu Checklistenpunkten machen';
  if (t.subs > 0) return 'Die Aufgabe hat eigene Aufgaben';
  const n = async (sql: string) => (await db.one(sql, [t.id])).n as number;
  if (await n(`select count(*)::int as n from time_entries where task_id = $1`)) return 'Die Aufgabe hat Zeitbuchungen';
  if (await n(`select count(*)::int as n from mail_task_links where task_id = $1`)) return 'Die Aufgabe hat verknüpfte Mails';
  if (await n(`select count(*)::int as n from questions where task_id = $1 and status = 'open'`)) return 'An der Aufgabe sind Fragen offen';
  return null;
}

/** Ziel-Aufgabe für demote: ausdrücklich (Aufgabe desselben Arbeitspakets) oder die einzige andere offene Aufgabe des Arbeitspakets. */
export async function demoteTarget(db: Db, t: any, toTaskId?: string | null): Promise<any> {
  if (toTaskId) {
    const to = await taskRow(db, toTaskId);
    if (!to || to.id === t.id || to.parent_id !== t.parent_id) throw badRequest('Ziel muss eine andere Aufgabe desselben Arbeitspakets sein');
    return to;
  }
  const open = await db.query(`select x.id from tasks x join board_columns c on c.id = x.column_id where x.parent_id = $1 and x.id <> $2 and x.deleted_at is null and x.archived_at is null and not c.is_done`, [t.parent_id, t.id]);
  if (open.rows.length !== 1) throw badRequest(open.rows.length ? 'Wähle die Aufgabe, an die der Checklistenpunkt kommt (toTaskId)' : 'Checklistenpunkte gehören zu Aufgaben: das Arbeitspaket hat keine andere offene Aufgabe');
  return taskRow(db, open.rows[0].id);
}

/**
 * Aufgabe → Checklistenpunkt einer anderen Aufgabe desselben Arbeitspakets: Log und Kommentare werden als ein Log-Eintrag an der
 * Ziel-Aufgabe zusammengefasst, Anhänge und Checkliste wandern mit. Die Aufgabe kommt in den Papierkorb (wie Löschen, 30 Tage);
 * tasks.demoted merkt den erzeugten Punkt, die Ziel-Aufgabe und das Mitgewanderte, damit undoDemote sie zurückholt.
 */
export async function demoteTask(db: Db, actor: StructureActor, taskId: string, toTaskId?: string | null): Promise<{ itemId: string; apId: string; targetId: string }> {
  const why = await demoteBlocker(db, taskId);
  if (why) throw badRequest(why);
  const t = await taskRow(db, taskId);
  const ap = await taskRow(db, t.parent_id);
  if (!ap) throw badRequest('Arbeitspaket nicht gefunden');
  const target = await demoteTarget(db, t, toTaskId);
  const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from checklist_items where task_id = $1`, [target.id]);
  const item = await db.one(`insert into checklist_items (task_id, title, done, responsible_user_id, responsible_email, position) values ($1,$2,$3,$4,$5,$6) returning id`, [target.id, String(t.title).slice(0, 300), Boolean(t.is_done), t.responsible_user_id ?? null, t.responsible_email ?? null, pos.p]);
  // Eigene Checkliste der Aufgabe: als Punkte an der Ziel-Aufgabe anhängen (Positionen merken für das Zurückholen)
  const moved = (await db.query(`update checklist_items set task_id = $2, position = position + $3 where task_id = $1 returning id, position - $3 as old_position`, [t.id, target.id, Number(pos.p) + 1])).rows.map((r: any) => ({ id: r.id, position: Number(r.old_position) }));
  const atts = (await db.query(`update attachments set task_id = $2 where task_id = $1 returning id`, [t.id, target.id])).rows.map((r: any) => r.id as string);
  const comments = await db.query(`select c.body, c.created_at, u.name from task_comments c join users u on u.id = c.user_id where c.task_id = $1 order by c.created_at`, [t.id]);
  const extra = [t.description ? `Beschreibung: ${String(t.description).trim()}` : '', dateStr(t.due_date) ? `Termin ${dateStr(t.due_date)}` : ''].filter(Boolean);
  const summary = comments.rows.map((c: any) => `- ${new Date(c.created_at).toLocaleDateString('de-DE')} ${c.name}: ${String(c.body).replace(/\s+/g, ' ').trim()}`).join('\n');
  const body = `Aufgabe ${code(t)} „${t.title}“ wurde Checklistenpunkt von ${code(target)} „${target.title}“ (${who(actor)})${extra.length ? `. ${extra.join('; ')}` : ''}${summary ? `\nLog der Aufgabe:\n${summary}` : ''}`;
  await log(db, actor, target.id, body.length > 4000 ? body.slice(0, 3990) + ' …' : body);
  await log(db, actor, ap.id, `Aufgabe ${code(t)} „${t.title}“ wurde Checklistenpunkt von ${code(target)} „${target.title}“ (${who(actor)}); die Aufgabe liegt im Papierkorb und lässt sich dort wiederherstellen`);
  const demoted = { itemId: item.id, targetId: target.id, apId: ap.id, items: moved, attachments: atts, by: who(actor), at: new Date().toISOString() };
  await db.query(`update tasks set deleted_at = now(), deleted_was_archived = archived_at is not null, archived_at = coalesce(archived_at, now()), demoted = $2, updated_at = now() where id = $1`, [t.id, JSON.stringify(demoted)]);
  await touchTask(db, ap.id); await touchTask(db, target.id);
  await audit(db, { orgId: actor.orgId, projectId: t.project_id, userId: actor.id, action: 'task.demote', objectType: 'task', objectId: target.id, details: { from: t.id, title: t.title, itemId: item.id, apId: ap.id, by: who(actor), trashed: true } });
  return { itemId: item.id, apId: ap.id, targetId: target.id };
}

/**
 * Rückgängig (Wiederherstellen aus dem Papierkorb einer Aufgabe, die Checklistenpunkt wurde): erzeugten Punkt entfernen (falls noch
 * da), mitgewanderte Punkte und Anhänge zurück, sofern sie noch an der Ziel-Aufgabe hängen. Die Aufgabe selbst stellt der Aufrufer
 * wieder her (deleted_at). Liefert die Ziel-Aufgabe für Log und Checklisten-Abgleich; null = keine Umwandlung gemerkt.
 */
export async function undoDemote(db: Db, actor: StructureActor, taskId: string): Promise<{ targetId: string | null } | null> {
  const t = await db.maybeOne(`select t.*, p.key as project_key from tasks t join projects p on p.id = t.project_id where t.id = $1`, [taskId]);
  const d = t?.demoted;
  if (!d) return null;
  const target = d.targetId ? await db.maybeOne(`select t.*, p.key as project_key from tasks t join projects p on p.id = t.project_id where t.id = $1`, [d.targetId]) : null;
  if (d.itemId) await db.query(`delete from checklist_items where id = $1`, [d.itemId]);
  if (target) {
    for (const it of (d.items ?? []) as { id: string; position: number }[]) await db.query(`update checklist_items set task_id = $2, position = $3 where id = $1 and task_id = $4`, [it.id, t.id, it.position, target.id]);
    if ((d.attachments ?? []).length) await db.query(`update attachments set task_id = $2 where id = any($1::uuid[]) and task_id = $3`, [d.attachments, t.id, target.id]);
    await log(db, actor, target.id, `Checklistenpunkt „${t.title}“ ist wieder die Aufgabe ${code(t)} (wiederhergestellt von ${who(actor)})`);
    await touchTask(db, target.id);
  }
  await db.query(`update tasks set demoted = null where id = $1`, [t.id]);
  if (t.parent_id) await log(db, actor, t.parent_id, `Aufgabe ${code(t)} „${t.title}“ aus dem Papierkorb wiederhergestellt (war Checklistenpunkt${target ? ` von ${code(target)}` : ''}; ${who(actor)})`);
  await audit(db, { orgId: actor.orgId, projectId: t.project_id, userId: actor.id, action: 'task.undemote', objectType: 'task', objectId: t.id, details: { title: t.title, itemId: d.itemId, targetId: d.targetId ?? null, by: who(actor) } });
  return { targetId: target?.id ?? null };
}

/** Checklistenpunkt an eine andere Aufgabe desselben Projekts (Checklistenpunkte gehören zu Aufgaben). */
export async function moveItem(db: Db, actor: StructureActor, taskId: string, itemId: string, toTaskId: string): Promise<void> {
  const t = await taskRow(db, taskId);
  if (!t) throw badRequest('Arbeitspaket nicht gefunden');
  const item = await db.maybeOne(`select * from checklist_items where id = $1 and task_id = $2`, [itemId, taskId]);
  if (!item) throw badRequest('Checklistenpunkt nicht gefunden');
  const to = await taskRow(db, toTaskId);
  if (!to || to.project_id !== t.project_id) throw badRequest('Ziel gehört nicht zum Projekt');
  if (to.id === t.id) return;
  if (!to.parent_id) throw badRequest(`${code(to)} ist ein Arbeitspaket; Checklistenpunkte gehören zu Aufgaben (Ziel muss eine Aufgabe sein)`);
  const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from checklist_items where task_id = $1`, [to.id]);
  await db.query(`update checklist_items set task_id = $2, position = $3 where id = $1`, [item.id, to.id, pos.p]);
  await db.query(`update mail_task_links set checklist_item_id = null where checklist_item_id = $1 and task_id <> $2`, [item.id, to.id]);
  await log(db, actor, t.id, `Checklistenpunkt „${item.title}“ nach ${code(to)} „${to.title}“ verschoben (${who(actor)})`);
  await log(db, actor, to.id, `Checklistenpunkt „${item.title}“ aus ${code(t)} „${t.title}“ hierher verschoben (${who(actor)})`);
  await touchTask(db, t.id); await touchTask(db, to.id);
  await audit(db, { orgId: actor.orgId, projectId: t.project_id, userId: actor.id, action: 'checklist.move', objectType: 'task', objectId: to.id, details: { from: t.id, item: item.title, by: who(actor) } });
}

/**
 * Altbestand: alle Checklistenpunkte eines Arbeitspakets in EINE neue Aufgabe (Titel aus dem Aufruf, sonst „Checkliste“).
 * Die Aufgabe steht in der Spalte des Arbeitspakets (alle Punkte erledigt: erste Erledigt-Spalte); Mail-Bezüge zu den Punkten
 * bleiben am Arbeitspaket ohne Punktbezug. Log am Arbeitspaket und an der Aufgabe, Audit checklist.convert.
 */
export async function convertApChecklist(db: Db, actor: StructureActor, apId: string, title?: string | null): Promise<{ id: string; number: number; title: string; count: number }> {
  const ap = await taskRow(db, apId);
  if (!ap) throw badRequest('Arbeitspaket nicht gefunden');
  if (ap.parent_id) throw badRequest(`${code(ap)} ist eine Aufgabe; ihre Checkliste gehört schon zu ihr`);
  const items = (await db.query(`select id, title, done from checklist_items where task_id = $1 order by position, title`, [ap.id])).rows;
  if (!items.length) throw badRequest('Das Arbeitspaket hat keine Checklistenpunkte');
  const name = String(title ?? '').trim().slice(0, 200) || 'Checkliste';
  const allDone = items.every((i: any) => i.done);
  const doneCol = allDone || ap.is_done ? (await db.maybeOne(`select id from board_columns where project_id = $1 and is_done order by position limit 1`, [ap.project_id]))?.id ?? null : null;
  const r = await insertTask(db, { projectId: ap.project_id, subprojectId: ap.subproject_id, columnId: allDone ? doneCol : ap.is_done ? null : ap.column_id, title: name, createdBy: actor.id, parentId: ap.id });
  for (const [i, it] of items.entries()) await db.query(`update checklist_items set task_id = $2, position = $3 where id = $1`, [it.id, r.id, i]);
  await db.query(`update mail_task_links set checklist_item_id = null where task_id = $1 and checklist_item_id = any($2::uuid[])`, [ap.id, items.map((i: any) => i.id)]);
  const ref = code({ number: r.number }, ap.project_key);
  await log(db, actor, ap.id, `${items.length} Checklistenpunkte in die Aufgabe ${ref} „${name}“ überführt (${who(actor)})`);
  await log(db, actor, r.id, `Entstanden aus der Checkliste von ${code(ap)} (${items.length} Punkte, ${who(actor)})`);
  await touchTask(db, ap.id);
  await audit(db, { orgId: actor.orgId, projectId: ap.project_id, userId: actor.id, action: 'checklist.convert', objectType: 'task', objectId: r.id, details: { from: ap.id, count: items.length, title: name, by: who(actor) } });
  return { id: r.id, number: r.number, title: name, count: items.length };
}

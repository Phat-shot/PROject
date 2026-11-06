import type { Db } from './db.js';
import { audit } from './audit.js';
import { PERSONAL_COLUMNS, PERSONAL_FOLDERS, PERSONAL_PLANNING_DEPTH, projectPolicy, SQL } from './projectPolicy.js';
import { createDefaultFolders } from './docs/service.js';

/**
 * Persönliches Projekt einer Person (Konzept 18, Assistent): dieselbe Basis wie jedes Projekt, beim Anlegen schlank
 * (zwei Spalten „Offen“ und „Erledigt“, Ordner „Notizen“, Planungstiefe Checkliste, Eskalation und Reporting aus).
 * Angelegt beim Annehmen einer Einladung mit „persönliches Projekt freigeben“, beim Setzen der Freigabe durch die
 * Verwaltung oder von der Person selbst (POST /projects mit personal). Kürzel aus Initialen plus laufender Nummer.
 */

/** Standardspalten neuer Projekte: Geplant, Wartet und Zurückgestellt bilden die Gruppe „Nicht in Arbeit“ (eine Board-Spalte mit drei Abschnitten) */
export const DEFAULT_COLUMNS: [string, 'backlog' | 'active' | 'waiting' | 'parked' | 'done', string | null][] = [['Geplant', 'backlog', 'Nicht in Arbeit'], ['Offen', 'active', null], ['In Arbeit', 'active', null], ['In Prüfung', 'active', null], ['Wartet', 'waiting', 'Nicht in Arbeit'], ['Zurückgestellt', 'parked', 'Nicht in Arbeit'], ['Erledigt', 'done', null]];

/** Initialen eines Namens als Kürzel (Großbuchstaben, mindestens zwei Zeichen: „Max Keller“ → MK, „Max“ → MP). */
export function initialsOf(name: string): string {
  const parts = String(name ?? '').normalize('NFKD').replace(/[^\p{L}\p{N}\s-]/gu, '').split(/[\s-]+/).filter(Boolean);
  let s = parts.map((p) => p[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (s.length < 2) s = (s + 'P').slice(0, 2);
  return s || 'PP';
}

/** Freies Kürzel im Mandanten: Initialen plus Nummer (MK1, MK2, …). */
export async function freePersonalKey(db: Db, orgId: string, name: string): Promise<string> {
  const base = initialsOf(name);
  for (let n = 1; n < 1000; n++) {
    const key = `${base}${n}`;
    if (!(await db.maybeOne(`select 1 from projects where org_id = $1 and key = $2`, [orgId, key]))) return key;
  }
  throw new Error('Kein freies Kürzel');
}

/** Aktives persönliches Projekt einer Person (das älteste, falls mehrere). */
export async function personalProjectOf(db: Db, userId: string): Promise<{ id: string; key: string; name: string } | null> {
  return db.maybeOne(`select p.id, p.key, p.name from projects p where p.created_by = $1 and ${SQL.isPersonal('p')} and p.status = 'active' and p.kind = 'project' order by p.created_at limit 1`, [userId]);
}

/** Spalten, Ordner und Vorgaben eines neuen Projekts: schlank für persönliche Projekte, sonst Standard. */
export async function scaffoldProject(db: Db, projectId: string, personal: boolean): Promise<void> {
  const policy = projectPolicy({ personal });
  if (policy.scaffold.slim) {
    for (const [i, [name, kind]] of PERSONAL_COLUMNS.entries()) await db.query(`insert into board_columns (project_id, name, position, is_done, kind) values ($1,$2,$3,$4,$5)`, [projectId, name, i, kind === 'done', kind]);
    for (const [i, name] of PERSONAL_FOLDERS.entries()) await db.query(`insert into doc_folders (project_id, name, position) values ($1,$2,$3)`, [projectId, name, i]);
    await db.query(`update projects set planning_depth = $2, escalation = coalesce(escalation, '{}'::jsonb) || '{"enabled": false}'::jsonb, reporting = coalesce(reporting, '{}'::jsonb) || '{"enabled": false}'::jsonb where id = $1`, [projectId, PERSONAL_PLANNING_DEPTH]);
    return;
  }
  for (const [i, [name, kind, group]] of DEFAULT_COLUMNS.entries()) await db.query(`insert into board_columns (project_id, name, position, is_done, kind, group_name) values ($1,$2,$3,$4,$5,$6)`, [projectId, name, i, kind === 'done', kind, group]);
  if (policy.scaffold.defaultFolders) await createDefaultFolders(db, projectId);
}

/**
 * Persönliches Projekt anlegen (Eigentümer = die Person, PL), schlank. Gibt es schon eines, kommt dieses zurück.
 * actorId: wer es auslöst (Annahme der Einladung: die Person selbst; Verwaltung: der Org-Admin).
 */
export async function ensurePersonalProject(db: Db, owner: { id: string; org_id: string; name: string }, actorId: string, via: string): Promise<{ id: string; key: string; name: string; created: boolean }> {
  const existing = await personalProjectOf(db, owner.id);
  if (existing) return { ...existing, created: false };
  const key = await freePersonalKey(db, owner.org_id, owner.name);
  const name = `Persönlich – ${owner.name}`.slice(0, 120);
  const p = await db.one(`insert into projects (org_id, key, name, description, created_by, personal, visibility) values ($1,$2,$3,null,$4,true,'members') returning id, key, name`, [owner.org_id, key, name, owner.id]);
  await db.query(`insert into project_members (project_id, user_id, role, can_edit_plan, can_approve, can_finalize, can_use_ai) values ($1,$2,'pl',true,true,true,true)`, [p.id, owner.id]);
  await scaffoldProject(db, p.id, true);
  await audit(db, { orgId: owner.org_id, projectId: p.id, userId: actorId, action: 'project.create', objectType: 'project', objectId: p.id, details: { key, name, template: null, personal: true, auto: via } });
  return { id: p.id, key: p.key, name: p.name, created: true };
}

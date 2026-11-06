import type { BoardColumn } from '@projekttool/shared';

/** Eine Board-Spalte: entweder eine einzelne Spalte oder eine Gruppe gleichnamiger Spalten mit Abschnitten untereinander. */
export interface BoardGroup { key: string; group: string | null; columns: BoardColumn[] }

/**
 * Spalten mit gleicher Gruppe bilden eine Board-Spalte (Reihenfolge der Abschnitte nach Position); die Gruppe steht an der
 * Position ihrer vordersten Spalte. Spalten ohne Gruppe bleiben einzeln.
 */
export function groupColumns(columns: BoardColumn[]): BoardGroup[] {
  const out: BoardGroup[] = [];
  const byName = new Map<string, BoardGroup>();
  for (const c of [...columns].sort((a, b) => a.position - b.position)) {
    const g = c.group?.trim() || null;
    if (!g) { out.push({ key: c.id, group: null, columns: [c] }); continue; }
    const hit = byName.get(g);
    if (hit) hit.columns.push(c);
    else { const n = { key: `g:${g}`, group: g, columns: [c] }; byName.set(g, n); out.push(n); }
  }
  return out;
}

/** Vorhandene Gruppennamen in Reihenfolge des ersten Auftretens (für die Datalist im Spaltenformular). */
export function groupNames(columns: { group?: string | null }[]): string[] {
  const seen: string[] = [];
  for (const c of columns) { const g = c.group?.trim(); if (g && !seen.includes(g)) seen.push(g); }
  return seen;
}

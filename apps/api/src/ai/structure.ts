import type { PlanningDepth } from '@projekttool/shared';
import { PLANNING_DEPTHS } from '@projekttool/shared';

/**
 * Struktur-Regel und Verschiebe-Aktionen für Agentenläufe: fester Systemblock nach den Lauf-Regeln (wie DATA_RULE, für alle
 * Läufe gleich, Prefix-Cache). docs/KI-Sheet.md enthält denselben Text (Test prüft die Übereinstimmung). Die im Projekt
 * gewählte Planungstiefe steht als ein Satz im variablen Prompt-Kontext (planningDepthText); das System setzt sie
 * zusätzlich durch (applyPlanningDepth), damit der Agent nicht mal Aufgaben, mal Checklistenpunkte anlegt.
 */
export const STRUCTURE_RULES = `# Struktur: Aufgabe oder Task (Checklistenpunkt)
Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task. Nie beides für dieselbe Sache. Die Planungstiefe des Projekts (im Prompt) entscheidet:
- auto: Aufgabe = eigener Schritt mit eigener Zuständigkeit, eigenem Termin oder eigenem Status/Log (mehr als ein Arbeitstag, delegierbar, von außen nachverfolgbar). Task = kurzer Prüf- oder Erledigungspunkt ohne eigenen Termin und ohne andere Zuständigkeit, den die zuständige Person des AP bzw. der Aufgabe selbst abhakt. Ein AP ohne Aufgaben bekommt Tasks; sobald ein Schritt eine andere Person oder einen eigenen Termin braucht, wird er Aufgabe.
- aufgaben: Schritte immer als Aufgaben (create_aufgabe); Tasks nur als Checkliste einer Aufgabe.
- checkliste: Schritte immer als Tasks (add_item, items); Aufgaben nur auf ausdrücklichen Wunsch oder mit Termin bzw. anderer Zuständigkeit.
Das System setzt die Regel um (Aufgabe ohne Termin und Zuständigkeit wird Task und umgekehrt) und vermerkt das im Log.
Verschieben (Bitte „verschieben“, „umhängen“, „zuordnen“ heißt: Aktion angeben, nicht nur antworten):
- move_aufgabe: ref = Kennung der Aufgabe, target = Kennung des Ziel-AP (gleiches Projekt); nimmt Tasks, Anhänge, Log und Zeiten mit
- move_ap: ref = Kennung des AP, subproject = Name des Teilprojekts (leer = aus dem Teilprojekt heraus)
- promote_item: itemId aus der Task-Liste wird Aufgabe am AP; title, dueDate, responsible optional; der Task entfällt
- demote_aufgabe: ref = Kennung einer Aufgabe ohne Zeiten, Mails und offene Fragen; sie wird Task am AP, ihr Log steht zusammengefasst dort
- move_item: itemId aus der Task-Liste, target = Kennung des Ziel-AP oder der Ziel-Aufgabe
Rechte wie beim Anlegen; außerhalb deines Bereichs oder bei Bestätigungspflicht (Klasse Umstrukturieren) legt das System die Aktion der PL vor.`;

/** Ein Satz für den variablen Prompt-Kontext: welche Planungstiefe im Projekt gilt. */
export function planningDepthText(depth: unknown): string {
  const d = normDepth(depth);
  const hint = PLANNING_DEPTHS.find((x) => x.key === d)!;
  return `Planungstiefe dieses Projekts: ${d} (${hint.label}). ${hint.hint}`;
}

export function normDepth(v: unknown): PlanningDepth {
  return PLANNING_DEPTHS.some((d) => d.key === v) ? (v as PlanningDepth) : 'auto';
}

const has = (v: unknown) => Boolean(String(v ?? '').trim());

/**
 * Struktur-Regel durchsetzen, bevor Aktionen laufen. isAp = der Lauf hängt an einem Arbeitspaket (add_item landet dort);
 * an einer Aufgabe bleibt add_item ihre Checkliste. Jede Umsetzung liefert einen Hinweis für Log und Lauf-Protokoll.
 * - aufgaben: add_item am AP → create_aufgabe (ohne Termin/Zuständigkeit, Titel = Text)
 * - checkliste: create_aufgabe ohne Termin und Zuständigkeit → add_item am Ziel-AP (ref), items hängen als weitere add_item an
 * - auto: create_aufgabe ohne Termin, ohne Zuständigkeit, Titel unter 60 Zeichen, ohne items → add_item am Ziel-AP
 */
export function applyPlanningDepth<A extends { type: string }>(actions: A[], o: { depth: unknown; isAp: boolean }): { actions: A[]; notes: string[] } {
  const depth = normDepth(o.depth);
  const out: A[] = []; const notes: string[] = [];
  for (const a0 of actions) {
    const a: any = a0;
    if (depth === 'aufgaben' && a.type === 'add_item' && o.isAp && has(a.text) && !has(a.ref)) {
      out.push({ type: 'create_aufgabe', title: String(a.text).trim().slice(0, 200), text: '', ref: '', startDate: '', dueDate: '', responsible: '', items: [] } as any);
      notes.push(`„${String(a.text).trim().slice(0, 80)}“ als Aufgabe angelegt, weil die Planungstiefe des Projekts „Immer Aufgaben“ ist`);
      continue;
    }
    if (a.type === 'create_aufgabe' && has(a.title) && !has(a.dueDate) && !has(a.startDate) && !has(a.responsible)) {
      const items = Array.isArray(a.items) ? a.items.map((x: unknown) => String(x ?? '').trim()).filter(Boolean) : [];
      const title = String(a.title).trim();
      const auto = depth === 'auto' && title.length < 60 && !items.length;
      if (depth === 'checkliste' || auto) {
        out.push({ type: 'add_item', text: title.slice(0, 300), ref: a.ref ?? '' } as any);
        for (const it of items) out.push({ type: 'add_item', text: String(it).slice(0, 300), ref: a.ref ?? '' } as any);
        notes.push(`„${title.slice(0, 80)}“ als Checklistenpunkt angelegt, weil ${depth === 'checkliste' ? 'die Planungstiefe des Projekts „Immer Checklistenpunkte“ ist' : 'der Schritt weder Termin noch eigene Zuständigkeit hat (Planungstiefe „Automatisch“)'}${items.length ? `; ${items.length} Tasks dazu ebenfalls` : ''}`);
        continue;
      }
    }
    out.push(a0);
  }
  return { actions: out, notes };
}

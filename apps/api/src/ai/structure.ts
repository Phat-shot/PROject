import type { PlanningDepth } from '@projekttool/shared';
import { PLANNING_DEPTHS } from '@projekttool/shared';

/**
 * Struktur-Regel und Verschiebe-Aktionen für Agentenläufe: fester Systemblock nach den Lauf-Regeln (wie DATA_RULE, für alle
 * Läufe gleich, Prefix-Cache). docs/KI-Sheet.md enthält denselben Text (Test prüft die Übereinstimmung). Die im Projekt
 * gewählte Planungstiefe steht als ein Satz im variablen Prompt-Kontext (planningDepthText); das System setzt sie
 * zusätzlich durch (applyPlanningDepth), damit der Agent nicht mal Aufgaben, mal Checklistenpunkte anlegt.
 */
export const STRUCTURE_RULES = `# Struktur: Aufgabe oder Task (Checklistenpunkt)
Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task. Checklistenpunkte (Tasks) hängen an Aufgaben. Am Arbeitspaket legst du Aufgaben an. Ist der letzte Checklistenpunkt erledigt, schließt die Aufgabe automatisch; sind alle Aufgaben erledigt, das Arbeitspaket. Nie beides für dieselbe Sache. Die Planungstiefe des Projekts (im Prompt) entscheidet:
- auto: Aufgabe = eigener Schritt mit eigener Zuständigkeit, eigenem Termin oder eigenem Status/Log (delegierbar, von außen nachverfolgbar). Task = kurzer Prüf- oder Erledigungspunkt einer Aufgabe ohne eigenen Termin und ohne andere Zuständigkeit.
- aufgaben: Schritte immer als Aufgaben (create_aufgabe); Tasks nur als Checkliste einer Aufgabe.
- checkliste: wenige Aufgaben, Schritte als ihre Tasks (create_aufgabe mit items, add_item an der Aufgabe); create_ap mit items bekommt eine Aufgabe „Schritte“.
add_item am AP: das System hängt den Task an die einzige offene Aufgabe oder legt eine Aufgabe mit dem Text an und vermerkt das im Log.
Verschieben (Bitte „verschieben“, „umhängen“, „zuordnen“ heißt: Aktion angeben, nicht nur antworten):
- move_aufgabe: ref = Kennung der Aufgabe, target = Kennung des Ziel-AP (gleiches Projekt); nimmt Tasks, Anhänge, Log und Zeiten mit
- move_ap: ref = Kennung des AP, subproject = Name des Teilprojekts (leer = aus dem Teilprojekt heraus)
- promote_item: itemId aus der Task-Liste wird Aufgabe am AP; title, dueDate, responsible optional; der Task entfällt
- demote_aufgabe: ref = Kennung einer Aufgabe ohne Zeiten, Mails und offene Fragen, target = Aufgabe, deren Task sie wird (leer = einzige andere offene Aufgabe des AP); ihr Log steht zusammengefasst dort
- move_item: itemId aus der Task-Liste, target = Kennung der Ziel-Aufgabe
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
 * Struktur-Regel durchsetzen, bevor Aktionen laufen. Checklistenpunkte gehören zu Aufgaben. isAp = der Lauf hängt an einem
 * Arbeitspaket; soleAufgabe = Kennung der einzigen offenen Aufgabe dieses AP (sonst null). Jede Umsetzung liefert einen Hinweis
 * für Log und Lauf-Protokoll. add_item am AP ohne passende Aufgabe setzt der Lauf selbst um (Aufgabe anlegen, agent.ts).
 * - aufgaben: add_item am AP → create_aufgabe (ohne Termin/Zuständigkeit, Titel = Text)
 * - checkliste: create_aufgabe ohne Termin, Zuständigkeit und items für dieses AP bzw. diese Aufgabe → add_item an der Aufgabe
 *   (am AP: an der einzigen offenen Aufgabe); mit items bleibt sie Aufgabe mit Checkliste
 * - auto: wie checkliste, nur bei Titel unter 60 Zeichen
 */
export function applyPlanningDepth<A extends { type: string }>(actions: A[], o: { depth: unknown; isAp: boolean; soleAufgabe?: string | null; ownRef?: number | null }): { actions: A[]; notes: string[] } {
  const depth = normDepth(o.depth);
  const out: A[] = []; const notes: string[] = [];
  const own = (ref: unknown) => !has(ref) || (o.ownRef != null && Number(String(ref).trim().split('-').pop()) === o.ownRef);
  for (const a0 of actions) {
    const a: any = a0;
    if (depth === 'aufgaben' && a.type === 'add_item' && o.isAp && has(a.text) && !has(a.ref)) {
      out.push({ type: 'create_aufgabe', title: String(a.text).trim().slice(0, 200), text: '', ref: '', startDate: '', dueDate: '', responsible: '', items: [] } as any);
      notes.push(`„${String(a.text).trim().slice(0, 80)}“ als Aufgabe angelegt, weil die Planungstiefe des Projekts „Immer Aufgaben“ ist`);
      continue;
    }
    if (depth !== 'aufgaben' && a.type === 'create_aufgabe' && has(a.title) && !has(a.dueDate) && !has(a.startDate) && !has(a.responsible) && own(a.ref)) {
      const items = Array.isArray(a.items) ? a.items.map((x: unknown) => String(x ?? '').trim()).filter(Boolean) : [];
      const title = String(a.title).trim();
      const fits = !items.length && (depth === 'checkliste' || title.length < 60);
      const target = o.isAp ? o.soleAufgabe ?? null : '';
      if (fits && target !== null) {
        out.push({ type: 'add_item', text: title.slice(0, 300), ref: target } as any);
        notes.push(`„${title.slice(0, 80)}“ als Checklistenpunkt ${o.isAp ? `der Aufgabe ${target}` : 'dieser Aufgabe'} angelegt, weil ${depth === 'checkliste' ? 'die Planungstiefe des Projekts „Immer Checklistenpunkte“ ist' : 'der Schritt weder Termin noch eigene Zuständigkeit hat (Planungstiefe „Automatisch“)'}`);
        continue;
      }
    }
    out.push(a0);
  }
  return { actions: out, notes };
}

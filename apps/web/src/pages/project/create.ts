import { api } from '../../lib/api';
import { useDialog } from '../../components/ui';
import { useProject } from '../ProjectPage';

/**
 * Ein Rahmen zum Anlegen: nur den Titel eingeben (im Kontext schon gesetzt, was feststeht: Teilprojekt, Über-AP, Spalte),
 * danach öffnet die Maske mit allen Feldern. Gilt für Arbeitspakete, Aufgaben und Teilprojekte; Meilensteine haben keine
 * eigene Maske und brauchen dazu nur das Datum. Checklistenpunkte entstehen inline im Arbeitspaket.
 */
export function useCreate() {
  const { detail, reload, reloadTasks, openTask, openSubproject } = useProject();
  const dialog = useDialog();
  const pid = detail.project.id;
  const firstActive = () => (detail.columns.find((c) => c.kind === 'active') ?? detail.columns.find((c) => !c.isDone) ?? detail.columns[0])?.id;
  const spOptions = [{ value: '', label: '– keines –' }, ...detail.subprojects.map((s) => ({ value: s.id, label: s.name }))];

  const task = async (o: { title?: string; subprojectId?: string | null; parentId?: string; columnId?: string; responsibleUserId?: string | null } = {}): Promise<string | null> => {
    let title = o.title?.trim();
    let subprojectId = o.subprojectId;
    if (!title) {
      const askSp = !o.parentId && subprojectId === undefined && detail.subprojects.length > 0;
      const v = await dialog.form({ title: o.parentId ? 'Neue Aufgabe' : 'Neues Arbeitspaket', text: 'Der Titel genügt; danach öffnet die Maske mit allen Feldern.', submitLabel: 'Anlegen',
        fields: [{ key: 'title', label: 'Titel', required: true }, ...(askSp ? [{ key: 'subprojectId', label: 'Teilprojekt', type: 'select' as const, value: '', options: spOptions }] : [])] });
      if (!v) return null;
      title = v.title;
      if (askSp) subprojectId = v.subprojectId || null;
    }
    const body: Record<string, unknown> = { title };
    if (o.parentId) { body.parentId = o.parentId; if (o.responsibleUserId) body.responsibleUserId = o.responsibleUserId; } else { body.columnId = o.columnId ?? firstActive(); body.subprojectId = subprojectId ?? null; }
    const r = await api.post<{ task: { id: string } }>(`/projects/${pid}/tasks`, body);
    await reloadTasks();
    openTask(r.task.id);
    return r.task.id;
  };

  const subproject = async (name?: string): Promise<string | null> => {
    let n = name?.trim();
    if (!n) {
      const v = await dialog.form({ title: 'Neues Teilprojekt', text: 'Der Name genügt; danach öffnet die Maske (Verantwortung, Zeitraum, Beschreibung, Sichtbarkeit, Meilensteine).', submitLabel: 'Anlegen', fields: [{ key: 'name', label: 'Name', required: true }] });
      if (!v) return null;
      n = v.name;
    }
    const r = await api.post<{ subproject: { id: string } }>(`/projects/${pid}/subprojects`, { name: n });
    await reload();
    openSubproject(r.subproject.id);
    return r.subproject.id;
  };

  const milestone = async (subprojectId?: string | null): Promise<boolean> => {
    const v = await dialog.form({ title: 'Neuer Meilenstein', submitLabel: 'Anlegen', fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'date', label: 'Datum', type: 'date', required: true },
      ...(subprojectId === undefined ? [{ key: 'subprojectId', label: 'Teilprojekt', type: 'select' as const, value: '', options: spOptions }] : [])
    ] });
    if (!v) return false;
    await api.post(`/projects/${pid}/milestones`, { name: v.name, date: v.date, subprojectId: subprojectId === undefined ? v.subprojectId || null : subprojectId });
    await reload();
    return true;
  };

  return { task, subproject, milestone };
}

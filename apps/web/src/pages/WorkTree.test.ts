import { describe, expect, it } from 'vitest';
import { buildWorkTree, type WorkProject } from './WorkTree';

const me = 'me';
const resp = (userId: string | null, inherited = false): any => ({ userId, email: null, name: userId, inherited, inheritedFrom: inherited ? 'project' : null });
const task = (id: string, sub: string | null, userId: string | null, inherited: boolean, done = false): any => ({ id, projectId: 'p', subprojectId: sub, title: id, done, responsible: resp(userId, inherited), responsibleUserId: inherited ? null : userId, dueDate: null, priority: 'normal', blocked: false, escalationLevel: 0, conflicts: [], checklistTotal: 0, checklistDone: 0, archivedAt: null });
const project = (lead: string, tasks: any[], checklist: any[] = []): WorkProject => ({ id: 'p', key: 'P', name: 'Projekt', myRole: 'member', lead: { userId: lead, name: lead }, subprojects: [{ id: 's1', name: 'TP1', responsible: resp('other'), responsibleUserId: 'other', restricted: false } as any], tasks, checklist });

describe('Meine Arbeit (geklammerte Sicht)', () => {
  it('zeigt eigene und geerbte Arbeitspakete, lässt fremde weg', () => {
    const nodes = buildWorkTree([project('other', [task('a', 's1', 'me', true), task('b', 's1', 'other', false), task('c', null, 'me', false)])], me, false);
    const items = nodes[0].lanes.flatMap((l) => l.items.map((i) => i.ap.id));
    expect(items).toEqual(['a', 'c']);
  });
  it('blendet erledigte aus, außer „erledigte zeigen“ ist an', () => {
    const p = project('me', [task('a', null, 'me', false, true)]);
    expect(buildWorkTree([p], me, false)[0]?.lanes.length ?? 0).toBe(0);
    expect(buildWorkTree([p], me, true)[0].lanes[0].items[0].ap.id).toBe('a');
  });
  it('Tasks: nur eigene oder geerbte vom eigenen Arbeitspaket', () => {
    const p = project('other', [task('a', null, 'me', false)], [{ id: 't1', taskId: 'a', title: 'eigener', done: false, responsibleUserId: null, position: 0 }, { id: 't2', taskId: 'a', title: 'fremd', done: false, responsibleUserId: 'other', position: 1 }] as any);
    const t = buildWorkTree([p], me, false)[0].lanes[0].items[0].tasks.map((x) => x.item.id);
    expect(t).toEqual(['t1']);
  });
  it('Projekt erscheint für die Projektleitung auch ohne Zuweisungen', () => {
    expect(buildWorkTree([project('me', [])], me, false)).toHaveLength(1);
    expect(buildWorkTree([project('other', [])], me, false)).toHaveLength(0);
  });
});

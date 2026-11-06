import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn(async () => ({}));
vi.mock('./api', () => ({ api: { post: (...a: unknown[]) => (post as any)(...a) } }));
import { moveTaskTo, reviewOptsOf } from './moveTask';

const detail = (reviewRequired: boolean) => ({ project: { reviewRequired }, members: [
  { userId: 'u1', name: 'Petra Lenz', role: 'pl' }, { userId: 'u2', name: 'Max Keller', role: 'member' }, { userId: 'u3', name: 'Lea Reuter', role: 'reader' }, { userId: 'a1', name: 'Agent', role: 'member', kind: 'agent' }
] });

describe('Status „In Prüfung“: Prüfer wählen', () => {
  beforeEach(() => post.mockClear());
  it('Auswahl ohne Leser und Agenten; Pflicht laut Projekteinstellung', () => {
    expect(reviewOptsOf(detail(true)).reviewers.map((r) => r.label)).toEqual(['Petra Lenz', 'Max Keller']);
    expect(reviewOptsOf(detail(true)).required).toBe(true);
  });
  it('fragt nach dem Prüfer und schickt ihn mit; Abbruch verschiebt nicht', async () => {
    const form = vi.fn().mockResolvedValueOnce({ reviewer: 'u2' }).mockResolvedValueOnce(null);
    expect(await moveTaskTo(form, 't1', { id: 'c4', kind: 'review' }, 0, reviewOptsOf(detail(true)))).toBe(true);
    const field = form.mock.calls[0][0].fields[0];
    expect(field).toMatchObject({ key: 'reviewer', type: 'select', required: true });
    expect(field.options.some((o: { value: string }) => o.value === '')).toBe(false);
    expect(post).toHaveBeenCalledWith('/tasks/t1/move', { columnId: 'c4', index: 0, review: { reviewerUserId: 'u2' } });
    expect(await moveTaskTo(form, 't1', { id: 'c4', kind: 'review' }, null, reviewOptsOf(detail(false)))).toBe(false);
    expect(form.mock.calls[1][0].fields[0].options[0]).toMatchObject({ value: '' });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('andere Spalten: kein Dialog', async () => {
    const form = vi.fn();
    await moveTaskTo(form, 't1', { id: 'c2', kind: 'active' }, null, reviewOptsOf(detail(true)));
    expect(form).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('/tasks/t1/move', { columnId: 'c2', index: null });
  });
});

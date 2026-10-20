import { describe, expect, it } from 'vitest';
import type { Question } from '@projekttool/shared';
import { openProjectIds } from './useOpenForMe';

describe('Offen für dich: Zählung', () => {
  it('ein Eintrag je Zeile der Liste, Sammelzeilen zählen einmal', () => {
    const q = [{ projectId: 'a' }, { projectId: 'b' }] as Question[];
    const ids = openProjectIds(q, { drafts: [{ projectId: 'a', projectKey: 'A', count: 3 }], proposals: [{ projectId: 'b', projectKey: 'B', count: 2 }], pagesInReview: [], tasks: [{ id: 't', number: 1, title: 'x', projectId: 'a', projectKey: 'A', blocked: true, escalationLevel: 0 }], mailSuggestions: [] });
    expect(ids.sort()).toEqual(['a', 'a', 'a', 'b', 'b']);
  });
});

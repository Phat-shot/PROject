import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { projectPolicy } from './useProjectPolicy';

describe('useProjectPolicy', () => {
  it('bündelt die Abweichungen des persönlichen Projekts', () => {
    const p = projectPolicy({ personal: true });
    const n = projectPolicy({ personal: false });
    expect(p.badge).toEqual({ text: 'persönlich', title: 'Nur du und KI-Agenten' });
    expect(n.badge).toBeNull();
    expect(p.members).toMatchObject({ onlyOwnerAndAgents: true, groups: false, invitations: false });
    expect(n.members).toMatchObject({ onlyOwnerAndAgents: false, groups: true, invitations: true, notice: null });
    expect(p.scaffold.template).toBe(false);
    expect(n.scaffold).toMatchObject({ template: true, hint: null, title: 'Neues Projekt' });
    expect(projectPolicy({}).personal).toBe(false);
  });

  it('statisch: „.personal“ wird nur in useProjectPolicy.ts ausgewertet', () => {
    const root = path.resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d)) { const f = path.join(d, e); if (statSync(f).isDirectory()) walk(f); else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(f); } };
    walk(root);
    const bad = files.filter((f) => !f.endsWith('lib/useProjectPolicy.ts') && /\.personal\b(?![\w'])/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
    expect(bad).toEqual([]);
  });
});

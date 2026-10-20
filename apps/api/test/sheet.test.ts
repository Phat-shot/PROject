import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SHEET, CHAT_RULES, MAIL_RULES, PROJECT_RULES, TASK_RULES } from '../src/ai/sheet.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('docs/KI-Sheet.md enthält Sheet und Regeln wörtlich wie im Code', async () => {
  const md = await readFile(path.resolve(here, '..', '..', '..', 'docs', 'KI-Sheet.md'), 'utf8');
  for (const [name, text] of [['AGENT_SHEET', AGENT_SHEET], ['TASK_RULES', TASK_RULES], ['CHAT_RULES', CHAT_RULES], ['MAIL_RULES', MAIL_RULES], ['PROJECT_RULES', PROJECT_RULES]] as const) {
    assert.ok(md.includes('```text\n' + text + '\n```'), `${name} weicht in docs/KI-Sheet.md ab`);
  }
});

test('Sheet bleibt kompakt und frei von veränderlichen Teilen (Prefix-Cache)', () => {
  assert.ok(AGENT_SHEET.length < 4600, 'Sheet unter 4600 Zeichen (~1.200 Token)');
  for (const t of [AGENT_SHEET, TASK_RULES, CHAT_RULES, MAIL_RULES, PROJECT_RULES]) assert.doesNotMatch(t, /\$\{/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, registerAiCallLog, type AiCallEnd, type AiConfig } from '../src/ai/client.js';

const cfg = (x: Partial<AiConfig> = {}): AiConfig => ({ profileId: 'p1', name: 'Lokal', provider: 'local', apiKey: null, model: 'qwen', baseUrl: 'http://llm/v1', ...x });
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const delta = (d: Record<string, string>, finish: string | null = null) => ({ model: 'qwen-9b', choices: [{ delta: d, finish_reason: finish }] });

test('Lokal gestreamt: Denken (reasoning_content) getrennt, Inhalt zusammengesetzt, Token aus usage, Log mit Dauer', async () => {
  const ends: AiCallEnd[] = [];
  registerAiCallLog({ start: async () => 'c1', finish: async (_id, e) => { ends.push(e); } });
  let body: any;
  const r = await complete(cfg(), (async (_u: string, init: any) => { body = JSON.parse(init.body); return sse([delta({ reasoning_content: 'Ich überlege …' }), delta({ content: '{"a":' }), delta({ content: '1}' }, 'stop'), { choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } }]); }) as any, { system: 's', prompt: 'p', maxTokens: 500, meta: { feature: 'test' } });
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.inputTokens, 120); assert.equal(r.outputTokens, 40); assert.equal(r.model, 'qwen-9b');
  assert.equal(body.stream, true); assert.equal(body.max_tokens, 8500, 'Denkreserve über dem angefragten Limit');
  assert.equal(ends[0].status, 'ok'); assert.equal(ends[0].reasoningChars, 'Ich überlege …'.length);
  registerAiCallLog(null);
});

test('Denken im Inhalt (<think>) wird abgetrennt; leere Antwort nach dem Denken: zweiter Versuch ohne Denkmodus', async () => {
  const bodies: any[] = [];
  const r = await complete(cfg(), (async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? sse([delta({ content: '<think>lange Überlegung ohne Ende' }, 'length')]) : sse([delta({ content: '<think>kurz</think>\n{"ok":true}' }, 'stop')]);
  }) as any, { system: 's', prompt: 'p', maxTokens: 300 });
  assert.equal(r.text, '{"ok":true}');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].chat_template_kwargs, { enable_thinking: false }); assert.equal(bodies[1].max_tokens, 300);
});

test('Kontextfenster begrenzt das Antwortlimit; ohne Streaming geht auch eine JSON-Antwort; Denkmodus aus: keine Reserve', async () => {
  let body: any;
  const json = async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: 'bereit' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } }); };
  assert.equal((await complete(cfg({ contextTokens: 8000 }), json as any, { system: 's', prompt: 'x'.repeat(7000), maxTokens: 500 })).text, 'bereit');
  assert.ok(body.max_tokens <= 8000 - 2000 - 512, `begrenzt: ${body.max_tokens}`);
  await complete(cfg({ enableThinking: false }), json as any, { system: 's', prompt: 'p', maxTokens: 500 });
  assert.equal(body.max_tokens, 500);
});

test('Zeitlimit: Abbruch mit klarer Meldung, im Log als timeout', async () => {
  const ends: AiCallEnd[] = [];
  registerAiCallLog({ start: async () => 'c2', finish: async (_id, e) => { ends.push(e); } });
  const slow = (_u: string, init: any) => new Promise<Response>((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(complete(cfg({ timeoutS: 0.05 }), slow as any, { system: 's', prompt: 'p' }), /keine Antwort innerhalb von 0.05 s/);
  assert.equal(ends[0].status, 'timeout');
  registerAiCallLog(null);
});

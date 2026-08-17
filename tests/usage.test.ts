import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectUsage } from '../src/usage/collect.js';
import { estimateCost, priceFor } from '../src/usage/pricing.js';

function tokenTotal(t: { input: number; output: number; cacheWrite: number; cacheRead: number }): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}

function write(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('collectUsage parses Claude Code, Codex, and Gemini local logs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-usage-'));

  // Claude Code: assistant lines with message.usage; a <synthetic> turn is ignored,
  // and a duplicate (same message id + requestId) is counted once.
  write(path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'), [
    { type: 'assistant', requestId: 'r1', sessionId: 's1', timestamp: '2026-08-16T10:00:00.000Z',
      message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 200 } } },
    { type: 'assistant', requestId: 'r1', sessionId: 's1', timestamp: '2026-08-16T10:00:00.000Z',
      message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 200 } } },
    { type: 'assistant', sessionId: 's1', timestamp: '2026-08-16T10:01:00.000Z',
      message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 5, output_tokens: 5 } } },
    { type: 'user', message: { role: 'user' } },
  ]);

  // Codex: turn_context sets the model; token_count.last_token_usage is the per-turn delta.
  write(path.join(home, '.codex', 'sessions', '2026', 'rollout-x.jsonl'), [
    { timestamp: '2026-08-16T11:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.6', cwd: '/x' } },
    { timestamp: '2026-08-16T11:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 1020 } } } },
  ]);

  // Gemini: model turns carry a tokens object; input includes cached, thoughts are output.
  write(path.join(home, '.gemini', 'tmp', 'proj', 'chats', 'session-a.jsonl'), [
    { id: 'g1', type: 'gemini', timestamp: '2026-08-16T12:00:00.000Z', model: 'gemini-3-flash-preview',
      tokens: { input: 500, output: 30, cached: 100, thoughts: 10, tool: 0, total: 540 } },
  ]);

  const report = collectUsage(home);
  const byId = Object.fromEntries(report.providers.map((p) => [p.provider, p]));

  const cc = byId['claude-code'];
  assert.equal(cc.available, true);
  assert.equal(cc.messages, 1, 'dedupe + synthetic filter should leave one Claude message');
  assert.equal(tokenTotal(cc.tokens), 100 + 50 + 10 + 200);
  assert.equal(cc.models[0].model, 'claude-opus-4-8');

  const cx = byId['codex'];
  assert.equal(cx.available, true);
  assert.equal(cx.models[0].model, 'gpt-5.6');
  // input_tokens includes cached, so uncached input = 600, cacheRead = 400, output = 25
  assert.equal(cx.tokens.input, 600);
  assert.equal(cx.tokens.cacheRead, 400);
  assert.equal(cx.tokens.output, 25);

  const gm = byId['gemini'];
  assert.equal(gm.available, true);
  assert.equal(gm.tokens.input, 400); // 500 - 100 cached
  assert.equal(gm.tokens.cacheRead, 100);
  assert.equal(gm.tokens.output, 40); // 30 + 10 thoughts

  // Providers without a local token log are surfaced but marked unavailable.
  assert.equal(byId['copilot'].available, false);
  assert.ok(byId['copilot'].note);
  assert.equal(byId['cursor'].available, false);
});

test('pricing matches by longest model prefix and returns null for unknown models', () => {
  assert.ok(priceFor('claude-opus-4-8')!.output > priceFor('claude-sonnet-4-6')!.output);
  assert.equal(priceFor('some-unlisted-model'), null);
  assert.equal(estimateCost('some-unlisted-model', { input: 10, output: 10, cacheWrite: 0, cacheRead: 0 }), null);
  const cost = estimateCost('claude-opus-4-8', { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 });
  assert.equal(cost, 15);
});

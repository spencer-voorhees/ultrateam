import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntry, parseEntryLine, EntrySchema } from '../src/schema.js';

test('createEntry stamps id, ts, and inferred provider', () => {
  const entry = createEntry({
    project: 'demo',
    branch: 'main',
    agent: { name: 'claude-code', model: 'claude-fable-5' },
    kind: 'session',
    title: 'Did a thing',
    summary: 'Implemented the thing end to end.',
  });
  assert.match(entry.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(!Number.isNaN(Date.parse(entry.ts)));
  assert.equal(entry.agent.provider, 'anthropic');
  assert.deepEqual(entry.files, []);
});

test('provider inference prefers model over agent default', () => {
  const entry = createEntry({
    project: 'demo',
    agent: { name: 'copilot', model: 'gpt-5.2-codex' },
    title: 'Copilot on an OpenAI model',
    summary: 'x',
  });
  assert.equal(entry.agent.provider, 'openai');
});

test('provider inference handles gemini and codex', () => {
  const geminiEntry = createEntry({
    project: 'demo',
    agent: { name: 'gemini', model: 'gemini-2.5-pro' },
    title: 'Gemini session',
    summary: 'x',
  });
  assert.equal(geminiEntry.agent.provider, 'google');

  const antigravityEntry = createEntry({
    project: 'demo',
    agent: { name: 'antigravity' },
    title: 'Antigravity session',
    summary: 'x',
  });
  assert.equal(antigravityEntry.agent.provider, 'google');

  const codexEntry = createEntry({
    project: 'demo',
    agent: { name: 'codex' },
    title: 'Codex session',
    summary: 'x',
  });
  assert.equal(codexEntry.agent.provider, 'openai');
});

test('createEntry canonicalizes explicit agent names', () => {
  const entry = createEntry({
    project: 'demo',
    agent: { name: 'Codex', model: 'gpt-5.6-sol' },
    title: 'Canonical identity',
    summary: 'x',
  });
  assert.equal(entry.agent.name, 'codex');
  assert.equal(entry.agent.provider, 'openai');
});

test('explicit provider is not overwritten', () => {
  const entry = createEntry({
    project: 'demo',
    agent: { name: 'custom-agent', model: 'weird-model', provider: 'acme' },
    title: 't',
    summary: 's',
  });
  assert.equal(entry.agent.provider, 'acme');
});

test('rejects empty title', () => {
  assert.throws(() =>
    createEntry({
      project: 'demo',
      agent: { name: 'human' },
      title: '',
      summary: 'x',
    }),
  );
});

test('parseEntryLine round-trips and rejects garbage', () => {
  const entry = createEntry({
    project: 'demo',
    agent: { name: 'human' },
    title: 'Round trip',
    summary: 'x',
    open_threads: ['finish tests'],
  });
  const parsed = parseEntryLine(JSON.stringify(entry));
  assert.deepEqual(parsed, entry);
  assert.equal(parseEntryLine('not json'), null);
  assert.equal(parseEntryLine('{"id":"nope"}'), null);
});

test('schema defaults arrays and branch', () => {
  const parsed = EntrySchema.parse({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: new Date().toISOString(),
    project: 'demo',
    agent: { name: 'human' },
    title: 't',
    summary: 's',
  });
  assert.equal(parsed.branch, null);
  assert.equal(parsed.kind, 'session');
  assert.deepEqual(parsed.tags, []);
  assert.equal(parsed.resume, null);
});

test('resume capsule round-trips through the entry schema', () => {
  const entry = createEntry({
    project: 'demo',
    agent: { name: 'codex' },
    kind: 'handoff',
    title: 'Resume this work',
    summary: 'Implemented the first slice.',
    resume: {
      objective: 'Ship agent-agnostic session resume',
      completed: ['Added a portable schema'],
      next_steps: ['Expose the resume tool'],
      blockers: [],
      verification: ['Schema tests pass'],
      commands: ['npm test'],
      git: { branch: 'feature/resume', head: 'abc123', dirty: true, changed_files: ['src/schema.ts'] },
    },
  });
  assert.deepEqual(parseEntryLine(JSON.stringify(entry)), entry);
  assert.equal(entry.resume?.objective, 'Ship agent-agnostic session resume');
});

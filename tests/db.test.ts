import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEntry, type Entry } from '../src/schema.js';
import { appendEntry } from '../src/store/jsonl.js';
import { Index } from '../src/store/db.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-db-'));
}

function tempIndex(): Index {
  return new Index(path.join(tempDir(), 'index.db'));
}

function makeEntry(overrides: Partial<Parameters<typeof createEntry>[0]> = {}): Entry {
  return createEntry({
    project: 'demo',
    branch: 'main',
    agent: { name: 'claude-code', model: 'claude-fable-5' },
    title: 'Generic work',
    summary: 'Did some generic work.',
    ...overrides,
  });
}

test('upsert is idempotent by id', () => {
  const index = tempIndex();
  const entry = makeEntry();
  index.upsert(entry, '/proj');
  index.upsert(entry, '/proj');
  assert.equal(index.list().length, 1);
  index.close();
});

test('recall ranks query matches above unrelated entries', () => {
  const index = tempIndex();
  index.upsert(
    makeEntry({
      title: 'Moved session auth to middleware',
      summary: 'Refactored the auth flow; JWT now validated in middleware.',
      files: ['src/auth/middleware.ts'],
      tags: ['auth'],
    }),
    '/proj',
  );
  index.upsert(
    makeEntry({ title: 'Tweaked README badges', summary: 'Cosmetic docs change.' }),
    '/proj',
  );
  const results = index.recall({ query: 'auth refactor middleware' });
  assert.ok(results.length >= 1);
  assert.match(results[0].entry.title, /auth/i);
  index.close();
});

test('file overlap boosts otherwise-equal entries', () => {
  const index = tempIndex();
  const touching = makeEntry({
    title: 'Edited the login route',
    summary: 'Work on login.',
    files: ['src/routes/login.ts'],
  });
  const other = makeEntry({
    title: 'Edited the signup route',
    summary: 'Work on signup.',
    files: ['src/routes/signup.ts'],
  });
  index.upsert(touching, '/proj');
  index.upsert(other, '/proj');
  const results = index.recall({ files: ['src/routes/login.ts'], limit: 2 });
  assert.equal(results[0].entry.id, touching.id);
  assert.ok(results[0].score > results[1].score);
  index.close();
});

test('projectPath filter isolates projects; all-projects search crosses them', () => {
  const index = tempIndex();
  index.upsert(makeEntry({ project: 'alpha', title: 'Alpha work', summary: 'alpha things' }), '/alpha');
  index.upsert(makeEntry({ project: 'beta', title: 'Beta work', summary: 'beta things' }), '/beta');
  const scoped = index.recall({ projectPath: '/alpha' });
  assert.ok(scoped.every((r) => r.projectPath === '/alpha'));
  const all = index.recall({});
  assert.equal(all.length, 2);
  index.close();
});

test('since filter excludes older entries', () => {
  const index = tempIndex();
  const entry = makeEntry();
  index.upsert(entry, '/proj');
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(index.recall({ since: future }).length, 0);
  assert.equal(index.recall({ since: new Date(0).toISOString() }).length, 1);
  index.close();
});

test('handoff entries get a resume boost over plain sessions', () => {
  const index = tempIndex();
  const session = makeEntry({ title: 'Session note', summary: 'same text here' });
  const handoff = makeEntry({
    kind: 'handoff',
    title: 'Handoff note',
    summary: 'same text here',
    open_threads: ['finish it'],
  });
  index.upsert(session, '/proj');
  index.upsert(handoff, '/proj');
  const results = index.recall({ limit: 2 });
  assert.equal(results[0].entry.id, handoff.id);
  index.close();
});

test('indexProject mirrors JSONL truth, replacing stale rows', () => {
  const index = tempIndex();
  const root = tempDir();
  const kept = makeEntry({ title: 'Kept entry', summary: 'stays' });
  appendEntry(root, kept);
  // simulate a stale row that no longer exists in JSONL
  index.upsert(makeEntry({ title: 'Stale entry', summary: 'gone from jsonl' }), root);
  const { indexed, skipped } = index.indexProject(root);
  assert.equal(indexed, 1);
  assert.equal(skipped, 0);
  const listed = index.list({ projectPath: root });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].entry.id, kept.id);
  index.close();
});

test('get returns a stored entry with its project path', () => {
  const index = tempIndex();
  const entry = makeEntry();
  index.upsert(entry, '/proj');
  const found = index.get(entry.id);
  assert.ok(found);
  assert.equal(found.projectPath, '/proj');
  assert.deepEqual(found.entry, entry);
  assert.equal(index.get('01ARZ3NDEKTSV4RRFFQ69G5FAV'), null);
  index.close();
});

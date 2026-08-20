import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEntry } from '../src/schema.js';
import {
  appendEntry,
  readEntries,
  migrateStoreTo,
  findProjectRoot,
  entriesPath,
  isUltrateamInstallDirectory,
  STORE_DIR,
} from '../src/store/jsonl.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-test-'));
}

function makeEntry(title: string) {
  return createEntry({
    project: 'demo',
    agent: { name: 'claude-code', model: 'claude-fable-5' },
    title,
    summary: `Summary for ${title}.`,
    files: ['src/a.ts'],
  });
}

test('append and read round-trip', () => {
  const root = tempDir();
  const first = makeEntry('First');
  const second = makeEntry('Second');
  appendEntry(root, first);
  appendEntry(root, second);
  const { entries, skipped } = readEntries(root);
  assert.equal(skipped, 0);
  assert.deepEqual(entries, [first, second]);
});

test('corrupt lines are skipped and counted', () => {
  const root = tempDir();
  appendEntry(root, makeEntry('Good'));
  fs.appendFileSync(entriesPath(root), 'THIS IS NOT JSON\n{"partial": true}\n');
  appendEntry(root, makeEntry('Also good'));
  const { entries, skipped } = readEntries(root);
  assert.equal(entries.length, 2);
  assert.equal(skipped, 2);
});

test('readEntries on a fresh project returns empty', () => {
  const { entries, skipped } = readEntries(tempDir());
  assert.deepEqual(entries, []);
  assert.equal(skipped, 0);
});

test('findProjectRoot finds .ultrateam upward from nested dirs', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, STORE_DIR));
  const nested = path.join(root, 'src', 'deep', 'deeper');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findProjectRoot(nested), root);
});

test('findProjectRoot falls back to git root', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, '.git'));
  const nested = path.join(root, 'src');
  fs.mkdirSync(nested);
  assert.equal(findProjectRoot(nested), root);
});

test('findProjectRoot prefers .ultrateam over an outer git root', () => {
  const outer = tempDir();
  fs.mkdirSync(path.join(outer, '.git'));
  const inner = path.join(outer, 'packages', 'app');
  fs.mkdirSync(path.join(inner, STORE_DIR), { recursive: true });
  assert.equal(findProjectRoot(inner), inner);
});

test('the ultrateam installation checkout is never a project root', () => {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-app-root-'));
  fs.mkdirSync(path.join(install, '.git'));
  fs.mkdirSync(path.join(install, STORE_DIR));
  const previous = process.env.ULTRATEAM_HOME;
  process.env.ULTRATEAM_HOME = install;
  try {
    assert.equal(isUltrateamInstallDirectory(install), true);
    assert.equal(findProjectRoot(install), null);
    assert.throws(() => appendEntry(install, makeEntry('Blocked')), /installation directory/);
  } finally {
    if (previous === undefined) delete process.env.ULTRATEAM_HOME;
    else process.env.ULTRATEAM_HOME = previous;
  }
});

test('migrateStoreTo folds a throwaway store into the durable home once', () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-migrate-from-'));
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-migrate-to-'));
  const a = createEntry({ project: 'wt', agent: { name: 'claude-code' }, title: 'A', summary: 's' });
  const b = createEntry({ project: 'wt', agent: { name: 'claude-code' }, title: 'B', summary: 's' });
  appendEntry(from, a);
  appendEntry(from, b);
  appendEntry(to, a); // already known at the destination — must not duplicate

  assert.equal(migrateStoreTo(from, to), 2);
  const target = readEntries(to);
  assert.deepEqual(target.entries.map((e) => e.id).sort(), [a.id, b.id].sort());
  assert.equal(target.entries.length, 2);
  // Clean migration removes the source store entirely.
  assert.equal(fs.existsSync(path.join(from, '.ultrateam')), false);

  // Same directory (even via differing path spellings) is a strict no-op.
  appendEntry(from, a);
  assert.equal(migrateStoreTo(from, path.join(from, '.', '.')), 0);
  assert.equal(fs.existsSync(path.join(from, '.ultrateam')), true);
});

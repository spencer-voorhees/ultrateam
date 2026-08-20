import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeGitRemote, rootsInWorkspace, workspaceIdentity } from '../src/workspace.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-workspace-'));
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

test('normalizes common remote URL forms to one repository identity', () => {
  const root = tempDir();
  const expected = 'github.com/acme/widgets';
  assert.equal(normalizeGitRemote('https://github.com/acme/widgets.git', root), expected);
  assert.equal(normalizeGitRemote('ssh://git@github.com/acme/widgets.git', root), expected);
  assert.equal(normalizeGitRemote('git@github.com:acme/widgets.git', root), expected);
});

test('independent clones with the same remote share a workspace id', () => {
  const rootA = tempDir();
  const rootB = tempDir();
  for (const root of [rootA, rootB]) git(root, ['init']);
  git(rootA, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  git(rootB, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);

  const a = workspaceIdentity(rootA);
  const b = workspaceIdentity(rootB);
  assert.equal(a.source, 'remote');
  assert.equal(b.source, 'remote');
  assert.equal(a.id, b.id);
  assert.deepEqual(rootsInWorkspace(rootA, [rootB]), [rootA, rootB].sort());
});

test('a local clone resolves through its path remote to the parent workspace', () => {
  const parent = tempDir();
  git(parent, ['init']);
  git(parent, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  git(parent, ['commit', '--allow-empty', '-m', 'x']);
  // Agent apps clone the repo locally under a random name; origin is the
  // parent's PATH, which must resolve through to the parent's own identity.
  const cloneDir = path.join(tempDir(), 'wt-abc123');
  execFileSync('git', ['clone', '-q', parent, cloneDir], { stdio: 'ignore' });

  const clone = workspaceIdentity(cloneDir);
  assert.equal(clone.id, workspaceIdentity(parent).id);
  assert.equal(clone.source, 'remote');
});

test('a git worktree shares its parent repository workspace', () => {
  const parent = tempDir();
  git(parent, ['init']);
  git(parent, ['commit', '--allow-empty', '-m', 'x']);
  git(parent, ['worktree', 'add', '-q', path.join(parent, 'wt-random')]);
  assert.equal(workspaceIdentity(path.join(parent, 'wt-random')).id, workspaceIdentity(parent).id);
});

test('unrelated local repositories stay separate unless explicitly linked', () => {
  const rootA = tempDir();
  const rootB = tempDir();
  for (const root of [rootA, rootB]) git(root, ['init']);
  assert.notEqual(workspaceIdentity(rootA).id, workspaceIdentity(rootB).id);

  for (const root of [rootA, rootB]) git(root, ['config', 'ultrateam.workspaceId', 'shared-local-work']);
  assert.equal(workspaceIdentity(rootA).id, workspaceIdentity(rootB).id);
  assert.equal(workspaceIdentity(rootA).source, 'explicit');
});

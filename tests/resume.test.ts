import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEntry } from '../src/schema.js';
import { createResumeState, resumableState } from '../src/resume.js';

test('createResumeState captures portable Git state and structured progress', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-resume-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n');

  const resume = createResumeState(root, {
    title: 'Fallback objective',
    summary: 'Fallback completion',
    objective: 'Finish portable resume',
    completed: ['Created schema'],
    next_steps: ['Add MCP tool'],
    blockers: ['None'],
    verification: ['Unit tests'],
    commands: ['npm test'],
  });

  assert.equal(resume.objective, 'Finish portable resume');
  assert.deepEqual(resume.completed, ['Created schema']);
  assert.equal(resume.git?.branch, 'main');
  assert.equal(resume.git?.dirty, true);
  assert.deepEqual(resume.git?.changed_files, ['tracked.txt']);
  assert.match(resume.git?.head ?? '', /^[0-9a-f]{40}$/);
});

test('legacy handoffs synthesize the portable resume contract', () => {
  const entry = createEntry({
    project: 'demo',
    agent: { name: 'human' },
    kind: 'handoff',
    title: 'Legacy objective',
    summary: 'Old prose briefing',
    open_threads: ['Finish tests'],
  });
  assert.deepEqual(resumableState(entry), {
    version: 1,
    objective: 'Legacy objective',
    completed: ['Old prose briefing'],
    next_steps: ['Finish tests'],
    blockers: [],
    verification: [],
    commands: [],
  });
});

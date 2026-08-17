import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEntry, type Entry } from '../src/schema.js';
import { appendEntry } from '../src/store/jsonl.js';
import { Index } from '../src/store/db.js';
import { knownRoots } from '../src/store/roots.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-db-'));
}

function tempIndex(): Index {
  const dir = tempDir();
  return new Index(path.join(dir, 'index.db'), path.join(dir, 'projects.json'));
}

function initGitRoot(remote?: string): string {
  const root = tempDir();
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root, stdio: 'ignore' });
  return root;
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

test('recall matches prefixes while the user is typing', () => {
  const index = tempIndex();
  const matching = makeEntry({ title: 'Authentication middleware', summary: 'Secured the route.' });
  index.upsert(matching, '/proj');
  index.upsert(makeEntry({ title: 'Documentation cleanup', summary: 'Updated examples.' }), '/proj');
  const results = index.recall({ query: 'authent' });
  assert.equal(results[0]?.entry.id, matching.id);
  index.close();
});

test('recall treats the workspace name as searchable entry context', () => {
  const index = tempIndex();
  const matching = makeEntry({ project: 'ultrateam', title: 'Unrelated title', summary: 'No repeated project name.' });
  index.upsert(matching, '/proj');
  const results = index.recall({ query: 'ultrateam' });
  assert.equal(results[0]?.entry.id, matching.id);
  index.close();
});

test('recall tolerates one typo when strict search has no matches', () => {
  const index = tempIndex();
  const matching = makeEntry({ title: 'Authentication middleware', summary: 'Secured the route.' });
  index.upsert(matching, '/proj');
  const results = index.recall({ query: 'authentcation' });
  assert.equal(results[0]?.entry.id, matching.id);
  index.close();
});

test('recall ranks a title phrase above an incidental body match', () => {
  const index = tempIndex();
  const titleMatch = makeEntry({ title: 'Workspace identity', summary: 'Unified repository clones.' });
  const bodyMatch = makeEntry({ title: 'General cleanup', summary: 'Touched workspace identity in passing.' });
  index.upsert(bodyMatch, '/proj');
  index.upsert(titleMatch, '/proj');
  const results = index.recall({ query: 'workspace identity', limit: 2 });
  assert.equal(results[0]?.entry.id, titleMatch.id);
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

test('indexProject prunes a previously registered installation workspace', () => {
  const dir = tempDir();
  const rootsPath = path.join(dir, 'projects.json');
  const index = new Index(path.join(dir, 'index.db'), rootsPath);
  const install = tempDir();
  index.upsert(makeEntry({ project: '.ultrateam-app' }), install);
  assert.ok(knownRoots(rootsPath).includes(install));

  const previous = process.env.ULTRATEAM_HOME;
  process.env.ULTRATEAM_HOME = install;
  try {
    assert.deepEqual(index.indexProject(install), { indexed: 0, skipped: 0 });
    assert.equal(index.list({ projectPath: install }).length, 0);
    assert.ok(!knownRoots(rootsPath).includes(install));
  } finally {
    if (previous === undefined) delete process.env.ULTRATEAM_HOME;
    else process.env.ULTRATEAM_HOME = previous;
    index.close();
  }
});

test('scoped recall is not starved by a busier sibling project', () => {
  const index = tempIndex();
  index.upsert(
    makeEntry({ project: 'alpha', title: 'Alpha auth work', summary: 'auth things in alpha' }),
    '/alpha',
  );
  // More sibling entries than the whole candidate pool, all newer.
  for (let i = 0; i < 210; i++) {
    index.upsert(makeEntry({ project: 'beta', title: `Beta task ${i}`, summary: 'beta work' }), '/beta');
  }
  const noQuery = index.recall({ projectPath: '/alpha' });
  assert.equal(noQuery.length, 1);
  assert.equal(noQuery[0].projectPath, '/alpha');
  const withQuery = index.recall({ query: 'alpha auth', projectPath: '/alpha' });
  assert.equal(withQuery.length, 1);
  index.close();
});

test('symbols-only query returns nothing instead of a recency dump', () => {
  const index = tempIndex();
  index.upsert(makeEntry({ title: 'Recent unrelated work', summary: 'stuff' }), '/proj');
  assert.deepEqual(index.recall({ query: '???' }), []);
  assert.deepEqual(index.recall({ query: '++ ~~' }), []);
  index.close();
});

test('unicode queries are searchable', () => {
  const index = tempIndex();
  index.upsert(makeEntry({ title: '認証 flow moved to middleware', summary: 'auth in Japanese' }), '/proj');
  index.upsert(makeEntry({ title: 'Unrelated docs tweak', summary: 'docs' }), '/proj');
  const results = index.recall({ query: '認証' });
  assert.ok(results.length >= 1);
  assert.match(results[0].entry.title, /認証/);
  index.close();
});

test('file overlap requires a path-segment boundary', () => {
  const index = tempIndex();
  const real = makeEntry({ title: 'Login route work', summary: 'same words here', files: ['src/routes/login.ts'] });
  const suffix = makeEntry({ title: 'Xlogin experiment', summary: 'same words here', files: ['xlogin.ts'] });
  index.upsert(real, '/proj');
  index.upsert(suffix, '/proj');
  const results = index.recall({ files: ['login.ts'], limit: 2 });
  assert.equal(results[0].entry.id, real.id);
  assert.ok(results[0].score > results[1].score);
  index.close();
});

test('shared entries indexed from two checkouts keep both rows and dedup results', () => {
  const index = tempIndex();
  const rootA = tempDir();
  const rootB = tempDir();
  const entry = makeEntry({ title: 'Committed shared entry', summary: 'travels with the repo' });
  appendEntry(rootA, entry);
  appendEntry(rootB, entry);
  index.indexProject(rootA);
  index.indexProject(rootB);
  // Neither checkout steals the other's row.
  assert.equal(index.list({ projectPath: rootA }).length, 1);
  assert.equal(index.list({ projectPath: rootB }).length, 1);
  assert.deepEqual(index.projectPaths().sort(), [rootA, rootB].sort());
  // But the entry is one piece of history in cross-project views.
  assert.equal(index.recall({}).length, 1);
  assert.equal(index.list({}).length, 1);
  index.close();
});

test('separate clones of one remote unify into a single scoped workspace', () => {
  const index = tempIndex();
  const rootA = initGitRoot('git@github.com:acme/widgets.git');
  const rootB = initGitRoot('https://github.com/acme/widgets.git');
  appendEntry(rootA, makeEntry({ title: 'Work from clone A', summary: 'alpha' }));
  appendEntry(rootB, makeEntry({ title: 'Work from clone B', summary: 'beta' }));
  index.indexProject(rootA);
  index.indexProject(rootB);

  const projects = index.projectSummaries();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].count, 2);
  assert.deepEqual(projects[0].roots, [rootA, rootB].sort());
  assert.equal(index.list({ projectPath: rootA }).length, 2);
  assert.equal(index.list({ projectPath: rootB }).length, 2);
  assert.equal(index.stats(rootA).entries, 2);
  assert.equal(index.agentSummaries(rootA)[0].count, 2);
  index.close();
});

test('indexed roots are registered outside the disposable index', () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'index.db');
  const rootsPath = path.join(dir, 'projects.json');
  const root = tempDir();
  appendEntry(root, makeEntry());
  const index = new Index(dbPath, rootsPath);
  index.indexProject(root);
  index.close();
  assert.ok(knownRoots(rootsPath).includes(path.resolve(root)));
  // Simulate a deleted index: the registry alone must still know the root.
  fs.rmSync(dbPath, { force: true });
  assert.ok(knownRoots(rootsPath).includes(path.resolve(root)));
});

test('an older disposable index is rebuilt with workspace identity', () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'index.db');
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE entries (id TEXT); PRAGMA user_version = 1;');
  old.close();

  const index = new Index(dbPath, path.join(dir, 'projects.json'));
  const columns = index.db.prepare('PRAGMA table_info(entries)').all() as unknown as Array<{ name: string }>;
  const version = index.db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.ok(columns.some((column) => column.name === 'workspace_id'));
  assert.equal(version.user_version, 3);
  index.close();
});

test('invalid limit falls back to the default instead of returning nothing', () => {
  const index = tempIndex();
  for (let i = 0; i < 3; i++) index.upsert(makeEntry({ title: `Entry ${i}`, summary: 'x' }), '/proj');
  assert.equal(index.recall({ limit: Number.NaN }).length, 3);
  assert.equal(index.recall({ limit: -1 }).length, 3);
  assert.equal(index.list({ limit: Number.NaN }).length, 3);
  index.close();
});

test('agentSummaries keeps comma-bearing model ids intact', () => {
  const index = tempIndex();
  index.upsert(makeEntry({ agent: { name: 'weird', model: 'llama-3, fine-tuned' } }), '/proj');
  index.upsert(makeEntry({ agent: { name: 'weird', model: 'plain-model' } }), '/proj');
  const weird = index.agentSummaries().find((a) => a.name === 'weird');
  assert.ok(weird);
  assert.deepEqual(weird.models.sort(), ['llama-3, fine-tuned', 'plain-model']);
  index.close();
});

test('legacy case variants share one canonical agent identity', () => {
  const index = tempIndex();
  const first = makeEntry({ agent: { name: 'codex', model: 'gpt-5.6-sol' } });
  const second = makeEntry({ agent: { name: 'Codex', model: 'gpt-5.6-sol' } });
  index.upsert(first, '/proj');
  index.upsert(second, '/proj');

  // Simulate a row written before agent identities were canonicalized.
  index.db.prepare(`UPDATE entries SET agent_name = 'Codex' WHERE id = ?`).run(second.id);

  const summaries = index.agentSummaries();
  assert.equal(summaries.filter((agent) => agent.name === 'codex').length, 1);
  assert.equal(summaries.find((agent) => agent.name === 'codex')?.count, 2);
  assert.deepEqual(index.list().map((result) => result.entry.agent.name), ['codex', 'codex']);
  index.close();
});

test('agentSummaries and projectSummaries use latest-wins, not MAX()', () => {
  const index = tempIndex();
  // 'openrouter' > 'anthropic' lexicographically; latest entry is anthropic.
  index.upsert(makeEntry({ agent: { name: 'claude-code', provider: 'openrouter' } }), '/proj');
  index.upsert(makeEntry({ agent: { name: 'claude-code', model: 'claude-fable-5' } }), '/proj');
  const a = index.agentSummaries().find((x) => x.name === 'claude-code');
  assert.equal(a?.provider, 'anthropic');
  assert.equal(a?.count, 2);
  // project renamed: 'zzz-old' > 'demo' lexicographically; latest is demo.
  const other = tempIndex();
  other.upsert(makeEntry({ project: 'zzz-old' }), '/renamed');
  other.upsert(makeEntry({ project: 'demo' }), '/renamed');
  assert.equal(other.projectSummaries()[0].name, 'demo');
  index.close();
  other.close();
});

test('stats reports scope-wide truth with latest-handoff open threads', () => {
  const index = tempIndex();
  index.upsert(
    makeEntry({ kind: 'handoff', title: 'Old handoff', summary: 'x', open_threads: ['a', 'b', 'c'] }),
    '/proj',
  );
  index.upsert(
    makeEntry({ kind: 'handoff', title: 'Latest handoff', summary: 'x', open_threads: ['only one'] }),
    '/proj',
  );
  index.upsert(makeEntry({ title: 'Plain session', summary: 'x' }), '/proj');
  const s = index.stats('/proj');
  assert.equal(s.entries, 3);
  assert.equal(s.handoffs, 2);
  assert.equal(s.openThreads, 1);
  assert.equal(index.stats('/elsewhere').entries, 0);
  index.close();
});

test('recentTs returns scope timestamps since a bound', () => {
  const index = tempIndex();
  index.upsert(makeEntry(), '/proj');
  index.upsert(makeEntry(), '/other');
  assert.equal(index.recentTs('/proj', new Date(0).toISOString()).length, 1);
  assert.equal(index.recentTs(undefined, new Date(0).toISOString()).length, 2);
  assert.equal(index.recentTs('/proj', new Date(Date.now() + 60_000).toISOString()).length, 0);
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

test('latestResume prefers a capsule on the current branch and supports exact ids', () => {
  const index = tempIndex();
  const main = makeEntry({
    branch: 'main',
    kind: 'handoff',
    title: 'Main handoff',
    resume: { objective: 'Continue main' },
  });
  const feature = makeEntry({
    branch: 'feature/resume',
    kind: 'session',
    title: 'Feature checkpoint',
    resume: { objective: 'Continue feature' },
  });
  index.upsert(main, '/proj');
  index.upsert(feature, '/proj');
  assert.equal(index.latestResume({ projectPath: '/proj', branch: 'main' })?.entry.id, main.id);
  assert.equal(index.resumeById(feature.id, { projectPath: '/proj' })?.entry.id, feature.id);
  assert.equal(index.resumeById(feature.id, { projectPath: '/elsewhere' }), null);
  index.close();
});

test('contributions aggregates per agent across all entries, uncapped', () => {
  const index = tempIndex();
  index.upsert(makeEntry({ project: 'alpha', agent: { name: 'cursor', provider: 'anthropic' }, kind: 'note', files: ['a.ts', 'b.ts'], decisions: ['d1'] }), '/alpha');
  index.upsert(makeEntry({ project: 'alpha', agent: { name: 'cursor', provider: 'anthropic' }, kind: 'handoff', files: ['b.ts'], open_threads: ['t1', 't2'] }), '/alpha');
  index.upsert(makeEntry({ project: 'beta', agent: { name: 'codex', provider: 'openai' }, kind: 'session', files: ['x.ts'] }), '/beta');

  const { agents, workspaces } = index.contributions();
  assert.equal(workspaces, 2);
  const byName = Object.fromEntries(agents.map((a) => [a.name, a]));

  assert.equal(byName['cursor'].count, 2);
  assert.equal(byName['cursor'].handoffs, 1);
  assert.equal(byName['cursor'].notes, 1);
  assert.equal(byName['cursor'].files, 2, 'unique files a.ts + b.ts');
  assert.equal(byName['cursor'].decisions, 1);
  assert.equal(byName['cursor'].openThreads, 2);
  assert.equal(byName['cursor'].workspaces, 1);

  assert.equal(byName['codex'].count, 1);
  assert.equal(byName['codex'].checkpoints, 1);
  assert.equal(byName['codex'].workspaces, 1);

  // Scoped to one workspace returns just that workspace's agents.
  const scoped = index.contributions('/alpha');
  assert.equal(scoped.workspaces, 1);
  assert.equal(scoped.agents.length, 1);
  assert.equal(scoped.agents[0].name, 'cursor');
  index.close();
});

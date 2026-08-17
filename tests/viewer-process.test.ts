import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startViewer } from '../src/viewer/server.js';
import { registerRoot } from '../src/store/roots.js';
import { STORE_DIR, appendEntry } from '../src/store/jsonl.js';
import { createEntry } from '../src/schema.js';
import {
  processIsAlive,
  readViewerState,
  removeViewerState,
  runningViewer,
  writeViewerState,
  type ViewerState,
} from '../src/viewer/process.js';

function tempStatePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-viewer-'));
  return path.join(root, 'viewer.json');
}

function state(overrides: Partial<ViewerState> = {}): ViewerState {
  return {
    version: 1,
    instanceId: 'test-viewer',
    pid: process.pid,
    port: 4272,
    url: 'http://127.0.0.1:4272',
    mode: 'background',
    cwd: process.cwd(),
    startedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

test('viewer state is atomic, validated, and only removed by its owner', () => {
  const file = tempStatePath();
  const saved = state();
  writeViewerState(saved, file);
  assert.deepEqual(readViewerState(file), saved);

  removeViewerState('another-viewer', file);
  assert.ok(fs.existsSync(file));
  removeViewerState(saved.instanceId, file);
  assert.equal(readViewerState(file), null);
});

test('runningViewer verifies the process and loopback health identity', async () => {
  const file = tempStatePath();
  const instanceId = 'healthy-viewer';
  const handle = await startViewer({ port: 0, instanceId });
  const saved = state({
    instanceId,
    port: handle.port,
    url: handle.url,
    mode: 'foreground',
  });
  writeViewerState(saved, file);

  assert.deepEqual(await runningViewer(file), saved);
  const health = await fetch(`${handle.url}/api/health`).then((response) => response.json());
  assert.deepEqual(health, { app: 'ultrateam', instanceId, pid: process.pid });

  handle.close();
  removeViewerState(instanceId, file);
});

test('runningViewer clears stale state without signaling an unrelated process', async () => {
  const file = tempStatePath();
  writeViewerState(state({ pid: 2_147_483_647 }), file);
  assert.equal(processIsAlive(2_147_483_647), false);
  assert.equal(await runningViewer(file), null);
  assert.equal(fs.existsSync(file), false);
});

test('viewer /api/state defaults to its launch workspace when it has memory, and supports explicit all', async () => {
  // Isolate HOME so the viewer's index/registry (~/.ultrateam) is a temp dir,
  // not the developer's real global state.
  const previousHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-viewer-scope-'));
  // A populated workspace at the launch directory — the viewer should scope to it.
  appendEntry(root, createEntry({
    project: path.basename(root),
    agent: { name: 'claude-code', model: 'claude-fable-5' },
    title: 'Launch entry',
    summary: 'Gives the launch workspace real memory.',
  }));
  const handle = await startViewer({ port: 0, cwd: root, instanceId: 'scope-test-viewer' });
  try {
    const launchState = await fetch(`${handle.url}/api/state`).then((r) => r.json());
    assert.notEqual(launchState.scope, 'all');
    assert.ok(launchState.projects.some((project: { id: string }) => project.id === launchState.scope));
    assert.ok(Array.isArray(launchState.entries));
    assert.equal(launchState.entries.length, 1);

    const explicitAllState = await fetch(`${handle.url}/api/state?project=all`).then((r) => r.json());
    assert.equal(explicitAllState.scope, 'all');

    const firstProjectId = launchState.projects[0].id;
    const scopedState = await fetch(`${handle.url}/api/state?project=${encodeURIComponent(firstProjectId)}`).then((r) => r.json());
    assert.equal(scopedState.scope, firstProjectId);

    const iconRes = await fetch(`${handle.url}/ultrateam-icon.png`);
    assert.equal(iconRes.status, 200);
    assert.equal(iconRes.headers.get('content-type'), 'image/png');

    const faviconRes = await fetch(`${handle.url}/favicon.ico`);
    assert.equal(faviconRes.status, 200);
    assert.equal(faviconRes.headers.get('content-type'), 'image/png');

    const htmlRes = await fetch(`${handle.url}/`).then((r) => r.text());
    assert.ok(htmlRes.includes('rel="icon" type="image/png" href="/ultrateam-icon.png"'));
  } finally {
    handle.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('viewer supports first launch before any workspace exists', async () => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-empty-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-empty-cwd-'));
  process.env.HOME = home;
  let handle: Awaited<ReturnType<typeof startViewer>> | undefined;
  try {
    handle = await startViewer({ port: 0, cwd, instanceId: 'empty-viewer' });
    const emptyState = await fetch(`${handle.url}/api/state`).then((r) => r.json());
    assert.equal(emptyState.scope, 'all');
    assert.deepEqual(emptyState.projects, []);
    assert.deepEqual(emptyState.entries, []);
    assert.equal(emptyState.stats.entries, 0);

    // A workspace surfaces once it holds real memory.
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-new-workspace-'));
    appendEntry(project, createEntry({
      project: path.basename(project),
      agent: { name: 'claude-code', model: 'claude-fable-5' },
      title: 'First entry',
      summary: 'A workspace exists once it has memory.',
    }));
    registerRoot(project, path.join(home, '.ultrateam', 'projects.json'));
    const initializedState = await fetch(`${handle.url}/api/state`).then((r) => r.json());
    assert.equal(initializedState.projects.length, 1);
    assert.equal(initializedState.projects[0].path, project);
    assert.equal(initializedState.projects[0].name, path.basename(project));
    assert.equal(initializedState.projects[0].count, 1);

    // Merely registering an empty root must NOT surface a workspace — only memory counts.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-empty-ws-'));
    fs.mkdirSync(path.join(empty, STORE_DIR), { recursive: true });
    registerRoot(empty, path.join(home, '.ultrateam', 'projects.json'));
    const afterEmpty = await fetch(`${handle.url}/api/state`).then((r) => r.json());
    assert.ok(!afterEmpty.projects.some((p: { path: string }) => p.path === empty));
    assert.equal(afterEmpty.projects.length, 1);

    const html = await fetch(handle.url).then((r) => r.text());
    assert.ok(html.includes('No workspaces yet'));
    assert.ok(html.includes('ultrateam init'));
    assert.ok(!html.includes('then refresh this page'));
  } finally {
    handle?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('background viewer startup falls back when its preferred port is occupied', async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address === 'object');

  let handle: Awaited<ReturnType<typeof startViewer>> | undefined;
  try {
    handle = await startViewer({ port: address.port, portFallback: true });
    assert.notEqual(handle.port, address.port);
    assert.equal(await fetch(`${handle.url}/api/health`).then((r) => r.status), 200);
  } finally {
    handle?.close();
    blocker.close();
  }
});

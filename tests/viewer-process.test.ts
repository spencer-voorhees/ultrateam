import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startViewer } from '../src/viewer/server.js';
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

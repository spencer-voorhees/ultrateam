import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEntry } from '../src/schema.js';
import { appendEntry } from '../src/store/jsonl.js';
import { startViewer } from '../src/viewer/server.js';

test('workspace prefs: POST persists a folder color and state overlays it', async () => {
  // Isolate HOME so ~/.ultrateam (index, registry, prefs) is a temp dir.
  const previousHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-prefs-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-prefs-ws-'));
  appendEntry(root, createEntry({
    project: path.basename(root),
    agent: { name: 'claude-code', model: 'claude-fable-5' },
    title: 'Entry',
    summary: 'Gives the workspace real memory.',
  }));
  const handle = await startViewer({ port: 0, cwd: root, instanceId: 'prefs-test-viewer' });
  try {
    const before = await fetch(`${handle.url}/api/state?project=all`).then((r) => r.json());
    const id = before.projects[0].id;
    assert.equal(before.projects[0].color, null);
    assert.equal(before.entries[0].workspaceId, id);

    const post = await fetch(`${handle.url}/api/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, color: 'blue' }),
    });
    assert.equal(post.status, 200);

    const after = await fetch(`${handle.url}/api/state?project=all`).then((r) => r.json());
    const project = after.projects.find((p: { id: string }) => p.id === id);
    assert.equal(project.color, 'blue');

    // Prefs survive on disk.
    const file = path.join(process.env.HOME!, '.ultrateam', 'workspace-prefs.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [id]: { color: 'blue' } });

    // Clearing the color drops the workspace from the file.
    const clear = await fetch(`${handle.url}/api/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, color: null }),
    });
    assert.equal(clear.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});

    // Rejected updates: unknown color, missing id, wrong content type.
    const badColor = await fetch(`${handle.url}/api/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, color: 'mauve' }),
    });
    assert.equal(badColor.status, 400);
    const noId = await fetch(`${handle.url}/api/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ color: 'blue' }),
    });
    assert.equal(noId.status, 400);
    const wrongType = await fetch(`${handle.url}/api/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ id, color: 'blue' }),
    });
    assert.equal(wrongType.status, 415);
  } finally {
    handle.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

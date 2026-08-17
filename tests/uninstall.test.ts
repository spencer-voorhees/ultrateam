import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scheduleRemoval, uninstallTargets } from '../src/uninstall.js';

test('uninstall targets only global app state and known command shims', () => {
  const home = path.resolve('/test/home');
  const targets = uninstallTargets({
    home,
    packageRoot: path.join(home, '.ultrateam-app'),
    npmPrefix: path.join(home, 'npm'),
    appData: path.join(home, 'AppData', 'Roaming'),
  });

  assert.ok(targets.includes(path.join(home, '.ultrateam')));
  assert.ok(targets.includes(path.join(home, '.ultrateam-app')));
  assert.ok(targets.includes(path.join(home, 'npm', 'ultrateam.cmd')));
  assert.ok(targets.includes(path.join(home, 'npm', 'node_modules', 'ultrateam')));
  assert.ok(targets.includes(path.join(home, 'AppData', 'Roaming', 'npm', 'ultrateam.ps1')));
  assert.ok(!targets.includes(home));
  assert.ok(!targets.some((target) => target.includes('project')));
});

test('a custom install directory is removed only when it contains this CLI', () => {
  const home = path.resolve('/test/home');
  const custom = path.resolve('/opt/ultrateam-custom');
  assert.ok(uninstallTargets({
    home,
    packageRoot: path.join(custom, 'dist'),
    installHome: custom,
  }).includes(custom));
  assert.ok(!uninstallTargets({
    home,
    packageRoot: path.join(home, 'source-checkout'),
    installHome: custom,
  }).includes(custom));
});

test('detached cleanup removes exact targets after the parent is gone', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-uninstall-test-'));
  const target = path.join(root, 'owned-state');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'state.json'), '{}');

  scheduleRemoval([target], 2_147_483_647);
  const deadline = Date.now() + 3000;
  while (fs.existsSync(target) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(target), false);
});

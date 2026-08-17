import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initGlobal, removeGlobalRegistrations, doctor } from '../src/setup/init.js';
import { canonicalAgentName, normalizeAgentName } from '../src/agents/registry.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-init-'));
}

/** Run `fn` with HOME (and git's global config) pointed at an isolated temp home. */
function withTempHome(fn: (home: string) => void): void {
  const home = tempDir();
  const saved = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig'); // nonexistent → no core.excludesfile
  try {
    fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('initGlobal registers the MCP server at the user level with absolute paths and writes nothing to any project', () => {
  withTempHome((home) => {
    const project = tempDir();
    const cliEntry = '/opt/ultrateam/dist/cli.js';
    initGlobal(cliEntry, { all: true });

    // Claude Code — ~/.claude.json, mcpServers style, absolute node + cli path.
    const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.mcpServers.ultrateam.command, process.execPath);
    assert.deepEqual(claude.mcpServers.ultrateam.args, [cliEntry, 'serve']);

    // Cursor — ~/.cursor/mcp.json.
    const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cursor.mcpServers.ultrateam.command, process.execPath);

    // Gemini — ~/.gemini/settings.json.
    const gemini = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
    assert.deepEqual(gemini.mcpServers.ultrateam.args, [cliEntry, 'serve']);

    // Codex — ~/.codex/config.toml, TOML table with absolute command.
    const codex = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(codex, /\[mcp_servers\.ultrateam\]/);
    assert.ok(codex.includes(JSON.stringify(process.execPath)));

    // Global gitignore excludes the store, so it never lands in any repo.
    const gi = fs.readFileSync(path.join(home, '.config', 'git', 'ignore'), 'utf8');
    assert.ok(gi.split(/\r?\n/).some((l) => l.trim() === '.ultrateam/'));

    // Usage nudge lands in each agent's global instructions where one exists.
    assert.ok(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8').includes('ultrateam shared memory'));
    // Copilot gets a dedicated file under ~/.copilot/instructions.
    assert.ok(fs.readFileSync(path.join(home, '.copilot', 'instructions', 'ultrateam.md'), 'utf8').includes('ultrateam shared memory'));
    // Cursor gets a dedicated .mdc rule with alwaysApply so Agent mode attaches it.
    const cursorRule = fs.readFileSync(path.join(home, '.cursor', 'rules', 'ultrateam.mdc'), 'utf8');
    assert.ok(cursorRule.includes('alwaysApply: true'));
    assert.ok(cursorRule.includes('ultrateam shared memory'));

    // Nothing was written into the project directory.
    assert.deepEqual(fs.readdirSync(project), []);

    // doctor reports the global registrations.
    const doc = doctor(null);
    assert.ok(doc.some((l) => /Claude Code: registered globally/.test(l)));
    assert.ok(doc.some((l) => /Codex: registered globally/.test(l)));
    assert.ok(doc.some((l) => /global gitignore excludes \.ultrateam\//.test(l)));
  });
});

test('initGlobal is idempotent and reversible', () => {
  withTempHome((home) => {
    const cliEntry = '/opt/ultrateam/dist/cli.js';
    initGlobal(cliEntry, { all: true });
    const claudeFirst = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
    const nudgeFirst = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');

    // Re-running does not duplicate anything.
    initGlobal(cliEntry, { all: true });
    assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), claudeFirst);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), nudgeFirst);

    // Uninstall removes the registration, the gitignore line, and the nudge.
    removeGlobalRegistrations();
    const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.ok(!('ultrateam' in (claude.mcpServers ?? {})));
    assert.ok(!fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8').includes('ultrateam shared memory'));
    assert.ok(!fs.existsSync(path.join(home, '.copilot', 'instructions', 'ultrateam.md')));
    assert.ok(!fs.existsSync(path.join(home, '.cursor', 'rules', 'ultrateam.mdc')));
    const codex = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.ok(!/\[mcp_servers\.ultrateam\]/.test(codex));
    const gi = fs.readFileSync(path.join(home, '.config', 'git', 'ignore'), 'utf8');
    assert.ok(!gi.split(/\r?\n/).some((l) => l.trim() === '.ultrateam/'));
  });
});

test('initGlobal preserves existing content in user config files', () => {
  withTempHome((home) => {
    // A pre-existing global instructions file with the user's own content.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# My global rules\n\nKeep this.\n');
    // A pre-existing Cursor config with another server.
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2),
    );

    initGlobal('/opt/ultrateam/dist/cli.js', { all: true });

    const md = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
    assert.ok(md.includes('# My global rules'));
    assert.ok(md.includes('Keep this.'));
    assert.ok(md.includes('ultrateam shared memory'));

    const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cursor.mcpServers.other.command, 'other'); // untouched
    assert.equal(cursor.mcpServers.ultrateam.command, process.execPath); // added
  });
});

test('normalizeAgentName handles gemini, antigravity, and codex', () => {
  assert.equal(normalizeAgentName('Gemini CLI v1.0'), 'gemini');
  assert.equal(normalizeAgentName('Antigravity Agent'), 'gemini');
  assert.equal(normalizeAgentName('OpenAI Codex MCP Client'), 'codex');
  assert.equal(normalizeAgentName('claude-code'), 'claude-code');
  assert.equal(normalizeAgentName('cursor-agent'), 'cursor');
  assert.equal(normalizeAgentName('User'), 'human');
  assert.equal(canonicalAgentName(' Codex '), 'codex');
  assert.equal(canonicalAgentName(' Custom Agent '), 'Custom Agent');
});

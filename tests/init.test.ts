import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, doctor } from '../src/setup/init.js';
import { normalizeAgentName } from '../src/agents/registry.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ultrateam-init-'));
}

test('init creates store, gitignore, AGENTS.md, and all agent configs with --all', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, '.git'));
  init(root, { all: true });

  assert.ok(fs.existsSync(path.join(root, '.ultrateam')));
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(root, '.gitignore')));
  assert.ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.ultrateam/'));

  // Check Claude Code (.mcp.json)
  assert.ok(fs.existsSync(path.join(root, '.mcp.json')));
  const claudeMcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.equal(claudeMcp.mcpServers.ultrateam.command, 'ultrateam');

  // Check Cursor (.cursor/mcp.json)
  assert.ok(fs.existsSync(path.join(root, '.cursor', 'mcp.json')));
  const cursorMcp = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cursorMcp.mcpServers.ultrateam.command, 'ultrateam');

  // Check VS Code / Copilot (.vscode/mcp.json)
  assert.ok(fs.existsSync(path.join(root, '.vscode', 'mcp.json')));
  const vscodeMcp = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'mcp.json'), 'utf8'));
  assert.equal(vscodeMcp.servers.ultrateam.command, 'ultrateam');

  // Check Gemini / Antigravity (.agents/mcp_config.json)
  assert.ok(fs.existsSync(path.join(root, '.agents', 'mcp_config.json')));
  const geminiMcp = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'mcp_config.json'), 'utf8'));
  assert.equal(geminiMcp.mcpServers.ultrateam.command, 'ultrateam');

  // Check Codex (.codex/mcp.json)
  assert.ok(fs.existsSync(path.join(root, '.codex', 'mcp.json')));
  const codexMcp = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'mcp.json'), 'utf8'));
  assert.equal(codexMcp.mcpServers.ultrateam.command, 'ultrateam');

  // Doctor check
  const docReport = doctor(root);
  assert.ok(docReport.some((l) => l.includes('Gemini / Antigravity: registered')));
  assert.ok(docReport.some((l) => l.includes('Codex: registered')));
});

test('normalizeAgentName handles gemini, antigravity, and codex', () => {
  assert.equal(normalizeAgentName('Gemini CLI v1.0'), 'gemini');
  assert.equal(normalizeAgentName('Antigravity Agent'), 'gemini');
  assert.equal(normalizeAgentName('OpenAI Codex MCP Client'), 'codex');
  assert.equal(normalizeAgentName('claude-code'), 'claude-code');
  assert.equal(normalizeAgentName('cursor-agent'), 'cursor');
});

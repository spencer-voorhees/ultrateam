// `ultrateam init`: one command that wires the whole team. Behavior is
// identical for every agent (same MCP server, same AGENTS.md contract); the
// only per-agent work is writing the server registration into each agent's
// config file, because that's the one thing the ecosystem hasn't standardized.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STORE_DIR, readEntries } from '../store/jsonl.js';
import { applyContract, CONTRACT_BEGIN } from '../contract.js';
import { Index } from '../store/db.js';

const SERVER_COMMAND = { command: 'ultrateam', args: ['serve'] };

interface AgentTarget {
  key: string;
  label: string;
  /** Is this agent installed on the machine? */
  detect: () => boolean;
  /** Path of the project-level config file that registers the MCP server. */
  configPath: (root: string) => string;
  /** Merge our server into that config file's JSON shape. */
  apply: (config: Record<string, unknown>) => void;
  /** Is our server already registered in the parsed config? */
  isConfigured: (config: Record<string, unknown>) => boolean;
}

function mcpServersStyle(): Pick<AgentTarget, 'apply' | 'isConfigured'> {
  return {
    apply: (config) => {
      const servers = (config.mcpServers ??= {}) as Record<string, unknown>;
      servers.ultrateam = { ...SERVER_COMMAND };
    },
    isConfigured: (config) =>
      typeof config.mcpServers === 'object' &&
      config.mcpServers !== null &&
      'ultrateam' in (config.mcpServers as Record<string, unknown>),
  };
}

export const AGENT_TARGETS: AgentTarget[] = [
  {
    key: 'claude-code',
    label: 'Claude Code',
    detect: () => fs.existsSync(path.join(os.homedir(), '.claude')),
    configPath: (root) => path.join(root, '.mcp.json'),
    ...mcpServersStyle(),
  },
  {
    key: 'cursor',
    label: 'Cursor',
    detect: () => fs.existsSync(path.join(os.homedir(), '.cursor')),
    configPath: (root) => path.join(root, '.cursor', 'mcp.json'),
    ...mcpServersStyle(),
  },
  {
    key: 'copilot',
    label: 'VS Code / Copilot',
    detect: () =>
      fs.existsSync(path.join(os.homedir(), 'AppData', 'Roaming', 'Code')) ||
      fs.existsSync(path.join(os.homedir(), '.config', 'Code')) ||
      fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'Code')),
    configPath: (root) => path.join(root, '.vscode', 'mcp.json'),
    apply: (config) => {
      const servers = (config.servers ??= {}) as Record<string, unknown>;
      servers.ultrateam = { type: 'stdio', ...SERVER_COMMAND };
    },
    isConfigured: (config) =>
      typeof config.servers === 'object' &&
      config.servers !== null &&
      'ultrateam' in (config.servers as Record<string, unknown>),
  },
  {
    key: 'gemini',
    label: 'Gemini / Antigravity',
    detect: () =>
      fs.existsSync(path.join(os.homedir(), '.gemini')) ||
      fs.existsSync(path.join(os.homedir(), '.agents')),
    configPath: (root) => path.join(root, '.agents', 'mcp_config.json'),
    ...mcpServersStyle(),
  },
  {
    key: 'codex',
    label: 'Codex',
    detect: () =>
      fs.existsSync(path.join(os.homedir(), '.codex')) ||
      fs.existsSync(path.join(os.homedir(), '.openai')),
    configPath: (root) => path.join(root, '.codex', 'mcp.json'),
    ...mcpServersStyle(),
  },
];

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') return {};
  const parsed = JSON.parse(raw); // let a genuinely corrupt config fail loudly
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function writeJson(file: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export interface InitOptions {
  /** Configure every known agent, not just detected ones. */
  all?: boolean;
}

export function init(root: string, opts: InitOptions = {}): string[] {
  const report: string[] = [];

  // 1. The store.
  const storeDir = path.join(root, STORE_DIR);
  if (fs.existsSync(storeDir)) {
    report.push(`✓ ${STORE_DIR}/ already present`);
  } else {
    fs.mkdirSync(storeDir, { recursive: true });
    report.push(`✓ created ${STORE_DIR}/`);
  }

  // 2. Keep the diary out of git by default; sharing it is an explicit choice.
  const gitignore = path.join(root, '.gitignore');
  const existingIgnore = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : null;
  const ignoreLine = `${STORE_DIR}/`;
  const hasIgnore = existingIgnore
    ?.split(/\r?\n/)
    .some((l) => l.trim() === ignoreLine || l.trim() === STORE_DIR);
  if (hasIgnore) {
    report.push(`✓ .gitignore already excludes ${ignoreLine}`);
  } else if (fs.existsSync(path.join(root, '.git'))) {
    const next =
      existingIgnore === null
        ? `${ignoreLine}\n`
        : existingIgnore.replace(/\n?$/, '\n') + `${ignoreLine}\n`;
    fs.writeFileSync(gitignore, next, 'utf8');
    report.push(`✓ added ${ignoreLine} to .gitignore (delete the line to share the diary via git)`);
  }

  // 3. The one contract, in the one file every agent reads.
  const agentsMd = path.join(root, 'AGENTS.md');
  const existing = fs.existsSync(agentsMd) ? fs.readFileSync(agentsMd, 'utf8') : null;
  const updated = applyContract(existing);
  if (existing === updated) {
    report.push('✓ AGENTS.md contract already up to date');
  } else {
    fs.writeFileSync(agentsMd, updated, 'utf8');
    report.push(existing === null ? '✓ created AGENTS.md with the ultrateam contract' : '✓ updated the ultrateam contract in AGENTS.md');
  }

  // 4. Per-agent MCP registration (plumbing only — behavior stays identical).
  for (const target of AGENT_TARGETS) {
    const detected = target.detect();
    if (!detected && !opts.all) {
      report.push(`- ${target.label}: not detected, skipped (use --all to configure anyway)`);
      continue;
    }
    const file = target.configPath(root);
    let config: Record<string, unknown>;
    try {
      config = readJson(file);
    } catch (err) {
      report.push(`✗ ${target.label}: could not parse ${path.relative(root, file)} — ${String(err)}`);
      continue;
    }
    if (target.isConfigured(config)) {
      report.push(`✓ ${target.label}: already registered in ${path.relative(root, file)}`);
      continue;
    }
    target.apply(config);
    writeJson(file, config);
    report.push(`✓ ${target.label}: registered ultrateam in ${path.relative(root, file)}`);
  }

  report.push('');
  report.push('Note: agents launch the server as `ultrateam serve` — install the CLI globally (npm i -g ultrateam, or npm link from a source checkout).');
  return report;
}

export function doctor(root: string | null): string[] {
  const report: string[] = [];
  report.push(`node: ${process.version}`);

  let index: Index | null = null;
  try {
    index = new Index();
    report.push(`✓ index: ${index.hasFts ? 'SQLite with FTS5' : 'SQLite WITHOUT FTS5 (recall falls back to token matching)'}`);
  } catch (err) {
    report.push(`✗ index: failed to open — ${String(err)}`);
  }

  if (root === null) {
    report.push('✗ project: no .ultrateam/ or git root found upward from here — run `ultrateam init`');
  } else {
    report.push(`✓ project root: ${root}`);
    const { entries, skipped } = readEntries(root);
    report.push(`✓ diary: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${skipped > 0 ? ` (${skipped} corrupt line${skipped === 1 ? '' : 's'} skipped)` : ''}`);

    const agentsMd = path.join(root, 'AGENTS.md');
    const hasContract =
      fs.existsSync(agentsMd) && fs.readFileSync(agentsMd, 'utf8').includes(CONTRACT_BEGIN);
    report.push(`${hasContract ? '✓' : '✗'} AGENTS.md contract ${hasContract ? 'installed' : 'missing — run `ultrateam init`'}`);

    for (const target of AGENT_TARGETS) {
      const detected = target.detect();
      const file = target.configPath(root);
      let configured = false;
      try {
        configured = target.isConfigured(readJson(file));
      } catch {
        // unparseable config — report as unconfigured
      }
      const status = configured ? '✓ registered' : detected ? '✗ not registered' : '- not detected';
      report.push(`${status.startsWith('✓') ? '✓' : status.startsWith('✗') ? '✗' : '-'} ${target.label}: ${status.replace(/^[✓✗-] /, '')}${detected && !configured ? ' — run `ultrateam init`' : ''}`);
    }
  }

  index?.close();
  return report;
}

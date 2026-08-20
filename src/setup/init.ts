// `ultrateam init`: one command that wires the whole team. Behavior is
// identical for every agent (same MCP server, same AGENTS.md contract); the
// only per-agent work is writing the server registration into each agent's
// config file, because that's the one thing the ecosystem hasn't standardized.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { STORE_DIR, readEntries } from '../store/jsonl.js';
import { Index } from '../store/db.js';
import { workspaceIdentity } from '../workspace.js';

const SERVER_COMMAND = { command: 'ultrateam', args: ['serve'] };

/**
 * The command agents launch for the MCP server. Global registration pins the
 * absolute node binary (the one that ran `init`, so a known-good ≥22.13) and
 * the absolute cli.js path, so it never depends on a GUI app's PATH or on which
 * `node` that app happens to resolve — the two classic MCP-launch failures.
 */
function serverCommand(cliEntry: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [cliEntry, 'serve'] };
}

type GlobalStyle = 'mcpServers' | 'servers' | 'codex-toml' | 'copilot-cli';

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
  /**
   * User-level config file that registers the MCP server for every project at
   * once. This is what `init` writes; it puts nothing into any repo.
   */
  globalConfigPath?: () => string;
  /** Shape of that user-level config file. */
  globalStyle?: GlobalStyle;
  /** User-level instructions file that carries the short usage nudge, if any. */
  globalInstructionsPath?: () => string | null;
  /** The instructions file is ours alone (write/delete whole), not shared with the user's content. */
  globalInstructionsDedicated?: boolean;
  /**
   * Shape of the dedicated file: 'mdc' is a Cursor rule (frontmatter with
   * alwaysApply: true), 'instructions-md' is a Copilot *.instructions.md file
   * (frontmatter with applyTo: '**'). Absent means plain markdown.
   */
  globalInstructionsFormat?: 'mdc' | 'instructions-md';
  /** Obsolete instruction files from older versions, cleaned up on init and uninstall. */
  legacyInstructionsPaths?: () => string[];
}

/** VS Code stores user MCP config under its per-OS User directory. */
function vscodeUserMcpPath(): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'), // macOS
    path.join(home, '.config', 'Code', 'User', 'mcp.json'), // Linux
    path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'), // Windows
  ];
  for (const c of candidates) {
    // The "Code/User" dir exists once VS Code has run at least once.
    if (fs.existsSync(path.dirname(c))) return c;
  }
  return candidates[0];
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
    globalConfigPath: () => path.join(os.homedir(), '.claude.json'),
    globalStyle: 'mcpServers',
    globalInstructionsPath: () => path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  },
  {
    key: 'cursor',
    label: 'Cursor',
    detect: () => fs.existsSync(path.join(os.homedir(), '.cursor')),
    configPath: (root) => path.join(root, '.cursor', 'mcp.json'),
    ...mcpServersStyle(),
    globalConfigPath: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
    globalStyle: 'mcpServers',
    // Cursor's docs only list project-level .cursor/rules and settings-based
    // User Rules, but recent builds have been observed loading ~/.cursor/rules
    // globally too. Keep the .mdc; the MCP server instructions back it up.
    globalInstructionsPath: () => path.join(os.homedir(), '.cursor', 'rules', 'ultrateam.mdc'),
    globalInstructionsDedicated: true,
    globalInstructionsFormat: 'mdc',
  },
  {
    key: 'copilot',
    label: 'VS Code (Copilot)',
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
    globalConfigPath: vscodeUserMcpPath,
    globalStyle: 'servers',
    // VS Code and Copilot CLI both discover user-level instructions matching
    // ~/.copilot/instructions/**/*.instructions.md — the .instructions.md suffix
    // and an applyTo glob are required, a plain .md there is ignored.
    globalInstructionsPath: () =>
      path.join(os.homedir(), '.copilot', 'instructions', 'ultrateam.instructions.md'),
    globalInstructionsDedicated: true,
    globalInstructionsFormat: 'instructions-md',
    legacyInstructionsPaths: () => [
      path.join(os.homedir(), '.copilot', 'instructions', 'ultrateam.md'),
    ],
  },
  {
    // The Copilot CLI (and the standalone app) read MCP from their own file with
    // an mcpServers/type:"local" shape — NOT VS Code's user mcp.json.
    key: 'copilot-cli',
    label: 'GitHub Copilot CLI',
    detect: () => fs.existsSync(path.join(os.homedir(), '.copilot')),
    configPath: (root) => path.join(root, '.mcp.json'),
    ...mcpServersStyle(),
    globalConfigPath: () => path.join(os.homedir(), '.copilot', 'mcp-config.json'),
    globalStyle: 'copilot-cli',
    globalInstructionsPath: () =>
      path.join(os.homedir(), '.copilot', 'instructions', 'ultrateam.instructions.md'),
    globalInstructionsDedicated: true,
    globalInstructionsFormat: 'instructions-md',
    legacyInstructionsPaths: () => [
      path.join(os.homedir(), '.copilot', 'instructions', 'ultrateam.md'),
    ],
  },
  {
    key: 'gemini',
    label: 'Gemini / Antigravity',
    detect: () =>
      fs.existsSync(path.join(os.homedir(), '.gemini')) ||
      fs.existsSync(path.join(os.homedir(), '.agents')),
    configPath: (root) => path.join(root, '.agents', 'mcp_config.json'),
    ...mcpServersStyle(),
    globalConfigPath: () => path.join(os.homedir(), '.gemini', 'settings.json'),
    globalStyle: 'mcpServers',
    globalInstructionsPath: () => path.join(os.homedir(), '.gemini', 'GEMINI.md'),
  },
  {
    key: 'codex',
    label: 'Codex',
    detect: () =>
      fs.existsSync(path.join(os.homedir(), '.codex')) ||
      fs.existsSync(path.join(os.homedir(), '.openai')),
    configPath: (root) => path.join(root, '.codex', 'mcp.json'),
    ...mcpServersStyle(),
    globalConfigPath: () => path.join(os.homedir(), '.codex', 'config.toml'),
    globalStyle: 'codex-toml',
    globalInstructionsPath: () => path.join(os.homedir(), '.codex', 'AGENTS.md'),
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

function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Merge our server into a user-level MCP config file. */
function writeGlobalRegistration(
  target: AgentTarget,
  cmd: { command: string; args: string[] },
): { file: string; already: boolean } {
  const file = target.globalConfigPath!();
  if (target.globalStyle === 'codex-toml') return applyCodexGlobalToml(file, cmd);

  const config = readJson(file);
  const key = target.globalStyle === 'servers' ? 'servers' : 'mcpServers';
  const already =
    typeof config[key] === 'object' &&
    config[key] !== null &&
    'ultrateam' in (config[key] as Record<string, unknown>);
  const servers = (config[key] ??= {}) as Record<string, unknown>;
  servers.ultrateam =
    target.globalStyle === 'servers'
      ? { type: 'stdio', ...cmd }
      : target.globalStyle === 'copilot-cli'
        ? { type: 'local', ...cmd, tools: ['*'] }
        : { ...cmd };
  writeJson(file, config);
  return { file, already };
}

/**
 * Codex uses TOML. We never rewrite the user's TOML structurally: if our table
 * already exists we leave it; otherwise we append it. Command/args are emitted
 * as TOML basic strings / arrays via JSON.stringify (a valid TOML subset).
 */
function applyCodexGlobalToml(
  file: string,
  cmd: { command: string; args: string[] },
): { file: string; already: boolean } {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^\s*\[mcp_servers\.ultrateam\]/m.test(existing)) return { file, already: true };
  const block =
    `[mcp_servers.ultrateam]\n` +
    `command = ${JSON.stringify(cmd.command)}\n` +
    `args = ${JSON.stringify(cmd.args)}\n`;
  const next = existing === '' ? block : existing.replace(/\n?$/, '\n\n') + block;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return { file, already: false };
}

/** The global gitignore file git actually consults (core.excludesfile, or the XDG default). */
export function globalGitignoreFile(): string {
  try {
    const out = execFileSync('git', ['config', '--global', '--get', 'core.excludesfile'], {
      encoding: 'utf8',
    }).trim();
    if (out) return out.startsWith('~') ? path.join(os.homedir(), out.slice(1)) : out;
  } catch {
    // git missing or key unset — fall through to git's documented default.
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'git', 'ignore');
}

function ensureGlobalGitignore(): string[] {
  const file = globalGitignoreFile();
  const line = `${STORE_DIR}/`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const has = existing?.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === STORE_DIR);
  if (has) return [`✓ global gitignore already excludes ${line} (${tildify(file)})`];
  const next =
    existing === null || existing === ''
      ? `${line}\n`
      : existing.replace(/\n?$/, '\n') + `${line}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return [`✓ added ${line} to your global gitignore (${tildify(file)})`];
}

const NUDGE_MARKER = '<!-- ultrateam:begin -->';
const NUDGE_END = '<!-- ultrateam:end -->';
const NUDGE_SIGNATURE = 'ultrateam shared memory';
const NUDGE_BODY =
  '## ultrateam shared memory\n' +
  'This machine runs the `ultrateam` MCP server, giving every coding agent one shared memory per project. ' +
  'At the start of a task, call its `recall` tool to load prior context, and use `checkpoint` and `handoff` ' +
  'to record decisions and hand work off so any agent can resume where another left off. ' +
  'When you call `checkpoint` or `handoff`, always pass your `model` id (e.g. `claude-sonnet-4-6`, `gpt-5.6`) ' +
  'so the memory attributes each entry to the right model.\n';
// Marker-wrapped form, appended into files that hold the user's own content too.
const GLOBAL_NUDGE = `${NUDGE_MARKER}\n${NUDGE_BODY}${NUDGE_END}\n`;
// Cursor .mdc form: frontmatter with alwaysApply so Agent mode reliably attaches it.
const MDC_NUDGE = `---\ndescription: ultrateam shared memory\nalwaysApply: true\n---\n${NUDGE_BODY}`;
// Copilot *.instructions.md form: applyTo '**' so it attaches to every task.
const INSTRUCTIONS_MD_NUDGE = `---\ndescription: ultrateam shared memory\napplyTo: '**'\n---\n${NUDGE_BODY}`;

function dedicatedNudgeContent(format?: 'mdc' | 'instructions-md'): string {
  if (format === 'mdc') return MDC_NUDGE;
  if (format === 'instructions-md') return INSTRUCTIONS_MD_NUDGE;
  return NUDGE_BODY;
}

/** Remove instruction files that older versions wrote under now-wrong names. */
function removeLegacyInstructions(target: AgentTarget): void {
  for (const file of target.legacyInstructionsPaths?.() ?? []) {
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(NUDGE_SIGNATURE)) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // never let cleanup break init
    }
  }
}

/**
 * Add the short usage nudge to each agent's global instructions, silently.
 * Dedicated files (ours alone: Copilot's ~/.copilot/instructions/ultrateam.md as
 * plain markdown, Cursor's ~/.cursor/rules/ultrateam.mdc as a frontmatter rule)
 * are written whole; shared files (CLAUDE.md/AGENTS.md/GEMINI.md) get the
 * marker-wrapped block appended.
 */
function ensureGlobalNudge(opts: InitOptions): string[] {
  const report: string[] = [];
  for (const target of AGENT_TARGETS) {
    if (!target.detect() && !opts.all) continue;
    removeLegacyInstructions(target);
    const file = target.globalInstructionsPath?.();
    if (!file) continue;
    if (target.globalInstructionsDedicated) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, dedicatedNudgeContent(target.globalInstructionsFormat), 'utf8');
      report.push(`✓ ${target.label}: usage instructions at ${tildify(file)}`);
    } else {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (existing.includes(NUDGE_MARKER)) {
        report.push(`✓ ${target.label}: usage instructions already in ${tildify(file)}`);
        continue;
      }
      const next = existing === '' ? GLOBAL_NUDGE : existing.replace(/\n?$/, '\n\n') + GLOBAL_NUDGE;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next, 'utf8');
      report.push(`✓ ${target.label}: usage instructions added to ${tildify(file)}`);
    }
    if (target.key === 'cursor') {
      report.push(
        '  note: global rule files are undocumented in Cursor — if this rule is not picked up, the MCP server instructions carry the nudge, or add a User Rule in Cursor Settings → Rules.',
      );
    }
  }
  return report;
}

/**
 * `init` sets ultrateam up globally: it registers the MCP server at the user
 * level for every detected agent and ignores the store globally. It writes
 * NOTHING into any project directory, so running it never creates a git diff.
 * The per-project `.ultrateam/` store is created lazily on first use and is
 * covered by the global gitignore.
 *
 * `cliEntry` is the absolute path to this CLI's entry (dist/cli.js). Registering
 * `process.execPath <cliEntry> serve` pins the known-good node and script path,
 * so agents launched by GUI apps don't fail on PATH or node-version mismatch.
 */
export function initGlobal(cliEntry: string, opts: InitOptions = {}): string[] {
  const report: string[] = [];
  const cmd = serverCommand(cliEntry);

  report.push('Setting up ultrateam globally.');
  report.push('');

  for (const target of AGENT_TARGETS) {
    if (!target.detect() && !opts.all) {
      report.push(`- ${target.label}: not detected, skipped (use --all to configure anyway)`);
      continue;
    }
    if (!target.globalConfigPath) {
      report.push(`- ${target.label}: no user-level config path known, skipped`);
      continue;
    }
    try {
      const { file, already } = writeGlobalRegistration(target, cmd);
      report.push(
        already
          ? `✓ ${target.label}: already registered in ${tildify(file)}`
          : `✓ ${target.label}: registered ultrateam in ${tildify(file)}`,
      );
    } catch (err) {
      report.push(`✗ ${target.label}: ${String(err)}`);
    }
  }

  report.push('');
  report.push(...ensureGlobalGitignore());
  report.push(...ensureGlobalNudge(opts));
  report.push('');
  report.push(`Server launch: ${cmd.command} ${cmd.args.join(' ')}`);
  report.push('Done.');
  return report;
}

/** Reverse of initGlobal: remove ultrateam from every user-level config, the global gitignore, and the nudges. */
export function removeGlobalRegistrations(): string[] {
  const report: string[] = [];

  for (const target of AGENT_TARGETS) {
    if (!target.globalConfigPath) continue;
    const file = target.globalConfigPath();
    if (!fs.existsSync(file)) continue;
    try {
      if (target.globalStyle === 'codex-toml') {
        const existing = fs.readFileSync(file, 'utf8');
        const stripped = existing.replace(/\n*\[mcp_servers\.ultrateam\][^[]*/, '\n').replace(/^\n+/, '');
        if (stripped !== existing) {
          fs.writeFileSync(file, stripped, 'utf8');
          report.push(`✓ ${target.label}: removed from ${tildify(file)}`);
        }
        continue;
      }
      const config = readJson(file);
      const key = target.globalStyle === 'servers' ? 'servers' : 'mcpServers';
      const servers = config[key] as Record<string, unknown> | undefined;
      if (servers && typeof servers === 'object' && 'ultrateam' in servers) {
        delete servers.ultrateam;
        writeJson(file, config);
        report.push(`✓ ${target.label}: removed from ${tildify(file)}`);
      }
    } catch {
      // leave a config we cannot parse alone
    }
  }

  // Global gitignore line.
  const gi = globalGitignoreFile();
  if (fs.existsSync(gi)) {
    const existing = fs.readFileSync(gi, 'utf8');
    const next = existing
      .split(/\r?\n/)
      .filter((l) => l.trim() !== `${STORE_DIR}/` && l.trim() !== STORE_DIR)
      .join('\n');
    if (next !== existing) {
      fs.writeFileSync(gi, next, 'utf8');
      report.push(`✓ removed ${STORE_DIR}/ from ${tildify(gi)}`);
    }
  }

  // Usage nudges.
  for (const target of AGENT_TARGETS) {
    removeLegacyInstructions(target);
    const file = target.globalInstructionsPath?.();
    if (!file || !fs.existsSync(file)) continue;
    const existing = fs.readFileSync(file, 'utf8');
    if (target.globalInstructionsDedicated) {
      // A file we own — remove it whole if it still looks like ours.
      if (existing.includes(NUDGE_SIGNATURE)) {
        fs.rmSync(file, { force: true });
        report.push(`✓ ${target.label}: removed usage nudge ${tildify(file)}`);
      }
      continue;
    }
    const start = existing.indexOf(NUDGE_MARKER);
    const endIdx = existing.indexOf(NUDGE_END);
    if (start === -1 || endIdx === -1 || endIdx < start) continue;
    const before = existing.slice(0, start).replace(/\n+$/, '');
    const after = existing.slice(endIdx + NUDGE_END.length).replace(/^\n+/, '');
    const joined = before && after ? `${before}\n\n${after}` : before + after;
    fs.writeFileSync(file, joined ? `${joined}\n` : '', 'utf8');
    report.push(`✓ ${target.label}: removed usage nudge from ${tildify(file)}`);
  }

  return report;
}

/** Is ultrateam registered in this agent's user-level (global) config? */
export function isGloballyRegistered(target: AgentTarget): boolean {
  if (!target.globalConfigPath) return false;
  const file = target.globalConfigPath();
  if (!fs.existsSync(file)) return false;
  if (target.globalStyle === 'codex-toml') {
    return /^\s*\[mcp_servers\.ultrateam\]/m.test(fs.readFileSync(file, 'utf8'));
  }
  try {
    const config = readJson(file);
    const key = target.globalStyle === 'servers' ? 'servers' : 'mcpServers';
    return (
      typeof config[key] === 'object' &&
      config[key] !== null &&
      'ultrateam' in (config[key] as Record<string, unknown>)
    );
  } catch {
    return false;
  }
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

  // Global gitignore keeps the store out of every repo.
  const gi = globalGitignoreFile();
  const giHas =
    fs.existsSync(gi) &&
    fs
      .readFileSync(gi, 'utf8')
      .split(/\r?\n/)
      .some((l) => l.trim() === `${STORE_DIR}/` || l.trim() === STORE_DIR);
  report.push(
    giHas
      ? `✓ global gitignore excludes ${STORE_DIR}/ (${tildify(gi)})`
      : `✗ global gitignore does not exclude ${STORE_DIR}/ — run \`ultrateam init\``,
  );

  // Per-agent global registration.
  for (const target of AGENT_TARGETS) {
    const detected = target.detect();
    const registered = isGloballyRegistered(target);
    if (registered) report.push(`✓ ${target.label}: registered globally`);
    else if (detected) report.push(`✗ ${target.label}: not registered — run \`ultrateam init\``);
    else report.push(`- ${target.label}: not detected`);
  }

  // Usage-nudge instruction files — how each agent learns to call ultrateam.
  for (const target of AGENT_TARGETS) {
    if (!target.detect()) continue;
    const file = target.globalInstructionsPath?.();
    if (!file) continue;
    const present = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(NUDGE_SIGNATURE);
    report.push(
      present
        ? `✓ ${target.label}: usage instructions at ${tildify(file)}`
        : `✗ ${target.label}: usage instructions missing (${tildify(file)}) — run \`ultrateam init\``,
    );
    for (const legacy of target.legacyInstructionsPaths?.() ?? []) {
      if (fs.existsSync(legacy)) {
        report.push(`✗ ${target.label}: stale ${tildify(legacy)} from an older version — run \`ultrateam init\` to clean it up`);
      }
    }
  }

  // Current project store (informational — created on first use).
  if (root === null) {
    report.push('- project: no store here yet (one is created on first use)');
  } else {
    report.push(`✓ project root: ${root}`);
    const identity = workspaceIdentity(root);
    report.push(
      identity.source === 'path'
        ? `✗ workspace identity: ${identity.id} from the folder path only — git resolution failed here, so clones and worktrees of this repo will NOT merge into one workspace`
        : `✓ workspace identity: ${identity.id} (via ${identity.source})`,
    );
    const { entries, skipped } = readEntries(root);
    report.push(`✓ memory: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${skipped > 0 ? ` (${skipped} corrupt line${skipped === 1 ? '' : 's'} skipped)` : ''}`);
  }

  index?.close();
  return report;
}

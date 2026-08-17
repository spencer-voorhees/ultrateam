#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { createEntry } from './schema.js';
import { findProjectRoot, appendEntry } from './store/jsonl.js';
import { Index } from './store/db.js';
import { currentBranch } from './git.js';
import { formatEntry, formatResume, agentLabel, timeAgo } from './format.js';
import { knownRoots, unregisterRoot } from './store/roots.js';
import { init, doctor } from './setup/init.js';
import { startServer } from './server.js';
import { startViewer } from './viewer/server.js';
import {
  defaultViewerLogPath,
  removeViewerState,
  runningViewer,
  stopViewer,
  waitForViewer,
  writeViewerState,
  type ViewerMode,
  type ViewerState,
} from './viewer/process.js';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';
import { rootsInWorkspace } from './workspace.js';
import { createResumeState, resumableState } from './resume.js';

const program = new Command();

function requireRoot(): string {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error('No .ultrateam/ store or git root found. Run `ultrateam init` in your project.');
    process.exit(1);
  }
  return root;
}

function positiveInt(value: string): number {
  if (!/^\d+$/.test(value.trim()) || Number.parseInt(value, 10) < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return Number.parseInt(value, 10);
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function indexWorkspace(index: Index, root: string): void {
  for (const workspaceRoot of rootsInWorkspace(root, knownRoots())) {
    if (fs.existsSync(workspaceRoot)) index.indexProject(workspaceRoot);
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const opener = spawn(cmd as string, args as string[], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    opener.on('error', () => {
      // The printed URL remains the fallback.
    });
    opener.unref();
  } catch {
    // The URL is printed either way; a failed auto-open is not an error.
  }
}

function printViewerStatus(state: ViewerState): void {
  console.log(`ultrateam viewer is running in the ${state.mode}`);
  console.log(`URL:     ${state.url}`);
  console.log(`PID:     ${state.pid}`);
  console.log(`Started: ${state.startedAt}`);
}

program
  .name('ultrateam')
  .description('Shared memory and session handoff for the team of coding agents on your machine')
  .version(VERSION);

program
  .command('init')
  .description('Set up this project: .ultrateam/ store, AGENTS.md contract, MCP registration for detected agents')
  .option('--all', 'configure every supported agent, not just detected ones')
  .action((opts: { all?: boolean }) => {
    const root = findProjectRoot(process.cwd()) ?? process.cwd();
    for (const line of init(root, { all: opts.all })) console.log(line);
  });

program
  .command('doctor')
  .description('Check that the store, index, contract, and agent registrations are healthy')
  .action(() => {
    for (const line of doctor(findProjectRoot(process.cwd()))) console.log(line);
  });

program
  .command('serve')
  .description('Start the MCP server (stdio) — this is what agent configs launch')
  .action(async () => {
    await startServer();
  });

program
  .command('view')
  .description('Start or reuse the local web viewer')
  .option('-p, --port <n>', 'port to listen on', positiveInt, 4272)
  .option('--no-open', 'do not open the browser automatically')
  .option('--foreground', 'run attached to the current terminal')
  .option('--status', 'show the viewer status')
  .option('--stop', 'stop the viewer')
  .action(async (opts: {
    port: number;
    open: boolean;
    foreground?: boolean;
    status?: boolean;
    stop?: boolean;
  }) => {
    const modeCount = [opts.foreground, opts.status, opts.stop].filter(Boolean).length;
    if (modeCount > 1) throw new Error('Use only one of --foreground, --status, or --stop.');

    const existing = await runningViewer();
    if (opts.status) {
      if (!existing) {
        console.log('ultrateam viewer is not running.');
        process.exitCode = 1;
        return;
      }
      printViewerStatus(existing);
      return;
    }
    if (opts.stop) {
      if (!existing) {
        console.log('ultrateam viewer is not running.');
        return;
      }
      await stopViewer(existing);
      console.log(`Stopped ultrateam viewer at ${existing.url}.`);
      return;
    }

    if (!opts.foreground) {
      if (existing) {
        console.log(`Reusing ultrateam viewer at ${existing.url} (PID ${existing.pid}).`);
        if (opts.open) openBrowser(existing.url);
        return;
      }

      const instanceId = randomUUID();
      const cliPath = fileURLToPath(import.meta.url);
      const runtimeArgs = path.extname(cliPath) === '.ts' ? process.execArgv : [];
      const logFile = defaultViewerLogPath();
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const outFd = fs.openSync(logFile, 'a');
      const child = spawn(
        process.execPath,
        [...runtimeArgs, cliPath, 'view', '--foreground', '--no-open', '--port', String(opts.port)],
        {
          cwd: process.cwd(),
          detached: true,
          env: {
            ...process.env,
            ULTRATEAM_VIEWER_INSTANCE_ID: instanceId,
            ULTRATEAM_VIEWER_MODE: 'background',
          },
          stdio: ['ignore', outFd, outFd],
          windowsHide: true,
        },
      );
      fs.closeSync(outFd);
      const state = await waitForViewer(instanceId);
      if (!state) {
        if (child.pid && child.exitCode === null) {
          try {
            process.kill(child.pid, 'SIGTERM');
          } catch {
            // It may have already exited after failing to bind.
          }
        }
        let detail = '';
        try {
          if (fs.existsSync(logFile)) {
            const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-10);
            if (lines.length > 0 && lines.some((l) => l.trim().length > 0)) {
              detail = `:\n${lines.join('\n')}`;
            }
          }
        } catch {}
        throw new Error(`The ultrateam viewer did not start on port ${opts.port}${detail}`);
      }
      child.unref();
      console.log(`Started ultrateam viewer in the background at ${state.url} (PID ${state.pid}).`);
      if (opts.open) openBrowser(state.url);
      return;
    }

    if (existing) {
      throw new Error(
        `The ultrateam viewer is already running at ${existing.url} (PID ${existing.pid}). Run \`ultrateam view --stop\` first.`,
      );
    }

    const instanceId = process.env.ULTRATEAM_VIEWER_INSTANCE_ID ?? randomUUID();
    const mode: ViewerMode = process.env.ULTRATEAM_VIEWER_MODE === 'background'
      ? 'background'
      : 'foreground';
    const handle = await startViewer({ port: opts.port, instanceId });
    const state: ViewerState = {
      version: 1,
      instanceId,
      pid: process.pid,
      port: handle.port,
      url: handle.url,
      mode,
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    };
    writeViewerState(state);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      removeViewerState(instanceId);
    };
    process.once('exit', cleanup);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        handle.close();
        cleanup();
        process.exit(0);
      });
    }

    console.log(`ultrateam viewer at ${handle.url} (Ctrl+C to stop)`);
    if (opts.open) openBrowser(handle.url);
  });

program
  .command('log')
  .description('Write a diary entry by hand')
  .requiredOption('-t, --title <title>', 'entry title')
  .requiredOption('-m, --summary <summary>', 'what happened and why')
  .option('-k, --kind <kind>', 'session | handoff | note', 'note')
  .option('-f, --files <files>', 'comma-separated file paths', csv, [])
  .option('-d, --decisions <decisions>', 'comma-separated decisions', csv, [])
  .option('-o, --open-threads <threads>', 'comma-separated unfinished items', csv, [])
  .option('--tags <tags>', 'comma-separated tags', csv, [])
  .option('--agent <name>', 'agent name to attribute', 'human')
  .option('--model <model>', 'model id to attribute')
  .option('--objective <objective>', 'active user goal for portable session resume')
  .option('--completed <items>', 'comma-separated completed work', csv, [])
  .option('--next-steps <items>', 'comma-separated ordered next steps', csv, [])
  .option('--blockers <items>', 'comma-separated blockers', csv, [])
  .option('--verification <items>', 'comma-separated checks and outcomes', csv, [])
  .option('--commands <items>', 'comma-separated useful continuation commands', csv, [])
  .action((opts) => {
    const root = requireRoot();
    const entry = createEntry({
      project: path.basename(root),
      branch: currentBranch(root),
      agent: { name: opts.agent, model: opts.model },
      kind: opts.kind,
      title: opts.title,
      summary: opts.summary,
      files: opts.files,
      decisions: opts.decisions,
      open_threads: opts.openThreads,
      tags: opts.tags,
      resume: opts.kind === 'note' ? null : createResumeState(root, {
        title: opts.title,
        summary: opts.summary,
        open_threads: opts.openThreads,
        objective: opts.objective,
        completed: opts.completed,
        next_steps: opts.nextSteps,
        blockers: opts.blockers,
        verification: opts.verification,
        commands: opts.commands,
      }),
    });
    appendEntry(root, entry);
    const index = new Index();
    index.upsert(entry, root);
    index.close();
    console.log(`Logged ${entry.id}: ${entry.title}`);
  });

program
  .command('resume [query...]')
  .description('Restore the latest portable session state')
  .option('--id <ulid>', 'restore an exact checkpoint or handoff')
  .option('-a, --all-projects', 'search every workspace on this machine')
  .option('--json', 'print machine-readable JSON')
  .action((queryWords: string[], opts: { id?: string; allProjects?: boolean; json?: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const index = new Index();
    if (root) indexWorkspace(index, root);
    const branch = root ? (currentBranch(root) ?? undefined) : undefined;
    const projectPath = opts.allProjects ? undefined : (root ?? undefined);
    const result = opts.id
      ? index.resumeById(opts.id, { projectPath })
      : queryWords.length > 0
      ? index.recall({ query: queryWords.join(' '), projectPath, branch, limit: 50 })
          .find((candidate) => candidate.entry.resume || candidate.entry.kind === 'handoff') ?? null
      : index.latestResume({ projectPath, branch });
    index.close();
    if (!result) {
      console.error('No resumable checkpoint or handoff found.');
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify({ entry: result.entry, resume: resumableState(result.entry), projectPath: result.projectPath }, null, 2));
    } else {
      console.log(formatResume(result.entry));
    }
  });

program
  .command('recall [query...]')
  .description('Search the shared diary')
  .option('-f, --files <files>', 'comma-separated files to boost matches for', csv, [])
  .option('-n, --limit <n>', 'max results', positiveInt, 8)
  .option('-a, --all-projects', 'search every project on this machine')
  .action((queryWords: string[], opts) => {
    const root = findProjectRoot(process.cwd());
    const index = new Index();
    if (root) indexWorkspace(index, root);
    const results = index.recall({
      query: queryWords.length > 0 ? queryWords.join(' ') : undefined,
      files: opts.files,
      limit: opts.limit,
      branch: root ? (currentBranch(root) ?? undefined) : undefined,
      projectPath: opts.allProjects ? undefined : (root ?? undefined),
    });
    index.close();
    if (results.length === 0) {
      console.log('No matching entries.');
      return;
    }
    console.log(results.map((r) => formatEntry(r.entry, { withId: true })).join('\n\n'));
  });

program
  .command('list')
  .description('List recent entries')
  .option('-n, --limit <n>', 'max results', positiveInt, 20)
  .option('-a, --all-projects', 'list across every project')
  .action((opts) => {
    const root = findProjectRoot(process.cwd());
    const index = new Index();
    if (root) indexWorkspace(index, root);
    const results = index.list({
      projectPath: opts.allProjects ? undefined : (root ?? undefined),
      limit: opts.limit,
    });
    index.close();
    if (results.length === 0) {
      console.log('No entries yet.');
      return;
    }
    for (const r of results) {
      const e = r.entry;
      console.log(`${e.id}  ${timeAgo(e.ts).padEnd(10)} ${e.kind.padEnd(8)} ${agentLabel(e)}  ${e.title}`);
    }
  });

program
  .command('show <id>')
  .description('Show one entry in full')
  .action((id: string) => {
    const index = new Index();
    // Self-heal like recall/list: the id may exist in JSONL truth but not yet
    // in the derived index (fresh clone, deleted index.db).
    const root = findProjectRoot(process.cwd());
    if (root) {
      try {
        indexWorkspace(index, root);
      } catch {
        // fall through to whatever the index already has
      }
    }
    const result = index.get(id);
    index.close();
    if (!result) {
      console.error(`No entry with id ${id}.`);
      process.exit(1);
    }
    console.log(formatEntry(result.entry, { withId: true }));
    console.log(`\nProject: ${result.projectPath}`);
  });

program
  .command('reindex')
  .description('Rebuild the SQLite index from JSONL truth')
  .option('-a, --all', 'reindex every project the index knows about')
  .action((opts) => {
    const index = new Index();
    // Union the on-disk registry with the index's own paths: the registry is
    // what survives a deleted index.db (the index is disposable; this isn't).
    const roots = opts.all
      ? [...new Set([...knownRoots(), ...index.projectPaths()])]
      : [requireRoot()];
    if (roots.length === 0) {
      console.log('No known projects. Run `ultrateam reindex` inside a project to register it.');
    }
    for (const root of roots) {
      if (!fs.existsSync(root)) {
        index.removeProject(root);
        unregisterRoot(root);
        console.log(`${root}: directory gone — removed from index and registry`);
        continue;
      }
      const { indexed, skipped } = index.indexProject(root);
      console.log(`${root}: ${indexed} indexed${skipped > 0 ? `, ${skipped} corrupt lines skipped` : ''}`);
    }
    index.close();
  });

program
  .command('update')
  .description('Update ultrateam to the latest (git pull + rebuild its install)')
  .action(() => {
    // The CLI runs from <install>/dist/cli.js, so the package root is one level up.
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (!fs.existsSync(path.join(pkgRoot, '.git'))) {
      console.error(`ultrateam wasn't installed from a source checkout (${pkgRoot}), so there's nothing to pull.`);
      console.error('Re-run the installer to update:');
      console.error('  macOS/Linux  curl -fsSL https://raw.githubusercontent.com/spencer-voorhees/ultrateam/main/install.sh | bash');
      console.error('  Windows      irm https://raw.githubusercontent.com/spencer-voorhees/ultrateam/main/install.ps1 | iex');
      process.exit(1);
    }
    // npm through the shell so Windows uses npm.cmd (never the policy-gated npm.ps1).
    const run = (cmd: string) => execSync(cmd, { cwd: pkgRoot, stdio: 'inherit' });
    const head = () => execSync('git rev-parse --short HEAD', { cwd: pkgRoot }).toString().trim();
    try {
      const before = head();
      console.error(`ultrateam v${VERSION} (${before}) — checking for updates...`);
      run('git pull --ff-only');
      const after = head();
      if (after === before) {
        console.error('Already up to date.');
        return;
      }
      console.error('→ installing dependencies');
      run('npm install --no-audit --no-fund');
      console.error('→ building');
      run('npm run build');
      if (process.platform === 'win32') {
        try {
          const prefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();
          const cliJs = path.join(pkgRoot, 'dist', 'cli.js');
          for (const candidate of [
            path.join(prefix, 'ultrateam.ps1'),
            path.join(prefix, 'bin', 'ultrateam.ps1'),
            ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm', 'ultrateam.ps1')] : []),
          ]) {
            if (fs.existsSync(candidate)) {
              try { fs.unlinkSync(candidate); } catch {}
            }
          }
          const cmdShim = path.join(prefix, 'ultrateam.cmd');
          fs.writeFileSync(cmdShim, `@echo off\r\nnode "${cliJs}" %*\r\n`, 'ascii');
        } catch {
          // ignore shim cleanup failures during update
        }
      }
      console.error(`Updated ${before} → ${after}. Restart any running agents to pick it up.`);
    } catch (err) {
      console.error(`update failed: ${String(err)}`);
      process.exit(1);
    }
  });

program.parseAsync().catch((err) => {
  console.error(String(err));
  process.exit(1);
});

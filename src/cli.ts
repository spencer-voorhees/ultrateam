#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { createEntry } from './schema.js';
import { findProjectRoot, appendEntry } from './store/jsonl.js';
import { Index } from './store/db.js';
import { currentBranch } from './git.js';
import { formatEntry, agentLabel, timeAgo } from './format.js';
import { knownRoots, unregisterRoot } from './store/roots.js';
import { init, doctor } from './setup/init.js';
import { startServer } from './server.js';
import { VERSION } from './version.js';

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
    });
    appendEntry(root, entry);
    const index = new Index();
    index.upsert(entry, root);
    index.close();
    console.log(`Logged ${entry.id}: ${entry.title}`);
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
    if (root) index.indexProject(root);
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
    if (root) index.indexProject(root);
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
        index.indexProject(root);
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

program.parseAsync().catch((err) => {
  console.error(String(err));
  process.exit(1);
});

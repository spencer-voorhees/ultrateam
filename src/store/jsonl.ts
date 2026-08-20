// The JSONL layer is the source of truth: one append-only file per project at
// <project>/.ultrateam/entries.jsonl. The SQLite index (db.ts) is derived from
// it and can always be rebuilt.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Entry, parseEntryLine } from '../schema.js';

export const STORE_DIR = '.ultrateam';
export const ENTRIES_FILE = 'entries.jsonl';

/** The app's own source checkout is infrastructure, never a user workspace. */
export function isUltrateamInstallDirectory(
  value: string,
  home: string = os.homedir(),
  installHome: string | undefined = process.env.ULTRATEAM_HOME,
): boolean {
  const resolved = path.resolve(value);
  const installs = [
    path.resolve(home, '.ultrateam-app'),
    ...(installHome ? [path.resolve(installHome)] : []),
  ];
  return installs.some((install) => resolved === install);
}

/**
 * Walk upward from startDir looking for a directory containing `.ultrateam/`.
 * Falls back to the nearest git root so first-time use lands entries at the
 * repo root rather than wherever the agent's cwd happens to be.
 */
export function findProjectRoot(startDir: string): string | null {
  // ~/.ultrateam is the GLOBAL data dir (index.db, projects.json), not a
  // project store — the home directory can never be a project root.
  const home = path.resolve(os.homedir());
  let dir = path.resolve(startDir);
  let gitRoot: string | null = null;
  for (;;) {
    const isInstall = isUltrateamInstallDirectory(dir, home);
    if (dir !== home && !isInstall && fs.existsSync(path.join(dir, STORE_DIR))) return dir;
    if (!gitRoot && !isInstall && fs.existsSync(path.join(dir, '.git'))) gitRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) return gitRoot;
    dir = parent;
  }
}

export function entriesPath(root: string): string {
  return path.join(root, STORE_DIR, ENTRIES_FILE);
}

export function appendEntry(root: string, entry: Entry): void {
  if (isUltrateamInstallDirectory(root)) {
    throw new Error('Refusing to write project history inside the ultrateam installation directory.');
  }
  fs.mkdirSync(path.join(root, STORE_DIR), { recursive: true });
  fs.appendFileSync(entriesPath(root), JSON.stringify(entry) + '\n', 'utf8');
}

export interface ReadResult {
  entries: Entry[];
  /** Number of lines that failed to parse (corrupt or from a future schema). */
  skipped: number;
}

/**
 * Fold one checkout's store into another (a throwaway worktree/clone into its
 * durable home): append entries the target doesn't have, then remove the
 * source store so the migration is one-shot. When the source has unparseable
 * lines, the good entries are copied but the source file is kept — never
 * destroy bytes that could not be carried over. Returns entries moved.
 */
export function migrateStoreTo(fromRoot: string, toRoot: string): number {
  const canon = (p: string): string => {
    const resolved = path.resolve(p);
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  const from = path.resolve(fromRoot);
  const to = path.resolve(toRoot);
  // Realpath equality guard: the same directory reached via a symlink alias
  // (/var vs /private/var) must be a no-op, or we would delete the very store
  // we "migrated" into itself.
  if (canon(from) === canon(to)) return 0;
  const source = readEntries(from);
  if (source.entries.length > 0) {
    const existing = new Set(readEntries(to).entries.map((e) => e.id));
    for (const entry of source.entries) {
      if (!existing.has(entry.id)) appendEntry(to, entry);
    }
  }
  if (source.skipped === 0) {
    fs.rmSync(path.join(from, STORE_DIR), { recursive: true, force: true });
  }
  return source.entries.length;
}

export function readEntries(root: string): ReadResult {
  const file = entriesPath(root);
  if (!fs.existsSync(file)) return { entries: [], skipped: 0 };
  const lines = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const entries: Entry[] = [];
  let skipped = 0;
  for (const line of lines) {
    const entry = parseEntryLine(line);
    if (entry) entries.push(entry);
    else skipped++;
  }
  return { entries, skipped };
}

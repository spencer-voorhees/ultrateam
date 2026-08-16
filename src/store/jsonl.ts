// The JSONL layer is the source of truth: one append-only file per project at
// <project>/.ultrateam/entries.jsonl. The SQLite index (db.ts) is derived from
// it and can always be rebuilt.

import fs from 'node:fs';
import path from 'node:path';
import { type Entry, parseEntryLine } from '../schema.js';

export const STORE_DIR = '.ultrateam';
export const ENTRIES_FILE = 'entries.jsonl';

/**
 * Walk upward from startDir looking for a directory containing `.ultrateam/`.
 * Falls back to the nearest git root so first-time use lands entries at the
 * repo root rather than wherever the agent's cwd happens to be.
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  let gitRoot: string | null = null;
  for (;;) {
    if (fs.existsSync(path.join(dir, STORE_DIR))) return dir;
    if (!gitRoot && fs.existsSync(path.join(dir, '.git'))) gitRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) return gitRoot;
    dir = parent;
  }
}

export function entriesPath(root: string): string {
  return path.join(root, STORE_DIR, ENTRIES_FILE);
}

export function appendEntry(root: string, entry: Entry): void {
  fs.mkdirSync(path.join(root, STORE_DIR), { recursive: true });
  fs.appendFileSync(entriesPath(root), JSON.stringify(entry) + '\n', 'utf8');
}

export interface ReadResult {
  entries: Entry[];
  /** Number of lines that failed to parse (corrupt or from a future schema). */
  skipped: number;
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

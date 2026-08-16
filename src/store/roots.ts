// Registry of every project root that has ever been indexed, kept OUTSIDE the
// derived SQLite index so `reindex --all` can rebuild a deleted index.db from
// scratch. Plain JSON: same lowest-common-denominator rationale as the JSONL.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultRootsPath(): string {
  return path.join(os.homedir(), '.ultrateam', 'projects.json');
}

export function knownRoots(file: string = defaultRootsPath()): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function registerRoot(root: string, file: string = defaultRootsPath()): void {
  const resolved = path.resolve(root);
  const roots = knownRoots(file);
  if (roots.includes(resolved)) return;
  roots.push(resolved);
  roots.sort();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(roots, null, 2) + '\n', 'utf8');
}

export function unregisterRoot(root: string, file: string = defaultRootsPath()): void {
  const resolved = path.resolve(root);
  const roots = knownRoots(file).filter((r) => r !== resolved);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(roots, null, 2) + '\n', 'utf8');
}

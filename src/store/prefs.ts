// Per-machine workspace presentation prefs (display name, folder color), keyed
// by workspace id. Pure render-time overlay: the JSONL memory is never touched,
// deleting this file just restores recorded names. Plain JSON like projects.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WORKSPACE_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
] as const;
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

export interface WorkspacePrefs {
  color?: WorkspaceColor;
  hidden?: boolean;
}

export function defaultPrefsPath(): string {
  return path.join(os.homedir(), '.ultrateam', 'workspace-prefs.json');
}

export function readAllPrefs(file: string = defaultPrefsPath()): Record<string, WorkspacePrefs> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, WorkspacePrefs> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue;
      const { color, hidden } = value as Record<string, unknown>;
      const prefs: WorkspacePrefs = {};
      if (typeof color === 'string' && (WORKSPACE_COLORS as readonly string[]).includes(color)) {
        prefs.color = color as WorkspaceColor;
      }
      if (hidden === true) prefs.hidden = true;
      if (prefs.color !== undefined || prefs.hidden !== undefined) out[id] = prefs;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge one workspace's prefs (folder color, hidden) and persist. A null field
 * clears that override; a workspace with nothing left is dropped from the
 * file. Returns the updated map, or null when the update is invalid.
 */
export function updatePrefs(
  id: string,
  update: { color?: string | null; hidden?: boolean | null },
  file: string = defaultPrefsPath(),
): Record<string, WorkspacePrefs> | null {
  if (typeof id !== 'string' || id.trim() === '' || id.length > 200) return null;
  const all = readAllPrefs(file);
  const prefs: WorkspacePrefs = { ...all[id] };

  if (update.color !== undefined) {
    if (update.color === null) {
      delete prefs.color;
    } else if (typeof update.color === 'string' && (WORKSPACE_COLORS as readonly string[]).includes(update.color)) {
      prefs.color = update.color as WorkspaceColor;
    } else {
      return null;
    }
  }
  if (update.hidden !== undefined) {
    if (update.hidden === true) prefs.hidden = true;
    else if (update.hidden === false || update.hidden === null) delete prefs.hidden;
    else return null;
  }

  if (prefs.color === undefined && prefs.hidden === undefined) delete all[id];
  else all[id] = prefs;

  // Atomic write so a crash never truncates the prefs file.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return all;
}

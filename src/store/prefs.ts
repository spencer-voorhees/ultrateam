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
  name?: string;
  color?: WorkspaceColor;
}

const MAX_NAME_LENGTH = 60;

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
      const prefs: WorkspacePrefs = {};
      const { name, color } = value as Record<string, unknown>;
      if (typeof name === 'string' && name.trim() !== '') prefs.name = name.trim().slice(0, MAX_NAME_LENGTH);
      if (typeof color === 'string' && (WORKSPACE_COLORS as readonly string[]).includes(color)) {
        prefs.color = color as WorkspaceColor;
      }
      if (prefs.name !== undefined || prefs.color !== undefined) out[id] = prefs;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge one workspace's prefs and persist. `name: null`/`color: null` clears
 * that override; a workspace with nothing left is dropped from the file.
 * Returns the updated map, or null when the update is invalid.
 */
export function updatePrefs(
  id: string,
  update: { name?: string | null; color?: string | null },
  file: string = defaultPrefsPath(),
): Record<string, WorkspacePrefs> | null {
  if (typeof id !== 'string' || id.trim() === '' || id.length > 200) return null;
  const all = readAllPrefs(file);
  const prefs: WorkspacePrefs = { ...all[id] };

  if (update.name !== undefined) {
    if (update.name === null || (typeof update.name === 'string' && update.name.trim() === '')) {
      delete prefs.name;
    } else if (typeof update.name === 'string') {
      prefs.name = update.name.trim().slice(0, MAX_NAME_LENGTH);
    } else {
      return null;
    }
  }
  if (update.color !== undefined) {
    if (update.color === null) {
      delete prefs.color;
    } else if (typeof update.color === 'string' && (WORKSPACE_COLORS as readonly string[]).includes(update.color)) {
      prefs.color = update.color as WorkspaceColor;
    } else {
      return null;
    }
  }

  if (prefs.name === undefined && prefs.color === undefined) delete all[id];
  else all[id] = prefs;

  // Atomic write so a crash never truncates the prefs file.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return all;
}

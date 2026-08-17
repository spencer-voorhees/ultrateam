import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type WorkspaceIdentitySource = 'explicit' | 'remote' | 'git-dir' | 'path';

export interface WorkspaceIdentity {
  id: string;
  source: WorkspaceIdentitySource;
}

function git(root: string, args: string[]): string | null {
  try {
    const value = execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .toString()
      .trim();
    return value || null;
  } catch {
    return null;
  }
}

function stableId(value: string): string {
  return `ws:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Normalize common HTTPS, SSH, SCP-style, and filesystem Git remotes. */
export function normalizeGitRemote(remote: string, root: string): string {
  const value = remote.trim();
  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
    return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')}`;
  }

  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      return `file:${canonicalPath(url.pathname).replace(/\.git$/i, '')}`;
    }
    const repoPath = decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '');
    return `${url.host.toLowerCase()}/${repoPath}`;
  } catch {
    return `file:${canonicalPath(path.resolve(root, value)).replace(/\.git$/i, '')}`;
  }
}

/**
 * Resolve a checkout to a stable logical workspace without relying on its
 * folder name. Remotes unify independent clones; the common Git directory
 * unifies worktrees; an absolute path is the conservative non-Git fallback.
 */
export function workspaceIdentity(root: string): WorkspaceIdentity {
  const resolvedRoot = canonicalPath(root);
  const explicit = git(resolvedRoot, ['config', '--get', 'ultrateam.workspaceId']);
  if (explicit) return { id: stableId(`explicit:${explicit}`), source: 'explicit' };

  const remotes = git(resolvedRoot, ['remote'])?.split(/\r?\n/).filter(Boolean) ?? [];
  const remoteName = remotes.includes('origin') ? 'origin' : remotes.sort()[0];
  if (remoteName) {
    const remote = git(resolvedRoot, ['remote', 'get-url', remoteName]);
    if (remote) {
      return { id: stableId(`remote:${normalizeGitRemote(remote, resolvedRoot)}`), source: 'remote' };
    }
  }

  const commonDir = git(resolvedRoot, ['rev-parse', '--git-common-dir']);
  if (commonDir) {
    return {
      id: stableId(`git-dir:${canonicalPath(path.resolve(resolvedRoot, commonDir))}`),
      source: 'git-dir',
    };
  }

  return { id: stableId(`path:${resolvedRoot}`), source: 'path' };
}

export function isWorkspaceId(value: string): boolean {
  return /^ws:[0-9a-f]{24}$/.test(value);
}

/** Return every registered root that belongs to the same logical workspace. */
export function rootsInWorkspace(root: string, candidates: string[]): string[] {
  const targetId = workspaceIdentity(root).id;
  return [...new Set([root, ...candidates].map((candidate) => path.resolve(candidate)))]
    .filter((candidate) => workspaceIdentity(candidate).id === targetId)
    .sort();
}

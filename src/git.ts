import { execFileSync } from 'node:child_process';
import type { GitState } from './schema.js';

function git(cwd: string, args: string[]): string | null {
  try {
    // Preserve leading spaces: porcelain status uses its first two columns for
    // index/worktree state, including a meaningful leading blank.
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).toString().trimEnd();
  } catch {
    return null;
  }
}

export function currentBranch(cwd: string): string | null {
  const out = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return out === 'HEAD' || out === '' ? null : out;
}

/** Snapshot portable Git facts at checkpoint time; paths are repo-relative. */
export function captureGitState(cwd: string): GitState | undefined {
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const status = git(cwd, ['status', '--porcelain=v1', '-uall']);
  if (head === null && status === null) return undefined;
  const changedFiles = (status ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((file) => file.includes(' -> ') ? file.split(' -> ').at(-1) as string : file);
  return {
    branch: currentBranch(cwd),
    head: head || null,
    dirty: changedFiles.length > 0,
    changed_files: changedFiles,
  };
}

import { execFileSync } from 'node:child_process';

export function currentBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out === 'HEAD' || out === '' ? null : out;
  } catch {
    return null;
  }
}

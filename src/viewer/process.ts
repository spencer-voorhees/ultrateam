import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export type ViewerMode = 'background' | 'foreground';

export interface ViewerState {
  version: 1;
  instanceId: string;
  pid: number;
  port: number;
  url: string;
  mode: ViewerMode;
  cwd: string;
  startedAt: string;
}

interface ViewerHealth {
  app: 'ultrateam';
  instanceId: string;
  pid: number;
}

const HEALTH_TIMEOUT_MS = 1000;

export function defaultViewerStatePath(): string {
  return process.env.ULTRATEAM_VIEWER_STATE_PATH ?? path.join(os.homedir(), '.ultrateam', 'viewer.json');
}

export function defaultViewerLogPath(): string {
  return process.env.ULTRATEAM_VIEWER_LOG_PATH ?? path.join(os.homedir(), '.ultrateam', 'viewer.log');
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function isViewerState(value: unknown): value is ViewerState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    typeof state.instanceId === 'string' &&
    state.instanceId.length > 0 &&
    Number.isInteger(state.pid) &&
    (state.pid as number) > 0 &&
    Number.isInteger(state.port) &&
    (state.port as number) > 0 &&
    typeof state.url === 'string' &&
    isLoopbackUrl(state.url) &&
    (state.mode === 'background' || state.mode === 'foreground') &&
    typeof state.cwd === 'string' &&
    typeof state.startedAt === 'string'
  );
}

export function readViewerState(file: string = defaultViewerStatePath()): ViewerState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isViewerState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeViewerState(state: ViewerState, file: string = defaultViewerStatePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = JSON.stringify(state, null, 2) + '\n';
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // Windows NTFS fallback when renameSync encounters lock or permission differences
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {}
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  }
}

export function removeViewerState(
  instanceId?: string,
  file: string = defaultViewerStatePath(),
): void {
  if (instanceId) {
    const state = readViewerState(file);
    if (state && state.instanceId !== instanceId) return;
  }
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function viewerHealth(state: ViewerState, timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<ViewerHealth | null> {
  return new Promise((resolve) => {
    const request = http.get(`${state.url}/api/health`, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (body.length <= 4096) body += chunk;
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body) as Partial<ViewerHealth>;
          resolve(
            health.app === 'ultrateam' &&
              health.instanceId === state.instanceId &&
              health.pid === state.pid
              ? (health as ViewerHealth)
              : null,
          );
        } catch {
          resolve(null);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

export async function runningViewer(
  file: string = defaultViewerStatePath(),
): Promise<ViewerState | null> {
  const state = readViewerState(file);
  if (!state) return null;
  if (await viewerHealth(state)) return state;
  removeViewerState(state.instanceId, file);
  return null;
}

/**
 * Probe a port directly for a healthy ultrateam viewer, independent of the
 * state file. A viewer can outlive its viewer.json (crashed starter, state
 * clobbered by a racing instance); its health endpoint still identifies it,
 * so the CLI can re-adopt the orphan instead of starting a shadow instance
 * on a fallback port.
 */
export async function probeViewer(port: number): Promise<ViewerState | null> {
  const url = `http://127.0.0.1:${port}`;
  const health = await new Promise<ViewerHealth | null>((resolve) => {
    const request = http.get(`${url}/api/health`, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (body.length <= 4096) body += chunk;
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body) as Partial<ViewerHealth>;
          resolve(
            parsed.app === 'ultrateam' && typeof parsed.instanceId === 'string' && parsed.instanceId.length > 0
              && Number.isInteger(parsed.pid) && (parsed.pid as number) > 0
              ? (parsed as ViewerHealth)
              : null,
          );
        } catch {
          resolve(null);
        }
      });
    });
    request.setTimeout(HEALTH_TIMEOUT_MS, () => request.destroy());
    request.on('error', () => resolve(null));
  });
  if (!health) return null;
  return {
    version: 1,
    instanceId: health.instanceId,
    pid: health.pid,
    port,
    url,
    mode: 'background',
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
}

export async function waitForViewer(
  instanceId: string,
  file: string = defaultViewerStatePath(),
  timeoutMs: number = 6000,
): Promise<ViewerState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readViewerState(file);
    // Success is "a healthy viewer exists", not "MY child won". Two `view`
    // invocations can race (the app auto-start plus a manual run); both
    // children bind — one on the requested port, one on the fallback — and
    // both write this single state file. Whoever loses the write must adopt
    // the winner instead of reporting a failure while a perfectly good
    // viewer is running.
    if (state && (await viewerHealth(state))) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/**
 * Best-effort serialization of concurrent starts: the first invocation claims
 * the lock and spawns; racers see a fresh lock and just wait for the winner's
 * viewer instead of spawning a second child. Stale locks (crashed starter)
 * expire quickly.
 */
export function claimStartLock(file: string = defaultViewerStatePath()): boolean {
  const lock = `${file}.start-lock`;
  try {
    const stat = fs.statSync(lock);
    if (Date.now() - stat.mtimeMs < 10_000) return false;
    fs.unlinkSync(lock);
  } catch {
    // No lock (or unreadable/stale) — try to claim it.
  }
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function releaseStartLock(file: string = defaultViewerStatePath()): void {
  try {
    fs.unlinkSync(`${file}.start-lock`);
  } catch {
    // Already gone.
  }
}

export async function stopViewer(
  state: ViewerState,
  file: string = defaultViewerStatePath(),
): Promise<void> {
  if (!(await viewerHealth(state))) {
    removeViewerState(state.instanceId, file);
    return;
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      try { process.kill(state.pid, 'SIGKILL'); } catch {}
    }
  } else {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && processIsAlive(state.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processIsAlive(state.pid)) {
      try { process.kill(state.pid, 'SIGKILL'); } catch {}
    }
  }
  removeViewerState(state.instanceId, file);
}

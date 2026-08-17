import { execSync } from 'node:child_process';
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

export async function waitForViewer(
  instanceId: string,
  file: string = defaultViewerStatePath(),
  timeoutMs: number = 6000,
): Promise<ViewerState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readViewerState(file);
    if (state?.instanceId === instanceId && (await viewerHealth(state))) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
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
      execSync(`taskkill /PID ${state.pid} /T /F`, { stdio: 'ignore' });
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


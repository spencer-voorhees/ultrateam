import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface UninstallPlanOptions {
  home?: string;
  packageRoot: string;
  npmPrefix?: string | null;
  appData?: string | null;
  installHome?: string | null;
}

function uniqueResolved(paths: string[]): string[] {
  return [...new Set(paths.map((value) => path.resolve(value)))];
}

/** Exact, bounded paths owned by ultrateam. Project-local histories are excluded. */
export function uninstallTargets(opts: UninstallPlanOptions): string[] {
  const home = path.resolve(opts.home ?? os.homedir());
  const packageRoot = path.resolve(opts.packageRoot);
  const defaultInstall = path.join(home, '.ultrateam-app');
  const configuredInstall = opts.installHome ? path.resolve(opts.installHome) : defaultInstall;
  const targets = [path.join(home, '.ultrateam')];

  // The default installer directory is always ours. A custom ULTRATEAM_HOME is
  // only removed when this running CLI actually lives inside it.
  if (fs.existsSync(defaultInstall) || packageRoot === defaultInstall) targets.push(defaultInstall);
  if (
    configuredInstall !== defaultInstall &&
    (packageRoot === configuredInstall || packageRoot.startsWith(`${configuredInstall}${path.sep}`))
  ) {
    targets.push(configuredInstall);
  }

  const shimRoots = [
    ...(opts.npmPrefix ? [opts.npmPrefix, path.join(opts.npmPrefix, 'bin')] : []),
    ...(opts.appData ? [path.join(opts.appData, 'npm')] : []),
  ];
  for (const root of shimRoots) {
    for (const name of ['ultrateam', 'ultrateam.cmd', 'ultrateam.ps1']) {
      targets.push(path.join(root, name));
    }
  }
  if (opts.npmPrefix) {
    targets.push(path.join(opts.npmPrefix, 'node_modules', 'ultrateam'));
    targets.push(path.join(opts.npmPrefix, 'lib', 'node_modules', 'ultrateam'));
  }

  return uniqueResolved(targets).filter((target) => {
    const parsedRoot = path.parse(target).root;
    return target !== parsedRoot && target !== home;
  });
}

export function npmPrefix(): string | null {
  try {
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm config get prefix']
      : ['config', 'get', 'prefix'];
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

export function shouldUnlinkBeforeExit(platform: NodeJS.Platform = process.platform): boolean {
  // On Windows the CLI itself is running underneath ultrateam.cmd. Removing
  // that shim before Node returns makes cmd.exe report "The batch file could
  // not be found" when it tries to resume the launcher.
  return platform !== 'win32';
}

export function unlinkGlobalCommand(): void {
  if (!shouldUnlinkBeforeExit()) return;
  try {
    execFileSync('npm', ['unlink', '-g', 'ultrateam'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // The detached cleanup also removes known shim paths. A missing or broken
    // npm installation should not prevent the app/data uninstall.
  }
}

/**
 * A separate Node process waits for this CLI to exit before removing the app
 * directory. This avoids Windows file/cwd locks and does not open a shell.
 */
export function scheduleRemoval(targets: string[], parentPid: number = process.pid): void {
  const helper = path.join(
    os.tmpdir(),
    `ultrateam-uninstall-${parentPid}-${Date.now()}.mjs`,
  );
  const source = `
import fs from 'node:fs';
const parentPid = Number(process.argv[2]);
const targets = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  try { process.kill(parentPid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); }
  catch { break; }
}
// On Windows, cmd.exe still has to resume ultrateam.cmd after the Node child
// exits. Give the launcher time to return before deleting its batch file.
await new Promise((resolve) => setTimeout(resolve, 1000));
for (const target of targets) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}
try { fs.rmSync(new URL(import.meta.url)); } catch {}
`;
  fs.writeFileSync(helper, source, { encoding: 'utf8', mode: 0o600 });
  const payload = Buffer.from(JSON.stringify(targets), 'utf8').toString('base64url');
  try {
    const child = spawn(process.execPath, [helper, String(parentPid), payload], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!child.pid) throw new Error('cleanup process did not start');
    child.unref();
  } catch (err) {
    try { fs.rmSync(helper, { force: true }); } catch {}
    throw err;
  }
}

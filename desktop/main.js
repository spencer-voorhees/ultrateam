// ultrateam desktop: a menu bar (macOS) / tray (Windows) shell around the same
// core the CLI installs. The app never reimplements the viewer or server — it
// supervises the CLI's own `view` lifecycle, using Electron's bundled Node so
// users need no Node install. If a CLI-started viewer is already running, the
// app adopts it and leaves it alive on quit; a viewer the app spawned dies with
// the app.

import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell, utilityProcess } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Packaged: the built core (dist + production node_modules) travels in
// resources/core. Dev (`npm start` in desktop/): use the repo's own build.
const CORE_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'core')
  : path.join(__dirname, '..');
const CLI_JS = path.join(CORE_ROOT, 'dist', 'cli.js');

const VIEWER_STATE_PATH = path.join(os.homedir(), '.ultrateam', 'viewer.json');
const DEFAULT_PORT = 4272;
const HEALTH_TIMEOUT_MS = 1000;

let tray = null;
let win = null;
let viewerUrl = null;
let ownedViewer = null; // utilityProcess we spawned; null when adopting a CLI viewer
let statusLine = 'Starting…';

// ---------------------------------------------------------------------------
// Viewer discovery — mirrors src/viewer/process.ts (state file + health check).

function readViewerState() {
  try {
    const state = JSON.parse(fs.readFileSync(VIEWER_STATE_PATH, 'utf8'));
    if (state && state.version === 1 && typeof state.url === 'string') return state;
  } catch {
    // missing or corrupt state file — treated as "not running"
  }
  return null;
}

async function healthyViewer() {
  const state = readViewerState();
  if (!state) return null;
  try {
    const res = await fetch(`${state.url}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = await res.json();
    if (body && body.app === 'ultrateam' && body.instanceId === state.instanceId) return state;
  } catch {
    // stale state file; the CLI clears it on its next `view` call
  }
  return null;
}

function waitForOwnViewer(instanceId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      const state = readViewerState();
      if (state && state.instanceId === instanceId) return resolve(state);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(poll, 150);
    };
    poll();
  });
}

async function ensureViewer() {
  const existing = await healthyViewer();
  if (existing) {
    viewerUrl = existing.url;
    statusLine = `Viewer at ${existing.url} (shared with CLI)`;
    return;
  }
  const instanceId = randomUUID();
  // MODE=background turns on the CLI's port fallback, so a busy 4272 is fine.
  ownedViewer = utilityProcess.fork(CLI_JS, ['view', '--foreground', '--no-open', '--port', String(DEFAULT_PORT)], {
    env: {
      ...process.env,
      ULTRATEAM_VIEWER_INSTANCE_ID: instanceId,
      ULTRATEAM_VIEWER_MODE: 'background',
    },
    stdio: 'ignore',
  });
  ownedViewer.on('exit', () => {
    ownedViewer = null;
    if (!app.isQuittingUltrateam) {
      statusLine = 'Viewer stopped — reopen the window to restart it';
      refreshTrayMenu();
    }
  });
  const state = await waitForOwnViewer(instanceId);
  if (state) {
    viewerUrl = state.url;
    statusLine = `Viewer at ${state.url}`;
  } else {
    statusLine = 'Viewer failed to start — see Run doctor';
  }
}

// ---------------------------------------------------------------------------
// Window + tray

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    title: 'ultrateam',
    show: false,
    backgroundColor: '#212121',
  });
  win.on('close', (event) => {
    // Menu bar app semantics: closing hides; Quit lives in the tray menu.
    if (!app.isQuittingUltrateam) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

async function showWindow() {
  if (!viewerUrl || !(await healthyViewer())) await ensureViewer();
  refreshTrayMenu();
  if (!viewerUrl) return;
  if (!win) createWindow();
  if (win.webContents.getURL() !== `${viewerUrl}/`) await win.loadURL(viewerUrl);
  win.show();
  win.focus();
}

function runDoctor() {
  const child = utilityProcess.fork(CLI_JS, ['doctor'], { stdio: 'pipe' });
  let out = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });
  child.on('exit', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'ultrateam doctor',
      message: 'ultrateam doctor',
      detail: out.trim() || 'doctor produced no output.',
      buttons: ['OK'],
    });
  });
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open ultrateam', click: () => { void showWindow(); } },
    {
      label: 'Open in Browser',
      enabled: Boolean(viewerUrl),
      click: () => { if (viewerUrl) void shell.openExternal(viewerUrl); },
    },
    { type: 'separator' },
    { label: statusLine, enabled: false },
    { type: 'separator' },
    { label: 'Run doctor', click: runDoctor },
    { type: 'separator' },
    { label: 'Quit ultrateam', click: () => { app.isQuittingUltrateam = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true); // macOS tints it for light/dark menu bars; harmless on Windows
  tray = new Tray(icon);
  tray.setToolTip('ultrateam — shared memory for every coding agent');
  refreshTrayMenu();
  // Windows convention: primary click opens the app, menu on right-click.
  if (process.platform === 'win32') tray.on('click', () => { void showWindow(); });
}

// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { void showWindow(); });

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock.hide(); // pure menu bar app
    if (!fs.existsSync(CLI_JS)) {
      statusLine = 'Core missing — reinstall the app';
      dialog.showErrorBox('ultrateam', `The bundled core was not found at ${CLI_JS}.`);
    }
    createTray();
    await showWindow();
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray on every platform; Quit is explicit.
  });

  app.on('before-quit', () => {
    app.isQuittingUltrateam = true;
    // SIGTERM lets the CLI clean up its viewer state file; adopted viewers live on.
    ownedViewer?.kill();
  });
}

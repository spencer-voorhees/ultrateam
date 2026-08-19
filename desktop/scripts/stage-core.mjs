// Stage the ultrateam core (built dist + production node_modules) into
// desktop/core-staging, which electron-builder ships as resources/core.
// Run from desktop/ after building the repo root.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(desktopDir);
const staging = path.join(desktopDir, 'core-staging');

const dist = path.join(repoRoot, 'dist');
if (!fs.existsSync(path.join(dist, 'cli.js'))) {
  console.error('dist/cli.js missing — run `npm run build` in the repo root first.');
  process.exit(1);
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.cpSync(dist, path.join(staging, 'dist'), { recursive: true });
for (const f of ['package.json', 'package-lock.json']) {
  fs.copyFileSync(path.join(repoRoot, f), path.join(staging, f));
}
// --ignore-scripts: the repo's `prepare` hook builds with tsc, which isn't
// present (or needed) in staging — dist/ is copied in prebuilt.
execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent', { cwd: staging, stdio: 'inherit' });
// npm artifacts the app never needs at runtime
fs.rmSync(path.join(staging, 'package-lock.json'), { force: true });
console.log(`staged core at ${staging}`);

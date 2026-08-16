import { mkdirSync, copyFileSync } from 'node:fs';

mkdirSync(new URL('../dist/viewer/', import.meta.url), { recursive: true });
copyFileSync(
  new URL('../src/viewer/index.html', import.meta.url),
  new URL('../dist/viewer/index.html', import.meta.url),
);

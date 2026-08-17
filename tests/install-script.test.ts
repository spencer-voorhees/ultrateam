import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

test('Windows installer restores the caller PowerShell location', () => {
  const script = fs.readFileSync(
    fileURLToPath(new URL('../install.ps1', import.meta.url)),
    'utf8',
  );
  assert.match(script, /Push-Location \$dir/);
  assert.match(script, /finally\s*\{\s*Pop-Location\s*\}/s);
});

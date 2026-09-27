import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Vercel runtime options allow the sanitizer to load without the tsx loader', () => {
  const root = new URL('../', import.meta.url);
  const config = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8'));
  // A fresh process exercises Node's actual CJS/ESM interop, which tsx can mask.
  // Apply Vercel's disabled default first, then our deployment override.
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const sanitize = require('sanitize-html');
    assert.equal(sanitize('<p onclick="bad()">Safe<script>bad()</script></p>'), '<p>Safe</p>');
  `], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--no-experimental-require-module ${config.env?.NODE_OPTIONS ?? ''}` },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

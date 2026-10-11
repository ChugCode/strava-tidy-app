import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every service-worker precache entry exists on disk', () => {
  const sw = readFileSync(root + 'sw.js', 'utf8');
  const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(sw)[1];
  const entries = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(entries.length > 10);
  for (const e of entries) {
    const rel = e === './' ? 'index.html' : e;
    assert.ok(existsSync(root + rel), `missing precache file: ${e}`);
  }
});

test('manifest icons exist', () => {
  const m = JSON.parse(readFileSync(root + 'manifest.webmanifest', 'utf8'));
  for (const i of m.icons) assert.ok(existsSync(root + i.src), i.src);
});

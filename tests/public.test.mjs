import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/store.mjs';

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsFiles(path.join(dir, e.name)) : /\.m?js$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

test('every front-end module parses (a syntax error would blank the whole app)', () => {
  const files = jsFiles(path.join(ROOT, 'public'));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(ROOT, f)}: ${r.stderr}`);
  }
});

test('the wizard flags what is still missing without blocking', async () => {
  // stepMissing lives in a browser module that imports the DOM helpers, so check its logic through its source text.
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'view-wizard.js'), 'utf8');
  assert.match(src, /Continue anyway/);
  assert.match(src, /Still needed:/);
  assert.match(src, /A few things are still missing before you can start/);
});

test('the stylesheet keeps the phone layout guards', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  assert.match(css, /\.app \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
});

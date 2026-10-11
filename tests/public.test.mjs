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

test('the requirements step offers the one-click install and sign-in, and the Chrome extension stays manual', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'components.js'), 'utf8');
  assert.match(src, /label: 'Install Claude Code'/);
  assert.match(src, /label: 'Sign in to Claude'/);
  assert.match(src, /Run the installer/, 'the confirm dialog has its own button');
  assert.match(src, /c\.display/, 'the dialog shows the exact command');
  assert.match(src, /label: 'Get the extension'/);
  assert.match(src, /'Test connection'/);
  assert.doesNotMatch(src, /innerHTML/);
});

test('emailed-code holds are shown as "enter it yourself", not as a question to answer', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'view-input.js'), 'utf8');
  assert.match(src, /verification code/);
  assert.match(src, /Open the posting/);
  assert.match(src, /agents never read your email/i);
});

test('the page sends the per-launch token on every request and no inline script is needed', () => {
  const api = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8');
  assert.match(api, /x-cja-token/);
  assert.match(api, /meta\[name="cja-token"\]/);
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /<meta name="cja-token" content="__CJA_TOKEN__">/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
});

test('the launchers check for the whole download and pass real exit codes', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'Start.bat'), 'utf8');
  assert.match(bat, /if not exist "%~dp0server\.mjs"/);
  assert.match(bat, /exit \/b %RC%/);
  assert.match(fs.readFileSync(path.join(ROOT, 'start.sh'), 'utf8'), /\[ ! -f server\.mjs \]/);
  assert.match(fs.readFileSync(path.join(ROOT, 'start.command'), 'utf8'), /\[ ! -f server\.mjs \]/);
});

test('CI runs on Node 18, 20 and 22', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'tests.yml'), 'utf8');
  assert.match(yml, /node: \[18, 20, 22\]/);
});

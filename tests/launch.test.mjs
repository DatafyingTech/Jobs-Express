import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { tempStore } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function boot(extra = {}) {
  const t = tempStore();
  const app = createApp({ store: t.store, preflight: async () => ({ rows: [], ready: true }), ...extra });
  const port = await app.listen(0);
  const raw = (method, p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.end();
  });
  return { ...t, app, port, raw, close: async () => { await app.close(); t.cleanup(); } };
}
const cookieOf = (res) => [].concat(res.headers['set-cookie'] || []).join(';');

test('a bare GET of the page carries no secret: not in the HTML, not in a cookie', async () => {
  const s = await boot();
  for (const p of ['/', '/?demo=1', '/anything/else', '/index.html']) {
    const page = await s.raw('GET', p);
    assert.equal(page.status, 200, p);
    assert.ok(!page.text.includes(s.app.token), `token leaked in ${p}`);
    assert.doesNotMatch(page.text, /cja-token|__CJA_TOKEN__/);
    assert.equal(page.headers['set-cookie'], undefined, `${p} must not set a cookie`);
  }
  // Another program on this computer learns nothing it can use.
  const page = await s.raw('GET', '/');
  const state = await s.raw('GET', '/api/state');
  assert.equal(state.status, 403);
  assert.equal(state.json.code, 'token');
  assert.match(state.json.error, /not opened by Jobs Express/);
  assert.equal((await s.raw('POST', '/api/run/start', { 'x-cja': '1', origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' })).status, 403);
  void page;
  await s.close();
});

test('the one-time launch link sets the HttpOnly cookie, works once, and redirects to the plain page', async () => {
  const used = [];
  const s = await boot({ onLaunch: () => used.push(1) });
  const code = s.app.issueLaunchCode();
  assert.match(code, /^[0-9a-f]{48}$/);
  const first = await s.raw('GET', `/?launch=${code}`);
  assert.equal(first.status, 302);
  assert.equal(first.headers.location, '/');
  const cookie = cookieOf(first);
  assert.match(cookie, new RegExp(`cja_token=${s.app.token}`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.headers['referrer-policy'], 'no-referrer');
  assert.equal(used.length, 1, 'the launcher is told the code was used, so it can issue the next one');
  // The cookie works, and the code does not work a second time.
  assert.equal((await s.raw('GET', '/api/state', { cookie: `cja_token=${s.app.token}` })).status, 200);
  const again = await s.raw('GET', `/?launch=${code}`);
  assert.equal(again.status, 302);
  assert.equal(again.headers['set-cookie'], undefined);
  assert.equal(used.length, 1);
  for (const bad of ['', 'nope', code.slice(0, 10), '../x', code.toUpperCase()]) {
    const r = await s.raw('GET', `/?launch=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers['set-cookie'], undefined, `"${bad}" must not log anyone in`);
  }
  // The demo flag survives the redirect.
  const demo = await s.raw('GET', `/?launch=${s.app.issueLaunchCode()}&demo=1`);
  assert.equal(demo.headers.location, '/?demo=1');
  // A fresh code every time, and only a handful outstanding.
  const codes = new Set(Array.from({ length: 10 }, () => s.app.issueLaunchCode()));
  assert.equal(codes.size, 10);
  const oldest = [...codes][0];
  assert.equal((await s.raw('GET', `/?launch=${oldest}`)).headers['set-cookie'], undefined, 'old unused codes are retired');
  await s.close();
});

test('the page request alone never creates a sample-data folder', async () => {
  const s = await boot();
  const before = fs.readdirSync(path.dirname(s.dir)).filter((n) => n.startsWith('cja-demo-')).length;
  for (let i = 0; i < 3; i++) await s.raw('GET', '/?demo=1');
  await s.raw('GET', '/api/state?demo=1');
  const after = fs.readdirSync(path.dirname(s.dir)).filter((n) => n.startsWith('cja-demo-')).length;
  assert.equal(after, before, 'only a request that holds the session may start the sample world');
  await s.close();
});

test('/api/health tells strangers only that the app is there: the data folder needs the session', async () => {
  const s = await boot();
  const anon = await s.raw('GET', '/api/health');
  assert.equal(anon.status, 200);
  assert.equal(anon.json.app, 'jobs-express');
  assert.equal(anon.json.dataDir, undefined);
  assert.ok(!anon.text.includes(s.dir));
  const authed = await s.raw('GET', '/api/health', { cookie: `cja_token=${s.app.token}` });
  assert.equal(authed.json.dataDir, s.dir);
  await s.close();
});

// --- the real thing: start the server, then start it again ----------------------------------------------------

test('a second launch opens the running copy through a one-time code in a private file', async () => {
  const { dir, cleanup } = tempStore();
  const port = 4800 + (process.pid % 150);
  const env = { ...process.env, CJA_DATA_DIR: dir, CJA_NO_OPEN: '1' };
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port)], { env, stdio: 'pipe' });
  let out = '';
  srv.stdout.on('data', (d) => (out += d));
  srv.stderr.on('data', (d) => (out += d));
  try {
    const t0 = Date.now();
    while (!/Running at (http:\/\/127\.0\.0\.1:\d+\/\?launch=[0-9a-f]+)/.test(out)) {
      if (Date.now() - t0 > 15000) throw new Error('server did not start: ' + out);
      await new Promise((r) => setTimeout(r, 50));
    }
    const first = /Running at (http:\/\/127\.0\.0\.1:(\d+)\/\?launch=([0-9a-f]+))/.exec(out);
    const base = `http://127.0.0.1:${first[2]}`;
    // The file for second launches exists and holds a DIFFERENT code from the one the browser was given.
    const file = path.join(dir, '.launch');
    const rec1 = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rec1.pid, srv.pid);
    assert.equal(rec1.port, Number(first[2]));
    assert.notEqual(rec1.code, first[3]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // No credentials, no luck.
    const bare = await fetch(`${base}/`);
    assert.ok(!(await bare.text()).includes(rec1.code));
    assert.equal((await fetch(`${base}/api/state`)).status, 403);
    // The browser's own link works once.
    const used = await fetch(`${base}/?launch=${first[3]}`, { redirect: 'manual' });
    assert.equal(used.status, 302);
    assert.match(used.headers.get('set-cookie'), /cja_token=/);
    // Using it made the app issue a fresh code for the file.
    const rec1b = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.notEqual(rec1b.code, rec1.code);
    // Starting the app again finds it and prints a link, instead of opening a second copy.
    const second = spawnSync(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port)], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already running/);
    const link = /one-time link: (http:\/\/\S+)/.exec(second.stdout)[1];
    assert.ok(link.includes(rec1b.code));
    const rec2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rec2.code, rec1b.code, 'the code is only replaced once it has been used');
    const opened = await fetch(link, { redirect: 'manual' });
    assert.equal(opened.status, 302);
    assert.match(opened.headers.get('set-cookie'), /cja_token=/);
    // It was used, so the file now holds a new one, and the old link is dead.
    const rec3 = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.notEqual(rec3.code, rec1b.code);
    assert.equal((await fetch(link, { redirect: 'manual' })).headers.get('set-cookie'), null);
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 300));
    cleanup();
  }
});

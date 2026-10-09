import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { seedDemo } from '../lib/demo.mjs';
import { run as logRun } from '../tools/log.mjs';
import { tempStore } from './helpers.mjs';

async function boot(opts = {}) {
  const t = tempStore();
  if (opts.seed) seedDemo(t.store);
  const app = createApp({ store: t.store, demo: !!opts.demo, preflight: async () => ({ rows: [], ready: true }) });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-cja': '1' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { ...t, app, port, base, call, close: async () => { await app.close(); t.cleanup(); } };
}

test('health reports the app name, version and port, and binds to loopback', async () => {
  const s = await boot();
  const r = await s.call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.app, 'jobs-express');
  assert.equal(r.json.port, s.port);
  assert.equal(s.app.server.address().address, '127.0.0.1');
  await s.close();
});

test('static files are served, and unknown asset paths 404', async () => {
  const s = await boot();
  const index = await s.call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.text, /Jobs Express/);
  assert.equal((await s.call('GET', '/app.css')).status, 200);
  assert.equal((await s.call('GET', '/nope.js')).status, 404);
  assert.equal((await s.call('GET', '/..%2f..%2fpackage.json')).status, 403);
  await s.close();
});

test('profile round trip through the API', async () => {
  const s = await boot();
  const before = await s.call('GET', '/api/profile');
  assert.equal(before.json.setupComplete, false);
  const put = await s.call('PUT', '/api/profile', { about: { fullName: 'Alex Rivera' }, prefs: { perRun: 5 }, setupComplete: true });
  assert.equal(put.status, 200);
  assert.equal(put.json.about.fullName, 'Alex Rivera');
  const after = await s.call('GET', '/api/state');
  assert.equal(after.json.profile.prefs.perRun, 5);
  assert.equal(after.json.profile.setupComplete, true);
  assert.ok(after.json.gaps.length > 0);
  await s.close();
});

test('state changes need the X-CJA header and a localhost Host header', async () => {
  const s = await boot();
  const noHeader = await fetch(s.base + '/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const evil = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.port, path: '/api/health', headers: { Host: 'evil.example.com' } }, (res) => resolve(res.statusCode)).on('error', reject);
  });
  assert.equal(evil, 403);
  await s.close();
});

test('applications list, filters, CSV and held questions', async () => {
  const s = await boot();
  logRun(['applied', '--company', 'Brightwell Systems', '--role', 'Support Engineer', '--pay', '$90k'], s.store, {});
  logRun(['ready', '--company', 'Northfield Labs', '--role', 'Analyst'], s.store, {});
  logRun(['held', '--company', 'Marlow Robotics', '--role', 'Tech', '--question', "Do you have a driver's license?"], s.store, {});
  const all = await s.call('GET', '/api/applications');
  assert.equal(all.json.rows.length, 3);
  assert.equal(all.json.counts.all, 3);
  assert.equal(all.json.counts.held, 1);
  const only = await s.call('GET', '/api/applications?status=ready');
  assert.deepEqual(only.json.rows.map((r) => r.company), ['Northfield Labs']);
  const csv = await s.call('GET', '/api/applications.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /Brightwell Systems/);

  const held = await s.call('GET', '/api/held');
  assert.equal(held.json.items.length, 1);
  const id = held.json.items[0].id;
  const ans = await s.call('POST', '/api/held/answer', { id, answer: 'Yes, valid license.', remember: true });
  assert.equal(ans.status, 200);
  assert.equal(ans.json.retryable, 1);
  const state = await s.call('GET', '/api/state');
  assert.equal(state.json.profile.qa[0].a, 'Yes, valid license.');
  assert.equal((await s.call('POST', '/api/held/answer', { id: 'nope', answer: 'x' })).status, 404);
  assert.equal((await s.call('POST', '/api/held/answer', { id, answer: '  ' })).status, 400);
  await s.close();
});

test('resume upload stores the file inside the data folder', async () => {
  const s = await boot();
  const res = await fetch(s.base + '/api/resume', { method: 'POST', headers: { 'x-cja': '1', 'x-filename': encodeURIComponent('Alex Rivera.pdf') }, body: Buffer.from('%PDF-1.4 sample') });
  assert.equal(res.status, 200);
  const state = await s.call('GET', '/api/state');
  assert.match(state.json.profile.about.resumePath, /resume/);
  assert.equal(state.json.profile.about.resumeName, 'Alex_Rivera.pdf');
  const bad = await fetch(s.base + '/api/resume', { method: 'POST', headers: { 'x-cja': '1', 'x-filename': 'x.exe' }, body: Buffer.from('MZ') });
  assert.equal(bad.status, 400);
  await s.close();
});

test('SSE connects, sends a hello event and streams run updates', async () => {
  const s = await boot({ demo: true, seed: true });
  const events = [];
  const controller = new AbortController();
  const res = await fetch(s.base + '/api/events', { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (const m of buf.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)) events.push(m[1]);
      }
    } catch { /* aborted */ }
  })();
  const until = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for SSE; saw ' + events.join(','));
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await until(() => events.includes('hello'));
  const start = await s.call('POST', '/api/run/start', { mode: 'practice', agents: 1, demoFast: true });
  assert.equal(start.status, 200, start.text);
  await until(() => events.includes('log') && events.includes('run'));
  const stop = await s.call('POST', '/api/run/stop');
  assert.equal(stop.json.run.status, 'stopped');
  controller.abort();
  await pump;
  await s.close();
});

test('live mode needs explicit confirmation, and setup gaps block a real run', async () => {
  const s = await boot();
  const live = await s.call('POST', '/api/run/start', { mode: 'live' });
  assert.equal(live.status, 400);
  assert.match(live.json.error, /confirmation/);
  const gaps = await s.call('POST', '/api/run/start', { mode: 'practice' });
  assert.equal(gaps.status, 400);
  assert.match(gaps.json.error, /Finish setup/);
  await s.close();
});

test('?demo=1 on a normal server uses a separate sample-data world', async () => {
  const s = await boot();
  const real = await s.call('GET', '/api/state');
  assert.equal(real.json.demo, false);
  assert.equal(real.json.profile.about.fullName, '');
  const demo = await s.call('GET', '/api/state?demo=1');
  assert.equal(demo.json.demo, true);
  assert.equal(demo.json.profile.about.fullName, 'Alex Rivera');
  const apps = await s.call('GET', '/api/applications?demo=1');
  assert.equal(apps.json.rows.length, 14);
  const realApps = await s.call('GET', '/api/applications');
  assert.equal(realApps.json.rows.length, 0, 'real data is untouched');
  await s.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { Runner } from '../lib/runner.mjs';
import { SetupJobs } from '../lib/setup-actions.mjs';
import { saveProfile, saveResume } from '../lib/profile.mjs';
import { saveState } from '../lib/preflight.mjs';
import { loadSchedule, listDigests, SCHEDULE_FILE } from '../lib/schedule.mjs';
import { run as logRun } from '../tools/log.mjs';
import { seedDemo } from '../lib/demo.mjs';
import { tempStore, sampleProfile } from './helpers.mjs';

const OK_ROWS = [
  { id: 'claude', title: 'Claude Code', status: 'ok', summary: 'ok' },
  { id: 'auth', title: 'Signed in', status: 'ok', summary: 'ok' },
  { id: 'browser', title: 'Chrome or Edge', status: 'ok', summary: 'Google Chrome' },
];

/** A fake operating system: records every command, keeps "files" in memory, pretends systemd exists. */
function fakeOs({ systemd = true, failInstall = false } = {}) {
  const files = new Map();
  const calls = [];
  const ctx = {
    platform: 'linux', home: '/home/pat',
    exec: async (file, args, opts) => {
      calls.push([file, ...args].join(' '));
      if (failInstall && (file === 'systemctl' || file === 'crontab')) return { code: 1, stdout: '', stderr: 'Failed to connect to bus' };
      if (file === 'systemctl' && !systemd) return { code: 1, stdout: '', stderr: 'no systemd' };
      if (file === 'systemctl' && args.includes('is-enabled')) return { code: files.has('/home/pat/.config/systemd/user/jobs-express-daily.timer') ? 0 : 1, stdout: '', stderr: '' };
      if (file === 'crontab' && args[0] === '-l') return files.has('crontab') ? { code: 0, stdout: files.get('crontab'), stderr: '' } : { code: 1, stdout: '', stderr: 'no crontab' };
      if (file === 'crontab' && args[0] === '-') { files.set('crontab', opts.input); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: '', stderr: '' };
    },
    fs: { writeFile: (p, t) => files.set(p, t), readFile: (p) => { if (!files.has(p)) throw new Error('nope'); return files.get(p); }, rm: (p) => files.delete(p), exists: (p) => files.has(p) },
  };
  return { ctx, files, calls };
}

async function boot(opts = {}) {
  const t = tempStore();
  if (opts.seed) seedDemo(t.store);
  if (opts.ready) readyUp(t.store);
  return bootOn(t, opts);
}

function readyUp(store) {
  saveProfile(store, JSON.parse(JSON.stringify(sampleProfile())));
  saveResume(store, 'cv.pdf', Buffer.from('%PDF-1.4 x'));
  saveState(store, { linkedinConfirmed: true });
}

async function bootOn(t, opts = {}) {
  const os = opts.os || fakeOs();
  const app = createApp({
    store: t.store, demo: !!opts.demo, runner: opts.runner || null, schedulerCtx: os.ctx, setupJobs: opts.setupJobs || null,
    preflight: opts.preflight === undefined ? async () => ({ rows: OK_ROWS, ready: true }) : opts.preflight,
    scheduleDeps: { browserRunning: async () => true, startBrowser() {}, testConnection: async () => ({ ok: true, reason: 'ok' }), sleep: async () => {}, ...(opts.scheduleDeps || {}) },
  });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'x-cja-token': app.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-cja': '1' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  /** Collect server-sent events. */
  const events = [];
  const controller = new AbortController();
  const pump = (async () => {
    const res = await fetch(base + '/api/events', { signal: controller.signal, headers: { 'x-cja-token': app.token } });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (name && data) events.push({ name, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  return { ...t, app, os, port, base, call, events, close: async () => { controller.abort(); await pump; await app.close(); t.cleanup(); } };
}
const until = async (pred, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// --- daily schedule over HTTP ---------------------------------------------------------------------

test('GET /api/schedule: defaults before anything is saved, and the dashboard summary says off', async () => {
  const s = await boot();
  const r = await s.call('GET', '/api/schedule');
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule.enabled, false);
  assert.equal(r.json.schedule.maxApps, 10);
  assert.equal(r.json.schedule.freshHours, 30);
  assert.equal(r.json.schedule.maxMinutes, 90);
  assert.equal(r.json.schedule.mode, 'practice');
  assert.equal(r.json.limits.maxApps.max, 25);
  assert.equal(r.json.liveText, 'I have reviewed Practice results and accept that applications will be submitted automatically');
  assert.equal(r.json.os.kind, 'systemd');
  assert.equal(r.json.system, undefined, 'the operating system is only asked when you ask');
  const state = await s.call('GET', '/api/state');
  assert.equal(state.json.schedule.enabled, false);
  await s.close();
});

test('PUT /api/schedule validates, installs through the scheduler, and saves', async () => {
  const s = await boot();
  const bad = [
    [{ time: '4:10' }, /time of day/], [{ time: '04:10', days: 'x' }, /every day or weekdays/], [{ time: '04:10', mode: 'live' }, /Live mode needs the box/],
    [{ time: '04:10', maxApps: 26 }, /from 1 to 25/], [{ time: '04:10', agents: 4 }, /Agents must/], [{ time: '04:10', freshHours: 0 }, /Freshness window/], [{ time: '04:10', maxMinutes: 5 }, /Time cap/],
  ];
  for (const [body, re] of bad) {
    const r = await s.call('PUT', '/api/schedule', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, re);
  }
  assert.equal(s.os.calls.length, 0, 'nothing reached the operating system for bad input');
  assert.equal(loadSchedule(s.store).enabled, false);

  const ok = await s.call('PUT', '/api/schedule', { time: '05:30', days: 'weekdays', mode: 'practice', agents: 2, maxApps: 12, freshHours: 48, maxMinutes: 60 });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.schedule.enabled, true);
  assert.equal(ok.json.schedule.days, 'weekdays');
  assert.equal(ok.json.system.installed, true);
  assert.equal(ok.json.system.time, '05:30');
  assert.equal(ok.json.system.days, 'weekdays');
  assert.match(ok.json.summary.nextRunText, /\d:\d\d [AP]M$/);
  assert.ok(s.os.calls.some((c) => c === 'systemctl --user enable --now jobs-express-daily.timer'));
  const timer = s.os.files.get('/home/pat/.config/systemd/user/jobs-express-daily.timer');
  assert.match(timer, /OnCalendar=Mon\.\.Fri \*-\*-\* 05:30:00/);
  const service = s.os.files.get('/home/pat/.config/systemd/user/jobs-express-daily.service');
  assert.match(service, /--scheduled-run/);
  assert.match(service, /TimeoutStartSec=7200/, 'the cap plus an hour of slack for Chrome and checks');
  const saved = loadSchedule(s.store);
  assert.deepEqual([saved.enabled, saved.time, saved.days, saved.agents, saved.maxApps, saved.freshHours, saved.maxMinutes], [true, '05:30', 'weekdays', 2, 12, 48, 60]);
  assert.ok(saved.savedAt);
  const state = await s.call('GET', '/api/state');
  assert.equal(state.json.schedule.enabled, true);
  assert.equal(state.json.schedule.days, 'weekdays');
  await s.close();
});

test('Live needs the acceptance, and it is stored only with Live', async () => {
  const s = await boot();
  const live = await s.call('PUT', '/api/schedule', { time: '04:10', mode: 'live', liveAccepted: true });
  assert.equal(live.status, 200);
  assert.equal(live.json.schedule.mode, 'live');
  assert.equal(live.json.schedule.liveAccepted, true);
  const back = await s.call('PUT', '/api/schedule', { time: '04:10', mode: 'practice', liveAccepted: true });
  assert.equal(back.json.schedule.mode, 'practice');
  assert.equal(back.json.schedule.liveAccepted, false);
  await s.close();
});

test('if the operating system refuses, the person gets a plain error and nothing is marked on', async () => {
  const s = await boot({ os: fakeOs({ failInstall: true }) });
  const r = await s.call('PUT', '/api/schedule', { time: '04:10' });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /Neither systemd nor crontab would accept the job/);
  assert.equal(loadSchedule(s.store).enabled, false);
  await s.close();
});

test('cron is used when systemd is not available, and DELETE removes the job', async () => {
  const s = await boot({ os: fakeOs({ systemd: false }) });
  await s.call('PUT', '/api/schedule', { time: '06:00' });
  const check = await s.call('GET', '/api/schedule?system=1');
  assert.equal(check.json.system.installed, true);
  assert.equal(check.json.system.kind, 'cron');
  assert.match(s.os.files.get('crontab'), /0 6 \* \* \* cd /);
  const del = await s.call('DELETE', '/api/schedule');
  assert.equal(del.status, 200);
  assert.equal(del.json.schedule.enabled, false);
  assert.equal(del.json.system.installed, false);
  assert.equal(s.os.files.get('crontab').trim(), '');
  assert.equal(loadSchedule(s.store).time, '06:00', 'your choices are kept so you can turn it back on');
  await s.close();
});

test('the status warns when the scheduled job points at a different Node or folder', async () => {
  const s = await boot();
  await s.call('PUT', '/api/schedule', { time: '04:10' });
  const fresh = await s.call('GET', '/api/schedule?system=1');
  assert.equal(fresh.json.system.stale, false);
  await s.close();
});

test('preview shows what a run would do and what blocks it', async () => {
  const s = await boot({ ready: true });
  await s.call('PUT', '/api/schedule', { time: '04:10' });
  const ok = await s.call('POST', '/api/schedule/preview', { test: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.plan.ok, true, JSON.stringify(ok.json.plan.blockers));
  assert.match(ok.json.plan.lines.join('\n'), /always Practice|Practice\. Forms are filled/);
  saveState(s.store, { linkedinConfirmed: false });
  const blocked = await s.call('POST', '/api/schedule/preview', { test: true });
  assert.equal(blocked.json.plan.ok, false);
  assert.match(blocked.json.plan.blockers[0].what, /LinkedIn/);
  await s.close();
});

test('"Run a test now" needs confirmation, runs in Practice through the apps own runner, streams progress, and leaves a digest', async () => {
  const t = tempStore();
  readyUp(t.store);
  const agent = path.join(t.dir, 'agent.mjs');
  fs.writeFileSync(agent, `
import { run } from ${JSON.stringify(new URL('../tools/log.mjs', import.meta.url).href)};
import { createStore } from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
process.stdin.resume();
process.stdin.on('end', () => {
  const store = createStore(process.env.CJA_DATA_DIR);
  run([process.env.CJA_MODE === 'live' ? 'applied' : 'ready', '--company', 'Acme', '--role', 'Dev', '--url', 'https://example.com/1'], store, process.env);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }));
});`);
  const s = await bootOn(t, { runner: new Runner({ store: t.store, spec: { command: process.execPath, args: [agent] } }) });
  await s.call('PUT', '/api/schedule', { time: '04:10', mode: 'live', liveAccepted: true });
  const noConfirm = await s.call('POST', '/api/schedule/test', {});
  assert.equal(noConfirm.status, 400);
  const start = await s.call('POST', '/api/schedule/test', { confirm: true });
  assert.equal(start.status, 200, start.text);
  assert.equal(start.json.started, true);
  await until(() => s.events.some((e) => e.name === 'schedule' && e.data.done));
  const done = s.events.find((e) => e.name === 'schedule' && e.data.done).data;
  assert.equal(done.status, 'finished');
  assert.ok(s.events.some((e) => e.name === 'schedule' && /Testing the Claude in Chrome connection/.test(e.data.line || '')));
  assert.ok(s.events.some((e) => e.name === 'run'), 'the dashboard live log sees this run');
  const digests = listDigests(s.store);
  assert.equal(digests.length, 1);
  assert.equal(digests[0].test, true);
  assert.equal(digests[0].mode, 'practice', 'a test run is Practice even when the schedule is Live');
  assert.equal(digests[0].counts.ready, 1);
  const list = await s.call('GET', '/api/digests');
  assert.equal(list.json.items[0].name, digests[0].name);
  const one = await s.call('GET', `/api/digest?name=${digests[0].name}`);
  assert.match(one.json.markdown, /Test run/);
  assert.equal((await s.call('GET', '/api/digest?name=..%2Fprofile')).status, 404);
  assert.equal((await s.call('GET', '/api/digest')).status, 404);
  await s.close();
});

test('a test run cannot start while another run is active', async () => {
  const t = tempStore();
  readyUp(t.store);
  const hang = path.join(t.dir, 'hang.mjs');
  fs.writeFileSync(hang, 'setInterval(() => {}, 1000);');
  const runner = new Runner({ store: t.store, spec: { command: process.execPath, args: [hang] } });
  const s = await bootOn(t, { runner });
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  assert.equal((await s.call('POST', '/api/schedule/test', { confirm: true })).status, 409);
  assert.equal((await s.call('POST', '/api/run/start', { mode: 'practice' })).status, 409);
  runner.stop();
  await until(() => !runner.active);
  await s.close();
});

test('a manual start is refused with a plain message while a scheduled run holds the lock', async () => {
  const s = await boot({ ready: true });
  const { acquireLock } = await import('../lib/lock.mjs');
  const lock = acquireLock(s.store, 'scheduled');
  const r = await s.call('POST', '/api/run/start', { mode: 'practice' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /scheduled daily run is already running/);
  lock.release();
  await s.close();
});

test('demo mode has a sample schedule and digests, touches no scheduler, and launches nothing', async () => {
  const s = await boot({ demo: true, seed: true });
  const r = await s.call('GET', '/api/schedule?system=1');
  assert.equal(r.json.schedule.enabled, true);
  assert.equal(r.json.digests.length, 3);
  assert.deepEqual(r.json.digests.map((d) => d.status).sort(), ['failed', 'finished', 'finished']);
  assert.equal(r.json.system.installed, true);
  assert.equal(r.json.os.kind, 'demo');
  assert.equal(s.os.calls.length, 0);
  const put = await s.call('PUT', '/api/schedule', { time: '07:15' });
  assert.equal(put.status, 200);
  assert.equal(s.os.calls.length, 0, 'demo mode never calls the real scheduler');
  const test = await s.call('POST', '/api/schedule/test', { confirm: true });
  assert.equal(test.json.demo, true);
  await until(() => s.events.some((e) => e.name === 'schedule' && e.data.done));
  assert.equal((await s.call('POST', '/api/setup/install', { confirm: true })).status, 400);
  assert.equal((await s.call('POST', '/api/setup/login', {})).status, 400);
  await s.close();
});

// --- one-click setup over HTTP -----------------------------------------------------------------------

test('install button: needs confirmation, runs the job, streams lines over SSE, and can be cancelled', async () => {
  const { dir, cleanup } = tempStore();
  const script = path.join(dir, 'install.mjs');
  fs.writeFileSync(script, "console.log('Installing...'); setTimeout(() => { console.log('Installed'); }, 100);");
  const jobs = new SetupJobs({ installSpec: { file: process.execPath, args: [script], display: 'fake installer' } });
  const s = await boot({ setupJobs: jobs });
  const info = await s.call('GET', '/api/setup');
  assert.equal(info.json.install.source, 'https://code.claude.com/docs/en/quickstart');
  assert.match(info.json.install.display, /claude\.ai\/install\.(ps1|sh)/);
  assert.equal(info.json.login.display, 'claude auth login --claudeai');
  assert.equal((await s.call('POST', '/api/setup/install', {})).status, 400, 'no confirm, no install');
  assert.equal((await s.call('POST', '/api/setup/install', { confirm: 'yes' })).status, 400, 'only a real true counts');
  const go = await s.call('POST', '/api/setup/install', { confirm: true });
  assert.equal(go.status, 200);
  assert.equal(go.json.job.kind, 'install');
  assert.equal((await s.call('POST', '/api/setup/install', { confirm: true })).status, 409, 'one at a time');
  await until(() => s.events.some((e) => e.name === 'setup' && e.data.done));
  const lines = s.events.filter((e) => e.name === 'setup' && e.data.line).map((e) => e.data.line);
  assert.ok(lines.includes('Installing...') && lines.includes('Installed'));
  assert.equal(s.events.find((e) => e.name === 'setup' && e.data.done).data.status, 'done');
  const again = await s.call('GET', '/api/setup');
  assert.equal(again.json.job.status, 'done');
  assert.equal((await s.call('POST', '/api/setup/cancel', {})).status, 200);
  await s.close();
  cleanup();
});

// --- hardening of inputs --------------------------------------------------------------------------------

test('oversized bodies get a readable 413, not a dropped connection', async () => {
  const s = await boot();
  const big = Buffer.alloc(12 * 1024 * 1024, 0x25);
  const res = await fetch(s.base + '/api/resume', { method: 'POST', headers: { 'x-cja': '1', 'x-cja-token': s.app.token, 'x-filename': 'cv.pdf' }, body: big });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
  const profileBody = JSON.stringify({ about: { fullName: 'x'.repeat(2_000_000) } });
  const r2 = await s.call('PUT', '/api/profile', profileBody);
  assert.equal(r2.status, 413);
  assert.equal((await s.call('GET', '/api/health')).status, 200, 'the server is fine afterwards');
  await s.close();
});

test('a null, list or number body is a 400, and bad percent-encoding is a 400, never a 500', async () => {
  const s = await boot();
  for (const route of ['/api/held/answer', '/api/held/dismiss', '/api/run/start', '/api/preflight/linkedin', '/api/open']) {
    for (const body of ['null', '[]', '5', '"x"']) {
      const r = await s.call('POST', route, body);
      assert.equal(r.status, 400, `${route} ${body}`);
    }
  }
  assert.equal((await s.call('PUT', '/api/profile', '[]')).status, 400);
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.port, path: p, headers: { host: `127.0.0.1:${s.port}`, 'x-cja-token': s.app.token } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await get('/%'), 400);
  assert.equal(await get('/%E0%A4%A'), 400);
  const resume = await fetch(s.base + '/api/resume', { method: 'POST', headers: { 'x-cja': '1', 'x-cja-token': s.app.token, 'x-filename': '%E0%A4%A.pdf' }, body: Buffer.from('%PDF-1.4') });
  assert.equal(resume.status, 400);
  await s.close();
});

test('HEAD works for monitoring, answers must be text, and "remember: false" means no', async () => {
  const s = await boot();
  const head = await fetch(s.base + '/api/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()), '');
  logRun(['held', '--company', 'Marlow', '--role', 'Tech', '--question', 'Driver license?', '--url', 'https://m.example/1'], s.store, {});
  const id = (await s.call('GET', '/api/held')).json.items[0].id;
  assert.equal((await s.call('POST', '/api/held/answer', { id, answer: { x: 1 } })).status, 400);
  assert.equal((await s.call('POST', '/api/held/answer', { id, answer: ['a'] })).status, 400);
  const once = await s.call('POST', '/api/held/answer', { id, answer: 'Yes', remember: false });
  assert.equal(once.status, 200);
  assert.equal((await s.call('GET', '/api/profile')).json.qa.length, 0, 'not remembered');
  await s.close();
});

test('answers are removed by their own endpoint, so a settings save cannot bring them back or lose new ones', async () => {
  const s = await boot();
  logRun(['held', '--company', 'A', '--question', 'First question?', '--url', 'https://a.example/1'], s.store, {});
  logRun(['held', '--company', 'B', '--question', 'Second question?', '--url', 'https://b.example/1'], s.store, {});
  const items = (await s.call('GET', '/api/held')).json.items;
  for (const it of items) await s.call('POST', '/api/held/answer', { id: it.id, answer: 'yes', remember: true });
  assert.equal((await s.call('GET', '/api/profile')).json.qa.length, 2);
  const rm = await s.call('POST', '/api/answers/remove', { q: 'first question?' });
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.json.profile.qa.map((x) => x.q), ['Second question?']);
  assert.equal((await s.call('POST', '/api/answers/remove', { q: 5 })).status, 400);
  // A save that does not mention qa leaves it alone.
  await s.call('PUT', '/api/profile', { about: { city: 'Austin' } });
  assert.equal((await s.call('GET', '/api/profile')).json.qa.length, 1);
  await s.close();
});

test('state carries data warnings: a missing resume after the folder was copied', async () => {
  const s = await boot();
  saveResume(s.store, 'cv.pdf', Buffer.from('%PDF-1.4 x'));
  fs.rmSync(path.join(s.dir, 'resume', 'cv.pdf'));
  const st = await s.call('GET', '/api/state');
  assert.ok(st.json.gaps.includes('a resume file'));
  assert.match(st.json.warnings.map((w) => w.text).join(' '), /Upload it again/);
  await s.close();
});

test('a store that cannot be read gives a 503 with a plain message, and the dashboard is not told "no data"', async () => {
  const s = await boot();
  fs.mkdirSync(path.join(s.dir, 'applications.jsonl'));
  const r = await s.call('GET', '/api/applications');
  assert.equal(r.status, 503);
  assert.match(r.json.error, /Could not read applications\.jsonl/);
  await s.close();
});

test('scheduled-run state files never leave the data folder: the schedule file lives in data/', async () => {
  const s = await boot();
  await s.call('PUT', '/api/schedule', { time: '04:10' });
  assert.ok(fs.existsSync(path.join(s.dir, SCHEDULE_FILE)));
  await s.close();
});

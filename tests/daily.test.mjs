import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScheduled, planScheduledRun, effectiveOptions, findBlockers, EXIT, TEST_LIMITS } from '../lib/daily.mjs';
import { Runner } from '../lib/runner.mjs';
import { saveProfile, saveResume, normalizeProfile, defaultProfile } from '../lib/profile.mjs';
import { saveState } from '../lib/preflight.mjs';
import { saveSchedule, loadSchedule, listDigests, readDigest, SCHEDULE_FILE, defaultSchedule } from '../lib/schedule.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { tempStore, sampleProfile } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OK_ROWS = [
  { id: 'claude', title: 'Claude Code', status: 'ok', summary: 'Claude Code 2.1.0' },
  { id: 'auth', title: 'Signed in', status: 'ok', summary: 'Signed in' },
  { id: 'browser', title: 'Chrome or Edge', status: 'ok', summary: 'Google Chrome' },
];

/** A store that is ready for a scheduled run: finished setup, resume, LinkedIn confirmed, schedule saved. */
function readyStore(over = {}) {
  const t = tempStore();
  const p = sampleProfile();
  saveProfile(t.store, JSON.parse(JSON.stringify(p)));
  saveResume(t.store, 'cv.pdf', Buffer.from('%PDF-1.4 x'));
  saveState(t.store, { linkedinConfirmed: true });
  saveSchedule(t.store, { enabled: true, savedAt: new Date().toISOString(), time: '04:10', ...over });
  return t;
}

const calls = [];
function fakeDeps(over = {}) {
  calls.length = 0;
  return {
    preflight: async () => ({ rows: OK_ROWS }),
    browserRunning: async () => true,
    startBrowser: () => calls.push('startBrowser'),
    testConnection: async () => { calls.push('testConnection'); return { ok: true, reason: 'ok' }; },
    sleep: async () => {},
    now: () => new Date(),
    ...over,
  };
}

// An agent that records two practice applications and one held question through the real helper, and leaves its prompt behind.
function writeAgent(dir, { hang = false } = {}) {
  const file = path.join(dir, 'agent.mjs');
  const logUrl = new URL('../tools/log.mjs', import.meta.url).href;
  const storeUrl = new URL('../lib/store.mjs', import.meta.url).href;
  fs.writeFileSync(file, `
import fs from 'node:fs';
import { run } from ${JSON.stringify(logUrl)};
import { createStore } from ${JSON.stringify(storeUrl)};
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.CJA_DATA_DIR + '/seen-prompt.txt', prompt);
  fs.writeFileSync(process.env.CJA_DATA_DIR + '/seen-mode.txt', process.env.CJA_MODE);
  const store = createStore(process.env.CJA_DATA_DIR);
  const verb = process.env.CJA_MODE === 'live' ? 'applied' : 'ready';
  run([verb, '--company', 'Acme', '--role', 'Support Engineer', '--url', 'https://example.com/a'], store, process.env);
  run([verb, '--company', 'Beta', '--role', 'Analyst', '--url', 'https://example.com/b'], store, process.env);
  run(['held', '--company', 'Gamma', '--role', 'Tech', '--url', 'https://example.com/g', '--question', 'Needs the emailed verification code'], store, process.env);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
  ${hang ? 'setInterval(() => {}, 1000);' : ''}
});
`);
  return { command: process.execPath, args: [file] };
}

test('effectiveOptions: a test run is always Practice and small', () => {
  const live = { ...defaultSchedule(), mode: 'live', liveAccepted: true, maxApps: 25, maxMinutes: 200, agents: 3 };
  assert.equal(effectiveOptions(live).mode, 'live');
  const t = effectiveOptions(live, { test: true });
  assert.equal(t.mode, 'practice');
  assert.equal(t.maxApps, TEST_LIMITS.maxApps);
  assert.equal(t.maxMinutes, TEST_LIMITS.maxMinutes);
  assert.equal(effectiveOptions({ ...live, liveAccepted: false }).mode, 'practice', 'Live without acceptance never runs');
});

test('dry run: says what it would do, launches nothing, takes no lock', async () => {
  const { store, cleanup } = readyStore({ freshHours: 36, maxApps: 7, agents: 2 });
  const plan = await planScheduledRun({ store, deps: fakeDeps() });
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  assert.equal(plan.options.mode, 'practice');
  assert.equal(plan.options.freshHours, 36);
  assert.equal(plan.agents.length, 2);
  assert.equal(plan.agents.reduce((n, a) => n + a.limit, 0), 7);
  const text = plan.lines.join('\n');
  assert.match(text, /dry run\. Nothing is launched/);
  assert.match(text, /Only roles posted in the last 36 hours/);
  assert.match(text, /Nothing blocks it\. It would start\./);
  assert.ok(plan.agents[0].promptChars > 3000);
  assert.deepEqual(calls, [], 'no browser was started and no connection test was made');
  assert.ok(!fs.existsSync(store.resolve('run.lock')));
  assert.equal(fs.readdirSync(store.resolve('runs')).length, 0);
  cleanup();
});

test('dry run lists what would stop it, each with a plain fix', async () => {
  const { store, cleanup } = readyStore();
  const rows = [
    { id: 'claude', title: 'Claude Code', status: 'fail', summary: 'Claude Code was not found.' },
    { id: 'auth', title: 'Signed in', status: 'pending', summary: 'Waiting' },
    { id: 'browser', title: 'Chrome or Edge', status: 'fail', summary: 'No Chrome or Edge was found.' },
  ];
  saveState(store, { linkedinConfirmed: false });
  const lock = acquireLock(store, 'manual');
  const plan = await planScheduledRun({ store, deps: fakeDeps({ preflight: async () => ({ rows }) }) });
  assert.equal(plan.ok, false);
  const what = plan.blockers.map((b) => b.what).join(' | ');
  assert.match(what, /Claude Code was not found/);
  assert.match(what, /No Chrome or Edge/);
  assert.match(what, /LinkedIn sign-in has not been confirmed/);
  assert.match(what, /run started from the app is running right now/);
  assert.match(plan.blockers.find((b) => /Claude Code was not found/.test(b.what)).hint, /Install Claude Code/);
  lock.release();
  const noSched = await planScheduledRun({ store: (() => { const t = tempStore(); return t.store; })(), deps: fakeDeps() });
  assert.match(noSched.blockers.map((b) => b.what).join(' '), /Setup is not finished/);
  cleanup();
});

test('findBlockers: an API-key login, unfinished setup and Live without acceptance', () => {
  const profile = normalizeProfile({}, defaultProfile());
  const b = findBlockers({
    rows: [{ id: 'claude', status: 'ok' }, { id: 'auth', status: 'fail', summary: 'Claude Code is using an API key, not a claude.ai login.', hint: 'Run claude auth login.' }],
    profile, schedule: { ...defaultSchedule(), mode: 'live', liveAccepted: false }, state: {}, options: { test: false },
  });
  const text = b.map((x) => `${x.what} ${x.hint}`).join('\n');
  assert.match(text, /using an API key/);
  assert.match(text, /Sign in to Claude/);
  assert.match(text, /Setup is not finished/);
  assert.match(text, /set to Live without the acceptance box/);
});

test('a scheduled run: checks, starts fresh-only agents, writes the digest, updates lastRun, releases the lock', async () => {
  const { store, dir, cleanup } = readyStore({ freshHours: 24, maxApps: 6, maxMinutes: 30 });
  const runner = new Runner({ store, spec: writeAgent(dir) });
  const logs = [];
  const r = await runScheduled({ store, runner, deps: fakeDeps(), log: (l) => logs.push(l) });
  assert.equal(r.exitCode, EXIT.ok);
  assert.equal(r.status, 'finished');
  assert.deepEqual(calls, ['testConnection'], 'Chrome was already running, so it was not started');
  assert.deepEqual(r.digest.counts, { submitted: 0, ready: 2, held: 1, skipped: 0 });
  assert.equal(r.digest.items.length, 3);
  assert.equal(r.digest.held[0].company, 'Gamma');
  assert.match(r.digest.held[0].question, /emailed verification code/);
  const sched = loadSchedule(store);
  assert.equal(sched.lastRun.status, 'finished');
  assert.equal(sched.lastRun.ready, 2);
  assert.equal(sched.lastRun.held, 1);
  assert.equal(sched.lastRun.submitted, 0);
  assert.equal(sched.lastRun.digest, r.digestName);
  assert.ok(sched.lastRun.startedAt && sched.lastRun.finishedAt && sched.lastRun.error === '');
  for (const ext of ['md', 'json']) assert.ok(fs.existsSync(store.resolve('digests', `${r.digestName}.${ext}`)));
  assert.match(readDigest(store, r.digestName).markdown, /Needs you[\s\S]*Gamma/);
  const prompt = fs.readFileSync(path.join(dir, 'seen-prompt.txt'), 'utf8');
  assert.match(prompt, /Daily run: fresh postings only/);
  assert.match(prompt, /last 24 hours/);
  assert.match(prompt, /ceiling for this run is \*\*6\*\*/);
  assert.equal(fs.readFileSync(path.join(dir, 'seen-mode.txt'), 'utf8'), 'practice');
  assert.equal(runner.run.maxMinutes, 30, 'the time cap from the schedule is the runner cap');
  assert.ok(!fs.existsSync(store.resolve('run.lock')), 'the lock is released');
  assert.ok(logs.some((l) => /Digest written/.test(l)));
  cleanup();
});

test('a Live schedule submits (with the acceptance), but a test run never does', async () => {
  const { store, dir, cleanup } = readyStore({ mode: 'live', liveAccepted: true });
  const runner = new Runner({ store, spec: writeAgent(dir) });
  const live = await runScheduled({ store, runner, deps: fakeDeps() });
  assert.equal(fs.readFileSync(path.join(dir, 'seen-mode.txt'), 'utf8'), 'live');
  assert.equal(live.digest.counts.submitted, 2);
  assert.equal(live.digest.mode, 'live');
  fs.rmSync(store.resolve('applications.jsonl'));
  const t = await runScheduled({ store, runner: new Runner({ store, spec: writeAgent(dir) }), test: true, deps: fakeDeps() });
  assert.equal(fs.readFileSync(path.join(dir, 'seen-mode.txt'), 'utf8'), 'practice');
  assert.equal(t.digest.counts.ready, 2);
  assert.equal(t.digest.test, true);
  assert.equal(t.digest.maxApps, TEST_LIMITS.maxApps);
  cleanup();
});

test('missing prerequisites write a failed digest with a fix and exit non-zero, without launching anything', async () => {
  const { store, cleanup } = readyStore();
  const rows = [{ id: 'claude', title: 'Claude Code', status: 'fail', summary: 'Claude Code was not found.' }];
  const r = await runScheduled({ store, deps: fakeDeps({ preflight: async () => ({ rows }) }) });
  assert.equal(r.exitCode, EXIT.failed);
  assert.equal(r.status, 'failed');
  assert.match(r.digest.error, /Claude Code was not found/);
  assert.match(r.digest.hint, /press "Install Claude Code"/);
  assert.equal(loadSchedule(store).lastRun.status, 'failed');
  assert.match(loadSchedule(store).lastRun.error, /Claude Code was not found/);
  assert.deepEqual(calls, []);
  assert.equal(fs.readdirSync(store.resolve('runs')).length, 0);
  assert.ok(!fs.existsSync(store.resolve('run.lock')));
  assert.match(readDigest(store, r.digestName).markdown, /How to fix it:/);
  cleanup();
});

test('no saved schedule means no run', async () => {
  const { store, cleanup } = tempStore();
  const r = await runScheduled({ store, deps: fakeDeps() });
  assert.equal(r.exitCode, EXIT.failed);
  assert.match(r.digest.error, /No daily schedule has been saved/);
  assert.ok(!fs.existsSync(store.resolve(SCHEDULE_FILE)) || !loadSchedule(store).enabled);
  cleanup();
});

test('it skips itself while a manual run holds the lock, and says so in a digest', async () => {
  const { store, cleanup } = readyStore();
  const lock = acquireLock(store, 'manual');
  const r = await runScheduled({ store, deps: fakeDeps() });
  assert.equal(r.exitCode, EXIT.skipped);
  assert.equal(r.status, 'skipped');
  assert.match(r.digest.error, /run started from the app was already running/);
  assert.deepEqual(calls, []);
  assert.ok(fs.existsSync(store.resolve('run.lock')), 'the other run\'s lock is untouched');
  lock.release();
  assert.equal(listDigests(store)[0].status, 'skipped');
  cleanup();
});

test('Chrome closed: it starts the browser, waits for it, and retries the extension test', async () => {
  const { store, dir, cleanup } = readyStore();
  let running = false;
  let tries = 0;
  const sleeps = [];
  const deps = fakeDeps({
    browserRunning: async () => running,
    startBrowser: () => { calls.push('startBrowser'); setTimeout(() => { running = true; }, 0); },
    testConnection: async () => { calls.push('testConnection'); return ++tries < 2 ? { ok: false, reason: 'not-connected' } : { ok: true, reason: 'ok' }; },
    sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 5)); },
  });
  const r = await runScheduled({ store, runner: new Runner({ store, spec: writeAgent(dir) }), deps });
  assert.equal(r.status, 'finished');
  assert.deepEqual(calls, ['startBrowser', 'testConnection', 'testConnection']);
  assert.ok(sleeps.length >= 1);
  cleanup();
});

test('the extension never answers: three tries, then a failed digest that explains how to fix it', async () => {
  const { store, cleanup } = readyStore();
  const r = await runScheduled({ store, deps: fakeDeps({ testConnection: async () => { calls.push('testConnection'); return { ok: false, reason: 'timeout' }; } }) });
  assert.equal(r.exitCode, EXIT.failed);
  assert.equal(calls.filter((c) => c === 'testConnection').length, 3);
  assert.match(r.digest.error, /Claude extension did not answer/);
  assert.match(r.digest.hint, /install the "Claude" extension/);
  assert.equal(fs.readdirSync(store.resolve('runs')).length, 0, 'no agent was started');
  cleanup();
});

test('stopped at the time cap: the digest says so, exit code stays 0, and the agents are gone', async () => {
  const { store, dir, cleanup } = readyStore();
  const runner = new Runner({ store, spec: writeAgent(dir, { hang: true }) });
  const done = runScheduled({ store, runner, deps: fakeDeps() });
  await new Promise((resolve) => { const t = setInterval(() => { if (runner.active && runner.recent().some((l) => /Agent finished|done/.test(l.text) || l.kind === 'result')) { clearInterval(t); resolve(); } }, 20); });
  runner.stop('Time limit reached (30 minutes).');
  const r = await done;
  assert.equal(r.status, 'stopped');
  assert.equal(r.exitCode, EXIT.ok);
  assert.match(r.digest.error, /Time limit reached/);
  assert.equal(r.digest.counts.ready, 2, 'what finished before the cap is kept');
  assert.equal(loadSchedule(store).lastRun.status, 'stopped');
  cleanup();
});

test('node server.mjs --scheduled-run --dry-run --json prints a plan and starts nothing', () => {
  const { store, dir, cleanup } = readyStore();
  const run = spawnSync(process.execPath, [path.join(ROOT, 'server.mjs'), '--scheduled-run', '--dry-run', '--json', '--data-dir', dir], {
    encoding: 'utf8', timeout: 90_000, env: { ...process.env, CJA_DATA_DIR: '' },
  });
  assert.ok(run.status === 0 || run.status === 1, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.options.mode, 'practice');
  assert.ok(Array.isArray(plan.lines) && plan.lines[0].startsWith('Scheduled run'));
  assert.equal(plan.agents.length, 1);
  assert.equal(plan.schedule.saved, true);
  assert.ok(!fs.existsSync(path.join(dir, 'run.lock')));
  assert.equal(fs.readdirSync(path.join(dir, 'runs')).length, 0);
  assert.equal(listDigests(store).length, 0, 'a dry run leaves no digest');
  cleanup();
});

test('the plain text dry run reads like instructions to a person', () => {
  const { dir, cleanup } = readyStore();
  const run = spawnSync(process.execPath, [path.join(ROOT, 'server.mjs'), '--scheduled-run', '--dry-run'], {
    encoding: 'utf8', timeout: 90_000, env: { ...process.env, CJA_DATA_DIR: dir },
  });
  assert.match(run.stdout, /^Scheduled run, dry run\. Nothing is launched\./);
  assert.match(run.stdout, /Schedule: every day at 4:10 AM\./);
  assert.match(run.stdout, /It would: make sure Chrome is running/);
  cleanup();
});

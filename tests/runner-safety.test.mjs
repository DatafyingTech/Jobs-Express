import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Runner, summarizeEvent, clip, authMessage, pruneRuns } from '../lib/runner.mjs';
import { FILES, listApplications, claimPosting, recordApplication } from '../lib/store.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { tempStore, sampleProfile } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const GUARD = path.join(HERE, '..', 'tools', 'guard.mjs');
const spec = { command: process.execPath, args: [FAKE] };

const waitFor = async (pred, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the agent process gets an allow-listed environment plus the run mode, and no secrets', async () => {
  const { store, cleanup } = tempStore();
  const argsFile = path.join(store.dataDir, 'args.jsonl');
  const env = { ...process.env, CJA_FAKE_ARGS_FILE: argsFile, SUPER_SECRET_TOKEN: 'abc', GITHUB_TOKEN: 'ghp_x', MY_API_KEY: 'k', ANTHROPIC_API_KEY: 'sk-x' };
  const runner = new Runner({ store, spec, env });
  runner.start({ profile: sampleProfile(), mode: 'live', agents: 1 });
  await waitFor(() => runner.snapshot().status !== 'running');
  const seen = JSON.parse(fs.readFileSync(argsFile, 'utf8').trim().split('\n')[0]);
  assert.equal(seen.mode, 'live', 'CJA_MODE tells log.mjs whether practice rows count as duplicates');
  for (const k of ['SUPER_SECRET_TOKEN', 'GITHUB_TOKEN', 'MY_API_KEY', 'ANTHROPIC_API_KEY']) assert.ok(!seen.envKeys.includes(k), k);
  assert.ok(seen.envKeys.includes('CJA_DATA_DIR') && seen.envKeys.includes('CJA_AGENT') && seen.envKeys.includes('CJA_RUN'));
  assert.ok(seen.envKeys.some((k) => k.toUpperCase() === 'PATH'));
  cleanup();
});

test('only one run at a time, across processes: a held lock blocks start and is released afterwards', async () => {
  const { store, cleanup } = tempStore();
  const other = acquireLock(store, 'scheduled');
  assert.ok(other.ok);
  const runner = new Runner({ store, spec });
  assert.throws(() => runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 }), (e) => e.code === 'LOCKED' && /scheduled daily run/.test(e.message));
  other.release();
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  assert.ok(!acquireLock(store, 'manual').ok, 'the lock is held while the run is active');
  await waitFor(() => runner.snapshot().status !== 'running');
  const again = acquireLock(store, 'manual');
  assert.ok(again.ok, 'released when the run ends');
  again.release();
  cleanup();
});

test('a stale lock (its process is gone) is taken over', () => {
  const { store, cleanup } = tempStore();
  fs.writeFileSync(store.resolve('run.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, kind: 'manual', startedAt: new Date().toISOString() }));
  assert.ok(acquireLock(store, 'scheduled').ok);
  cleanup();
});

test('an agent that goes quiet gets a plain note in the log', async () => {
  const { store, cleanup } = tempStore();
  process.env.CJA_FAKE_MODE = 'silent';
  const runner = new Runner({ store, spec, stallMs: 120 });
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  await waitFor(() => runner.recent().some((l) => l.kind === 'warn' && /No output from this agent/.test(l.text)));
  runner.stop();
  await waitFor(() => runner.snapshot().status !== 'running');
  delete process.env.CJA_FAKE_MODE;
  cleanup();
});

test('stream events: retries, usage limits and sign-in problems are shown in plain words', () => {
  const retry = summarizeEvent({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 4700, error_status: 529 });
  assert.equal(retry[0].kind, 'warn');
  assert.match(retry[0].text, /busy or unreachable \(error 529\)\. Retry 3 of 10 in 5s/);
  const limit = summarizeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
  assert.match(limit[0].text, /usage limit has been reached/);
  assert.deepEqual(summarizeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), []);
  const notIn = summarizeEvent({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
  assert.match(notIn[0].text, /press "Sign in to Claude"/);
  assert.ok(notIn[0].authProblem);
  assert.ok(authMessage('Invalid API key'));
  assert.equal(authMessage('Everything is fine'), '');
  const init = summarizeEvent({ type: 'system', subtype: 'init', tools: ['Bash'] });
  assert.ok(init.some((e) => e.defer && /browser tools/.test(e.text)), 'the browser hint is held back until the end');
});

test('log text is cleaned of terminal escapes and control characters', () => {
  assert.equal(clip('\u001b[31mred\u001b[0m and \u0000nul\u0007 bell'), 'red and nul bell');
  assert.equal(clip('a\n\n  b'), 'a b');
});

test('when sign-in is the real problem, the misleading browser-tools hint is not shown', async () => {
  const { store, cleanup } = tempStore();
  const noauth = path.join(store.dataDir, 'noauth.mjs');
  fs.writeFileSync(noauth, [
    "process.stdin.resume(); process.stdin.on('end', () => {",
    "console.log(JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] }));",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }));",
    '});',
  ].join('\n'));
  const runner = new Runner({ store, spec: { command: process.execPath, args: [noauth] } });
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  await waitFor(() => runner.snapshot().status !== 'running');
  const texts = runner.recent().map((l) => l.text).join('\n');
  assert.match(texts, /not signed in/);
  assert.doesNotMatch(texts, /browser tools are not available/);
  cleanup();
});

test('a Live run that is stopped marks claimed-but-unrecorded postings as held and warns', async () => {
  const { store, cleanup } = tempStore();
  process.env.CJA_FAKE_MODE = 'hang';
  const runner = new Runner({ store, spec });
  runner.start({ profile: sampleProfile(), mode: 'live', agents: 1 });
  await waitFor(() => runner.children.size === 1);
  claimPosting(store, { company: 'Midway Co', role: 'Engineer', url: 'https://example.com/jobs/1' }, { agent: 'agent-1', run: runner.run.id });
  claimPosting(store, { company: 'Done Co', role: 'Engineer', url: 'https://example.com/jobs/2' }, { agent: 'agent-1', run: runner.run.id });
  recordApplication(store, { status: 'submitted', company: 'Done Co', role: 'Engineer', url: 'https://example.com/jobs/2' });
  runner.stop('Stopped by you.');
  await waitFor(() => runner.snapshot().status !== 'running');
  const rows = listApplications(store);
  const midway = rows.find((r) => r.company === 'Midway Co');
  assert.equal(midway.status, 'held');
  assert.match(midway.note, /stopped while this one was in progress/);
  assert.equal(rows.find((r) => r.company === 'Done Co').status, 'submitted');
  assert.ok(runner.recent().some((l) => l.kind === 'warn' && /may have gone through/.test(l.text)));
  delete process.env.CJA_FAKE_MODE;
  cleanup();
});

test('a Practice run that records a submission says so loudly', async () => {
  const { store, cleanup } = tempStore();
  const lies = path.join(store.dataDir, 'lies.mjs');
  fs.writeFileSync(lies, [
    "process.stdin.resume(); process.stdin.on('end', () => {",
    "console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '{\"ok\":true,\"status\":\"submitted\",\"id\":\"a_1\"}' }] } }));",
    '});',
  ].join('\n'));
  const runner = new Runner({ store, spec: { command: process.execPath, args: [lies] } });
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  await waitFor(() => runner.snapshot().status !== 'running');
  assert.ok(runner.recent().some((l) => l.kind === 'error' && /Practice run recorded a SUBMITTED/.test(l.text)));
  cleanup();
});

test('old run folders are pruned, keeping the newest', () => {
  const { store, cleanup } = tempStore();
  for (let i = 0; i < 30; i++) fs.mkdirSync(store.resolve(FILES.runs, `r_${String(i).padStart(4, '0')}`));
  fs.mkdirSync(store.resolve(FILES.runs, 'not-a-run'));
  assert.equal(pruneRuns(store, 20), 10);
  const left = fs.readdirSync(store.resolve(FILES.runs)).sort();
  assert.equal(left.length, 21);
  assert.ok(left.includes('r_0029') && !left.includes('r_0000') && left.includes('not-a-run'));
  cleanup();
});

test('one agent hitting its action limit stops only that agent', async () => {
  const { store, cleanup } = tempStore();
  const mixed = path.join(store.dataDir, 'mixed.mjs');
  fs.writeFileSync(mixed, [
    "process.stdin.resume(); process.stdin.on('end', () => {",
    "if (process.env.CJA_AGENT === 'agent-1') { for (let i = 0; i < 10; i++) console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x' } }] } })); setInterval(() => {}, 1000); }",
    "else setTimeout(() => console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })), 600);",
    '});',
  ].join('\n'));
  const runner = new Runner({ store, spec: { command: process.execPath, args: [mixed] } });
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 2, maxTurns: 3 });
  await waitFor(() => runner.snapshot().status !== 'running');
  const end = runner.snapshot();
  assert.deepEqual(end.agents.map((a) => a.status), ['stopped', 'done']);
  assert.equal(end.status, 'stopped');
  assert.match(end.reason, /Action limit reached \(3 actions for agent 1\)/);
  cleanup();
});

test('the guard runs the agent with stdin passed through, and exits with its code', async () => {
  const { store, cleanup } = tempStore();
  const runner = new Runner({ store, spec, guard: true });
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  await waitFor(() => runner.snapshot().status !== 'running');
  assert.equal(runner.snapshot().status, 'finished');
  assert.equal(runner.snapshot().counts.ready, 1);
  cleanup();
});

test('the guard kills the agent if the app that started it vanishes', async () => {
  const { store, cleanup } = tempStore();
  const pidFile = path.join(store.dataDir, 'child.pid');
  const child = path.join(store.dataDir, 'sleeper.mjs');
  fs.writeFileSync(child, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  // The "app": a process that starts the guard, then gets killed without any chance to clean up.
  const app = path.join(store.dataDir, 'app.mjs');
  fs.writeFileSync(app, [
    "import { spawn } from 'node:child_process';",
    `const g = spawn(process.execPath, [${JSON.stringify(GUARD)}, String(process.pid)], { stdio: 'ignore', env: { ...process.env, CJA_GUARD_SPEC: JSON.stringify({ command: process.execPath, args: [${JSON.stringify(child)}], shell: false }) } });`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const parent = spawn(process.execPath, [app], { stdio: 'ignore' });
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim());
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));
  process.kill(parent.pid, 'SIGKILL');
  await waitFor(() => !alive(pid), 10_000);
  assert.ok(!alive(pid), 'the agent died with the app');
  cleanup();
});

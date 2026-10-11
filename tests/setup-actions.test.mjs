import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SetupJobs, installCommand, cleanLines, LOGIN_ARGS, LOGIN_DISPLAY, INSTALL_SOURCE_URL } from '../lib/setup-actions.mjs';
import { tempStore } from './helpers.mjs';

const waitFor = async (pred, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return { file: process.execPath, args: [file], display: `fake ${name}` };
}

test('the install commands are exactly the official ones, as constants', () => {
  const win = installCommand('win32');
  assert.equal(win.display, 'irm https://claude.ai/install.ps1 | iex');
  assert.equal(win.file, 'powershell.exe');
  assert.deepEqual(win.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']);
  for (const p of ['darwin', 'linux']) {
    const u = installCommand(p);
    assert.equal(u.display, 'curl -fsSL https://claude.ai/install.sh | bash');
    assert.deepEqual([u.file, ...u.args], ['bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
  }
  assert.equal(win.source, 'https://code.claude.com/docs/en/quickstart');
  assert.equal(INSTALL_SOURCE_URL, win.source);
  assert.deepEqual(LOGIN_ARGS, ['auth', 'login', '--claudeai']);
  assert.equal(LOGIN_DISPLAY, 'claude auth login --claudeai');
});

test('no install command ever carries user input: it is the same object for every call', () => {
  assert.deepEqual(installCommand('linux'), installCommand('linux'));
  // The function takes only a platform name. Whatever it is given, the command comes from the fixed table.
  assert.equal(installCommand('; rm -rf /').display, 'curl -fsSL https://claude.ai/install.sh | bash');
});

test('output cleaning drops colours and PowerShell progress noise', () => {
  assert.deepEqual(cleanLines('\u001b[32mDownloading\u001b[0m\r\n#< CLIXML\r\n<Objs Version="1.1.0.1">x</Objs>\r\n\r\nDone  \n'), ['Downloading', 'Done']);
});

test('install streams its output and ends as done; failures say the exit code', async () => {
  const { dir, cleanup } = tempStore();
  const events = [];
  const ok = new SetupJobs({ installSpec: script(dir, 'ok.mjs', "console.log('step one'); setTimeout(() => console.log('step two'), 50);") });
  ok.on('event', (e) => events.push(e));
  const snap = ok.start('install');
  assert.equal(snap.status, 'running');
  assert.equal(snap.kind, 'install');
  await waitFor(() => !ok.active);
  const end = ok.snapshot();
  assert.equal(end.status, 'done');
  assert.equal(end.exitCode, 0);
  assert.ok(end.lines.includes('step one') && end.lines.includes('step two'));
  assert.equal(events[0].start, true);
  assert.ok(events.filter((e) => e.line === 'step two').length === 1);
  assert.equal(events.at(-1).done, true);
  assert.equal(events.at(-1).status, 'done');

  const bad = new SetupJobs({ installSpec: script(dir, 'bad.mjs', "console.error('network down'); process.exit(7);") });
  bad.start('install');
  await waitFor(() => !bad.active);
  assert.equal(bad.snapshot().status, 'failed');
  assert.equal(bad.snapshot().exitCode, 7);
  assert.ok(bad.snapshot().lines.includes('network down'));
  assert.match(bad.snapshot().lines.at(-1), /exit code 7/);
  cleanup();
});

test('only one setup step at a time, and it can be cancelled', async () => {
  const { dir, cleanup } = tempStore();
  const jobs = new SetupJobs({ installSpec: script(dir, 'slow.mjs', "console.log('started'); setInterval(() => {}, 1000);") });
  jobs.start('install');
  assert.throws(() => jobs.start('install'), (e) => e.code === 'BUSY');
  await waitFor(() => jobs.snapshot().lines.includes('started'));
  jobs.cancel();
  await waitFor(() => !jobs.active);
  assert.equal(jobs.snapshot().status, 'cancelled');
  assert.equal(jobs.cancel().status, 'cancelled', 'cancelling again is harmless');
  jobs.start('install');
  jobs.cancel();
  await waitFor(() => !jobs.active);
  cleanup();
});

test('a job that takes too long is stopped', async () => {
  const { dir, cleanup } = tempStore();
  const jobs = new SetupJobs({ installSpec: script(dir, 'forever.mjs', 'setInterval(() => {}, 1000);'), timeoutMs: 200 });
  jobs.start('install');
  await waitFor(() => !jobs.active);
  assert.equal(jobs.snapshot().status, 'cancelled');
  assert.ok(jobs.snapshot().lines.some((l) => /Taking too long/.test(l)));
  cleanup();
});

test('sign in runs `claude auth login --claudeai` and never writes to its input', async () => {
  const { dir, cleanup } = tempStore();
  const argsFile = path.join(dir, 'argv.json');
  const spec = { command: process.execPath, args: [script(dir, 'login.mjs', `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
let got = '';
process.stdin.on('data', (d) => (got += d));
console.log('Opening browser to sign in...');
setTimeout(() => { console.log(got === '' ? 'stdin untouched' : 'stdin was written'); process.exit(0); }, 150);
`).args[0]] };
  const jobs = new SetupJobs({ claudeSpec: spec });
  jobs.start('login');
  await waitFor(() => !jobs.active);
  assert.equal(jobs.snapshot().status, 'done');
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), LOGIN_ARGS);
  assert.ok(jobs.snapshot().lines.includes('stdin untouched'));
  assert.equal(jobs.snapshot().command, LOGIN_DISPLAY);
  cleanup();
});

test('an unknown step is refused', () => {
  const jobs = new SetupJobs();
  assert.throws(() => jobs.start('delete-everything'), /Unknown setup step/);
});

test('the agent environment for setup jobs has no secrets', async () => {
  const { dir, cleanup } = tempStore();
  const out = path.join(dir, 'env.json');
  const jobs = new SetupJobs({
    installSpec: script(dir, 'env.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env)));`),
    env: { ...process.env, SECRET_TOKEN: 'x', ANTHROPIC_API_KEY: 'sk' },
  });
  jobs.start('install');
  await waitFor(() => !jobs.active);
  const keys = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(!keys.includes('SECRET_TOKEN') && !keys.includes('ANTHROPIC_API_KEY'));
  cleanup();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, quoteForCmd, claudeSpawnSpec, runClaude, ISOLATION_ARGS } from '../lib/claude.mjs';
import { Runner, summarizeEvent, pruneRuns } from '../lib/runner.mjs';
import { oneLine, buildPrompt } from '../lib/prompts.mjs';
import { normalizeProfile, defaultProfile, saveProfile, loadProfile, profileWarnings } from '../lib/profile.mjs';
import { prepareDataDir, createStore, FILES, defaultDataDir } from '../lib/store.mjs';
import { checkShell } from '../lib/preflight.mjs';
import { runScheduled } from '../lib/daily.mjs';
import { saveSchedule, loadSchedule } from '../lib/schedule.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { saveState } from '../lib/preflight.mjs';
import { saveResume } from '../lib/profile.mjs';
import { tempStore, sampleProfile } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const waitFor = async (pred, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

// --- environment -----------------------------------------------------------------------------------

test('CLAUDE_* is an explicit short list, so session tokens and hook secrets from a parent Claude never reach an agent', () => {
  const env = cleanEnv({
    CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_OAUTH_TOKEN: 'ok', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:/Git/bin/bash.exe',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_HOOK_SECRET: 'secret', CLAUDE_CODE_USER_EMAIL: 'a@b.c', CLAUDE_CODE_ACCOUNT_UUID: 'u', CLAUDE_CODE_SESSION_ID: 's',
    CLAUDE_CODE_API_KEY: 'k', CLAUDE_PLUGIN_ROOT: '/p', CLAUDECODE: '1',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CONFIG_DIR']);
});

// --- the cmd.exe shim --------------------------------------------------------------------------------

test('a % can never reach cmd.exe: quoting refuses it', () => {
  assert.throws(() => quoteForCmd('C:/x/100%USERNAME%/e.json'), (e) => e.code === 'UNSAFE_PATH' && /percent sign/.test(e.message));
  assert.equal(quoteForCmd('plain'), 'plain');
  assert.equal(quoteForCmd('has space'), '"has space"');
  assert.equal(quoteForCmd('a&b'), '"a&b"');
  assert.deepEqual(ISOLATION_ARGS, ['--strict-mcp-config', '--mcp-config', 'agents/empty-mcp.json'], 'no absolute app path on the command line');
});

test('a .cmd shim in a folder with spaces and symbols runs through an explicit cmd.exe (no shell:true, no deprecation notice)', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-shim A&B (x86) '));
  const shim = path.join(dir, 'claude.cmd');
  fs.writeFileSync(shim, '@echo off\r\necho ARGS:[%1] [%2] [%3]\r\n');
  const env = { ...process.env, CJA_CLAUDE: shim };
  const s = claudeSpawnSpec(['--version', 'two words', 'a&b'], null, env);
  assert.match(path.basename(s.command).toLowerCase(), /^cmd(\.exe)?$/);
  assert.deepEqual(s.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(s.options.shell, false);
  assert.equal(s.options.windowsVerbatimArguments, true);
  const r = await runClaude(['--version', 'two words', 'a&b'], { env });
  assert.equal(r.ok, true, r.stderr);
  assert.match(r.stdout, /ARGS:\[--version\] \["two words"\] \["a&b"\]/);
  assert.ok(!/DEP0190|DeprecationWarning/.test(r.stderr));
  fs.rmSync(dir, { recursive: true, force: true });
  // A shim whose own path has a percent sign is refused with a plain sentence rather than run changed.
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-100%PATH%-'));
  fs.writeFileSync(path.join(bad, 'claude.cmd'), '@echo off\r\n');
  assert.throws(() => claudeSpawnSpec(['--version'], null, { ...process.env, CJA_CLAUDE: path.join(bad, 'claude.cmd') }), (e) => e.code === 'UNSAFE_PATH');
  fs.rmSync(bad, { recursive: true, force: true });
});

// --- logs ---------------------------------------------------------------------------------------------

test('the log says that something was typed, never what', () => {
  const typed = summarizeEvent({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'mcp__claude-in-chrome__form_input', input: { ref: 'ref_12', value: 'alex.rivera@example.com' } },
    { type: 'tool_use', name: 'mcp__claude-in-chrome__computer', input: { action: 'type', text: '(555) 010-0142' } },
    { type: 'tool_use', name: 'mcp__claude-in-chrome__computer', input: { action: 'left_click', coordinate: [10, 20] } },
  ] } });
  const all = typed.map((e) => e.text).join('\n');
  assert.doesNotMatch(all, /alex\.rivera|555|010-0142/);
  assert.match(typed[0].text, /ref_12 \(23 characters\)/);
  assert.match(typed[1].text, /type \(14 characters\)/);
  assert.match(typed[2].text, /left_click \(10,20\)/);
});

test('raw stream lines stay in the run folder: the API and live events never carry them', async () => {
  const { store, cleanup } = tempStore();
  const runner = new Runner({ store, spec: { command: process.execPath, args: [FAKE] } });
  const seen = [];
  runner.on('log', (e) => seen.push(e));
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  await waitFor(() => runner.snapshot().status !== 'running');
  assert.ok(seen.length > 3);
  for (const e of [...seen, ...runner.recent()]) assert.ok(!('raw' in e), JSON.stringify(e));
  const runDir = path.join(store.dataDir, 'runs', runner.snapshot().id);
  assert.match(fs.readFileSync(path.join(runDir, 'agent-1.jsonl'), 'utf8'), /"type":"system"/, 'the transcript is on disk, privately');
  cleanup();
});

test('Node deprecation notices on an agent\'s stderr are not shown as errors', async () => {
  const { store, cleanup } = tempStore();
  const noisy = path.join(store.dataDir, 'noisy.mjs');
  fs.writeFileSync(noisy, "process.stdin.resume(); process.stdin.on('end', () => { console.error('(node:1) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true'); console.error('(Use `node --trace-deprecation ...` to show where the warning was created)'); console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })); });");
  const runner = new Runner({ store, spec: { command: process.execPath, args: [noisy] } });
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  await waitFor(() => runner.snapshot().status !== 'running');
  assert.ok(!runner.recent().some((l) => /DEP0190|trace-deprecation/.test(l.text)));
  cleanup();
});

// --- prompts and profile ----------------------------------------------------------------------------

test('NEL, line and paragraph separators and old C0 separators cannot start a line inside the prompt', () => {
  for (const sep of ['\u0085', '\u2028', '\u2029', '\u001c', '\u001d', '\u001e', '\r', '\n']) {
    assert.ok(!/[\n\r\u0085\u2028\u2029\u001c-\u001e]/.test(oneLine(`a${sep}# Heading${sep}b`)), JSON.stringify(sep));
  }
  const p = sampleProfile({ about: { fullName: 'Alex\u0085# New rules', city: 'Austin\u2028## x' } });
  const out = buildPrompt({ profile: p, mode: 'practice' });
  assert.doesNotMatch(out, /[\u0085\u2028\u2029]/);
  const q = normalizeProfile({ qa: [{ q: 'Q?', a: 'yes\u0085# SYSTEM\u001eover' }] }, defaultProfile());
  assert.doesNotMatch(q.qa[0].a, /[\u0085\u001e]/);
});

test('pruning refuses to walk through a linked runs folder', () => {
  const { store, dir, cleanup } = tempStore();
  const elsewhere = fs.mkdtempSync(path.join(path.dirname(dir), 'cja-else-'));
  for (let i = 0; i < 25; i++) fs.mkdirSync(path.join(elsewhere, `r_${String(i).padStart(4, '0')}`));
  fs.rmSync(path.join(dir, 'runs'), { recursive: true });
  try {
    fs.symlinkSync(elsewhere, path.join(dir, 'runs'), 'junction');
  } catch {
    fs.rmSync(elsewhere, { recursive: true, force: true });
    cleanup();
    return;
  }
  assert.equal(pruneRuns(store, 5), 0);
  assert.equal(fs.readdirSync(elsewhere).length, 25, 'nothing was deleted through the link');
  fs.rmSync(path.join(dir, 'runs'), { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
  cleanup();
});

// --- where the data lives ------------------------------------------------------------------------------

test('an older install\'s ./data folder is moved out of the app folder, once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-root-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-home-'));
  const env = { LOCALAPPDATA: path.join(home, 'Local') };
  const opts = { root, home, platform: process.platform };
  const legacy = path.join(root, 'data');
  fs.mkdirSync(path.join(legacy, 'resume'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'runs', 'r_1'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'profile.json'), '{"about":{"fullName":"Pat"}}');
  fs.writeFileSync(path.join(legacy, 'applications.jsonl'), '{"a":1}\n');
  fs.writeFileSync(path.join(legacy, 'resume', 'cv.pdf'), '%PDF-1.4');
  const r = prepareDataDir(env, opts);
  const target = defaultDataDir(env, opts);
  assert.equal(r.dir, target);
  assert.match(r.note, /Moved your data from .*data to /);
  assert.equal(r.migratedFrom, legacy);
  assert.match(fs.readFileSync(path.join(target, 'profile.json'), 'utf8'), /Pat/);
  assert.ok(fs.existsSync(path.join(target, 'resume', 'cv.pdf')));
  assert.ok(fs.existsSync(path.join(target, 'runs', 'r_1')));
  assert.ok(!fs.existsSync(legacy), 'nothing is left in the app folder');
  assert.deepEqual(prepareDataDir(env, opts), { dir: target }, 'a second start does not move anything');
  // Choosing a folder yourself is respected and nothing is moved.
  fs.mkdirSync(path.join(legacy), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'profile.json'), '{}');
  assert.deepEqual(prepareDataDir({ ...env, CJA_DATA_DIR: path.join(home, 'mine') }, opts), { dir: path.join(home, 'mine') });
  assert.ok(fs.existsSync(path.join(legacy, 'profile.json')));
  for (const d of [root, home]) fs.rmSync(d, { recursive: true, force: true });
});

test('a data folder that already existed is never rewritten, only reported on when it is exposed', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-open-'));
  fs.chmodSync(dir, 0o755);
  const store = createStore(dir);
  store.ensure();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755, 'ensure on an existing folder leaves its mode alone');
  assert.equal(store.checkExposure(), true);
  assert.match(profileWarnings(store, loadProfile(store)).map((w) => w.text).join(' '), /can be read by other accounts.*chmod 700/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder the app creates is private from the start', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-new-'));
  const dir = path.join(parent, 'fresh');
  const store = createStore(dir);
  store.ensure();
  if (process.platform === 'win32') {
    const acl = fs.existsSync(dir) ? JSON.stringify(store.checkExposure()) : '';
    assert.equal(acl, 'false', 'no Everyone, Users or Authenticated Users entries');
  } else assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.rmSync(parent, { recursive: true, force: true });
});

// --- requirements: Git Bash -------------------------------------------------------------------------------

test('Windows needs Git Bash for the agents\' one shell command: found, or a plain warning (never a stop)', () => {
  assert.equal(checkShell({ platform: 'linux' }), null);
  assert.equal(checkShell({ platform: 'darwin' }), null);
  const found = checkShell({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' }, exists: (p) => /Program Files.Git.bin.bash\.exe$/.test(p), which: () => null });
  assert.equal(found.status, 'ok');
  const viaEnv = checkShell({ platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\tools\\bash.exe' }, exists: (p) => p === 'D:\\tools\\bash.exe', which: () => null });
  assert.equal(viaEnv.status, 'ok');
  const missing = checkShell({ platform: 'win32', env: {}, exists: () => false, which: () => null });
  assert.equal(missing.status, 'warn', 'a warning, not a fail');
  assert.match(missing.hint, /git-scm\.com/);
  assert.match(missing.hint, /recording results/);
});

// --- a skipped scheduled run is not a result --------------------------------------------------------------

test('a scheduled run that steps aside for a manual run does not replace the last real result', async () => {
  const { store, cleanup } = tempStore();
  saveProfile(store, JSON.parse(JSON.stringify(sampleProfile())));
  saveResume(store, 'cv.pdf', Buffer.from('%PDF-1.4 x'));
  saveState(store, { linkedinConfirmed: true });
  const real = { startedAt: '2026-10-10T08:10:00.000Z', finishedAt: '2026-10-10T08:50:00.000Z', status: 'finished', submitted: 0, ready: 5, held: 1, skipped: 2, error: '', digest: '2026-10-10' };
  saveSchedule(store, { enabled: true, savedAt: new Date().toISOString(), lastRun: real });
  const lock = acquireLock(store, 'manual');
  const r = await runScheduled({ store, deps: { preflight: async () => ({ rows: [] }), browserRunning: async () => true, testConnection: async () => ({ ok: true }), sleep: async () => {} } });
  assert.equal(r.status, 'skipped');
  const after = loadSchedule(store);
  assert.deepEqual(after.lastRun, real, 'the real last result is untouched');
  assert.match(after.lastSkipped.error, /already running/);
  lock.release();
  cleanup();
});

// --- source checks for the pages -----------------------------------------------------------------------------

test('Needs your input treats CAPTCHA, account and password walls like emailed codes: no answer box, no "remember"', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'view-input.js'), 'utf8');
  assert.match(src, /Blocked by a CAPTCHA/);
  assert.match(src, /Needs an account or a password/);
  assert.match(src, /captcha\|verify you are human/);
  const re = /(needs|requires?|wants?|blocked by|behind|asks? for).{0,40}(an? account|password|sign.?in|log.?in)/i;
  assert.ok(re.test('Needs an account or password to apply'));
  assert.ok(re.test('Blocked by a sign-in wall'));
  assert.ok(!re.test('Do you have experience with password managers?'));
  assert.ok(!re.test("Do you have a valid driver's license?"));
});

test('the Applications page can be sorted, the resume picker has a visible focus ring, and the dialogs close on a backdrop click', () => {
  const apps = fs.readFileSync(path.join(ROOT, 'public', 'js', 'view-applications.js'), 'utf8');
  assert.match(apps, /Sort applications by/);
  for (const k of ['newest', 'oldest', 'company', 'pay', 'status']) assert.match(apps, new RegExp(`${k}: \\[`));
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  assert.match(css, /#resume-file:focus-visible \+ \.dropzone \{ outline: 2px solid/);
  assert.match(fs.readFileSync(path.join(ROOT, 'public', 'js', 'view-dashboard.js'), 'utf8'), /e\.target === dlg/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public', 'js', 'view-dashboard.js'), 'utf8'), /e\.raw/);
  const sched = fs.readFileSync(path.join(ROOT, 'public', 'js', 'view-schedule.js'), 'utf8');
  assert.match(sched, /liveInput\.checked = false/);
  assert.match(sched, /toUpperCase\(\)/);
  const comp = fs.readFileSync(path.join(ROOT, 'public', 'js', 'components.js'), 'utf8');
  assert.match(comp, /term-row/);
  assert.match(comp, /label: 'Dismiss'/);
});

test('Start.bat does not let the current folder override Node.js', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'Start.bat'), 'utf8');
  assert.ok(bat.indexOf('NoDefaultCurrentDirectoryInExePath=1') > bat.indexOf('cd /d'));
  assert.ok(bat.indexOf('NoDefaultCurrentDirectoryInExePath=1') < bat.indexOf('where node'));
});

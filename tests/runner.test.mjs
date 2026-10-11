import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner, summarizeEvent, buildClaudeArgs, ALLOWED_TOOLS, DENIED_TOOLS, FETCH_DOMAINS, CHROME_TOOLS, clip, authMessage, pruneRuns } from '../lib/runner.mjs';
import { cleanEnv } from '../lib/claude.mjs';
import { tempStore, sampleProfile } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const spec = { command: process.execPath, args: [FAKE] };

const waitFor = async (pred, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('claude arguments never include the dangerous flag and keep Bash narrow', () => {
  const args = buildClaudeArgs();
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--allow-dangerously-skip-permissions'));
  assert.deepEqual(args.slice(0, 2), ['-p', '--chrome']);
  assert.ok(args.includes('stream-json') && args.includes('--verbose'));
  const bash = ALLOWED_TOOLS.filter((t) => t.startsWith('Bash'));
  assert.deepEqual(bash, ['Bash(node tools/log.mjs:*)']);
  assert.ok(ALLOWED_TOOLS.includes('mcp__claude-in-chrome__navigate'));
  assert.equal(args[args.indexOf('--allowedTools')], '--allowedTools');
  assert.ok(!buildClaudeArgs({ chrome: false }).includes('--chrome'));
  assert.ok(args.includes('--strict-mcp-config'), 'agents get no connectors except Claude in Chrome');
  const tools = args.slice(args.indexOf('--tools') + 1, args.indexOf('--tools') + 4);
  assert.deepEqual(tools, ['WebFetch', 'WebSearch', 'Bash']);
});

test("the agent is locked to the allow-list: the person's own Claude settings are ignored and nothing prompts", () => {
  const args = buildClaudeArgs();
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!ALLOWED_TOOLS.some((t) => /^(Read|Edit|Write)/.test(t)), 'no file tools');
  assert.ok(!ALLOWED_TOOLS.some((t) => t.endsWith('*')), 'no wildcards: every Chrome tool is named');
  assert.ok(CHROME_TOOLS.length >= 10 && CHROME_TOOLS.every((t) => t.startsWith('mcp__claude-in-chrome__')));
  assert.ok(!ALLOWED_TOOLS.includes('WebFetch'), 'WebFetch is only allowed per domain');
  for (const d of FETCH_DOMAINS) assert.ok(ALLOWED_TOOLS.includes(`WebFetch(domain:${d})`), d);
  for (const t of ['javascript_tool', 'gif_creator', 'upload_image', 'read_network_requests', 'browser_batch', 'shortcuts_execute']) {
    assert.ok(DENIED_TOOLS.includes(`mcp__claude-in-chrome__${t}`), t);
    assert.ok(!ALLOWED_TOOLS.includes(`mcp__claude-in-chrome__${t}`), t);
  }
  const denied = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--allowedTools'));
  assert.deepEqual(denied, DENIED_TOOLS);
  assert.ok(args.indexOf('--allowedTools') > args.indexOf('--disallowedTools'), '--allowedTools stays last: it takes a list');
});

test('agents get an allow-listed environment, never tokens, keys or passwords', () => {
  const env = cleanEnv({
    PATH: '/bin', Path: 'x', HOME: '/h', USERPROFILE: 'u', APPDATA: 'a', SystemRoot: 'w', LANG: 'en_US', LC_ALL: 'C', TEMP: 't',
    CJA_DATA_DIR: '/d', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_BASE_URL: 'http://proxy', HTTPS_PROXY: 'http://p:1',
    ANTHROPIC_API_KEY: 'sk-1', ANTHROPIC_AUTH_TOKEN: 't', GITHUB_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 'a', NPM_TOKEN: 'n', MY_PASSWORD: 'p',
    SSH_AUTH_SOCK: 's', OPENAI_API_KEY: 'o', CLAUDE_CODE_API_KEY: 'x', NODE_OPTIONS: '--require evil', GOOGLE_APPLICATION_CREDENTIALS: 'g',
  });
  for (const keep of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'SystemRoot', 'LANG', 'LC_ALL', 'TEMP', 'CJA_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY']) assert.ok(keep in env, keep);
  for (const drop of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'MY_PASSWORD', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CLAUDE_CODE_API_KEY', 'NODE_OPTIONS', 'GOOGLE_APPLICATION_CREDENTIALS']) assert.ok(!(drop in env), drop);
});

test('summarizeEvent turns stream-json into readable lines', () => {
  const s1 = summarizeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello there' }, { type: 'tool_use', name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://example.com' } }] } });
  assert.equal(s1[0].kind, 'say');
  assert.equal(s1[1].kind, 'tool');
  assert.match(s1[1].text, /browser navigate\s+https:\/\/example\.com/);
  const rec = summarizeEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: '{"ok":true,"status":"held","id":"x"}' }] } });
  assert.equal(rec[0].kind, 'record');
  assert.equal(rec[0].record, 'held');
  assert.equal(summarizeEvent({ type: 'result', subtype: 'success', num_turns: 4, result: 'done' })[0].kind, 'result');
  assert.equal(summarizeEvent({ type: 'result', subtype: 'error_max_turns', is_error: true })[0].kind, 'error');
  const warn = summarizeEvent({ type: 'system', subtype: 'init', tools: ['Read'] });
  assert.ok(warn.some((e) => e.kind === 'error' && /browser tools/.test(e.text)));
  assert.deepEqual(summarizeEvent(null), []);
});

test('smoke: the runner spawns an agent, streams its output, and finishes cleanly', async () => {
  const { store, cleanup } = tempStore();
  const argsFile = path.join(store.dataDir, 'args.jsonl');
  process.env.CJA_FAKE_ARGS_FILE = argsFile;
  const runner = new Runner({ store, spec, chrome: true });
  const logs = [];
  runner.on('log', (e) => logs.push(e));
  const snap = runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  assert.equal(snap.status, 'running');
  await waitFor(() => runner.snapshot().status !== 'running');
  const end = runner.snapshot();
  assert.equal(end.status, 'finished');
  assert.equal(end.agents[0].status, 'done');
  assert.equal(end.counts.ready, 1);
  const kinds = logs.map((l) => l.kind);
  for (const k of ['say', 'tool', 'record', 'result']) assert.ok(kinds.includes(k), `missing ${k}: ${kinds}`);
  const seen = JSON.parse(fs.readFileSync(argsFile, 'utf8').trim().split('\n')[0]);
  assert.ok(seen.promptLength > 2000, 'the prompt arrives on stdin');
  assert.equal(seen.agent, 'agent-1');
  assert.equal(seen.dataDir, store.dataDir);
  assert.ok(!seen.argv.join(' ').includes('Alex Rivera'), 'personal details never appear on the command line');
  const runDir = path.join(store.dataDir, 'runs', end.id);
  assert.ok(fs.existsSync(path.join(runDir, 'run.log')));
  assert.ok(fs.existsSync(path.join(runDir, 'agent-1.jsonl')));
  delete process.env.CJA_FAKE_ARGS_FILE;
  cleanup();
});

test('stop kills a hanging agent and the run ends as stopped', async () => {
  const { store, cleanup } = tempStore();
  process.env.CJA_FAKE_MODE = 'hang';
  const runner = new Runner({ store, spec });
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 2 });
  await waitFor(() => runner.children.size === 2 && runner.recent().some((l) => l.kind === 'say'));
  const pids = [...runner.children.values()].map((c) => c.pid);
  assert.throws(() => runner.start({ profile: sampleProfile() }), /already in progress/);
  runner.stop('Stopped by you.');
  await waitFor(() => runner.snapshot().status !== 'running');
  assert.equal(runner.snapshot().status, 'stopped');
  await new Promise((r) => setTimeout(r, 300));
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), 'process is gone');
  }
  delete process.env.CJA_FAKE_MODE;
  cleanup();
});

test('the turn cap stops a runaway agent', async () => {
  const { store, cleanup } = tempStore();
  process.env.CJA_FAKE_MODE = 'tools';
  const runner = new Runner({ store, spec });
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1, maxTurns: 3 });
  await waitFor(() => runner.snapshot().status !== 'running');
  assert.equal(runner.snapshot().status, 'stopped');
  assert.match(runner.snapshot().reason, /Action limit/);
  delete process.env.CJA_FAKE_MODE;
  cleanup();
});

test('a missing Claude CLI fails the run with a plain message', async () => {
  const { store, cleanup } = tempStore();
  const runner = new Runner({ store, spec: { command: path.join(store.dataDir, 'does-not-exist'), args: [] } });
  const logs = [];
  runner.on('log', (e) => logs.push(e));
  runner.start({ profile: sampleProfile(), mode: 'practice', agents: 1 });
  await waitFor(() => runner.snapshot().status !== 'running');
  assert.equal(runner.snapshot().status, 'failed');
  assert.ok(logs.some((l) => l.kind === 'error'));
  cleanup();
});

test('a held-retry run needs answered held questions', () => {
  const { store, cleanup } = tempStore();
  const runner = new Runner({ store, spec });
  assert.throws(() => runner.start({ profile: sampleProfile(), task: 'held' }), /nothing on hold/i);
  cleanup();
});

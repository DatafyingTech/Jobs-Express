// Runs the agents. Each agent is one `claude -p` process driving the person's own Chrome.
//
// Safety posture:
//   * never uses --dangerously-skip-permissions, never asks (permission mode dontAsk), and ignores the person's own
//     Claude settings (--setting-sources project), so nothing but the allow-list below can run
//   * no Read, Edit or Write tool; WebFetch only reaches the public job feeds; named Chrome tools only
//   * Bash is limited to the logging helper (Bash(node tools/log.mjs:*)) plus the read-only commands Claude Code
//     always permits
//   * the prompt goes in on stdin, so it never appears in a process list
//   * agents get an allow-listed environment, not the whole shell (no tokens, no keys)
//   * every run has a time cap and a turn cap, and can be stopped (the whole process tree is killed), and each agent
//     runs under tools/guard.mjs so it dies with the app even if the app is killed
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { ROOT, FILES, newId } from './store.mjs';
import { claudeSpawnSpec, killTree, killTreeSync, cleanEnv, ISOLATION_ARGS } from './claude.mjs';
import { buildPrompt, planAgents } from './prompts.mjs';
import { listRetryable, listApplications, recordApplication, appKey } from './store.mjs';
import { acquireLock, describeHolder } from './lock.mjs';

// The Chrome tools an agent needs, named one by one. Anything not listed here is denied (permission mode dontAsk).
export const CHROME_TOOLS = [
  'computer', 'file_upload', 'find', 'form_input', 'get_page_text', 'list_connected_browsers', 'navigate', 'read_page',
  'resize_window', 'select_browser', 'switch_browser', 'tabs_close_mcp', 'tabs_context_mcp', 'tabs_create_mcp',
].map((t) => `mcp__claude-in-chrome__${t}`);

// Chrome tools that are removed from the agent's world: they run page scripts, record or upload screenshots,
// read network traffic, or batch other tools together, and no application step needs them.
export const DENIED_TOOLS = [
  'browser_batch', 'gif_creator', 'javascript_tool', 'read_console_messages', 'read_network_requests',
  'shortcuts_execute', 'shortcuts_list', 'upload_image',
].map((t) => `mcp__claude-in-chrome__${t}`);

// The only addresses WebFetch may read: the public job feeds the prompts name, and Hacker News for "Who is hiring".
export const FETCH_DOMAINS = [
  'boards-api.greenhouse.io', 'api.ashbyhq.com', 'api.lever.co', 'hn.algolia.com', 'news.ycombinator.com', 'himalayas.app',
];

// No Read, Edit or Write: agents never need to open local files (the resume goes straight to the upload tool).
// Bash is allowed for the logging helper only (plus whatever read-only commands Claude Code always permits).
export const ALLOWED_TOOLS = [
  ...CHROME_TOOLS,
  ...FETCH_DOMAINS.map((d) => `WebFetch(domain:${d})`),
  'WebSearch',
  'Bash(node tools/log.mjs:*)',
];

export function buildClaudeArgs({ chrome = true, allowedTools = ALLOWED_TOOLS } = {}) {
  const args = ['-p'];
  if (chrome) args.push('--chrome');
  args.push('--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--disable-slash-commands');
  args.push(...ISOLATION_ARGS);
  // Ignore the person's own Claude settings (their allow rules, hooks, default permission mode and plugins would
  // otherwise widen what an agent can do), and never prompt: anything not in the allow-list is simply denied.
  args.push('--setting-sources', 'project', '--permission-mode', 'dontAsk');
  // Only the built-in tools the agents need exist at all. No Read, Edit, Write or PowerShell.
  args.push('--tools', 'WebFetch', 'WebSearch', 'Bash');
  args.push('--disallowedTools', ...DENIED_TOOLS);
  // Last on purpose: --allowedTools takes a list.
  args.push('--allowedTools', ...allowedTools);
  return args;
}

// --- turning stream-json into readable lines ----------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_AND_CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export const clip = (s, n = 400) => {
  const t = String(s ?? '').replace(ANSI_AND_CONTROL, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Turn "not logged in" style failures into something the person can act on. Returns '' for anything else. */
export function authMessage(text) {
  return /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired|credit balance is too low/i.test(String(text || ''))
    ? 'Claude Code is not signed in, or its sign-in has expired. Open Jobs Express, go to Settings, Requirements, and press "Sign in to Claude", then try again.'
    : '';
}

function toolLabel(name) {
  const m = /^mcp__claude-in-chrome__(.+)$/.exec(name || '');
  if (m) return 'browser ' + m[1].replace(/_mcp$/, '').replace(/_/g, ' ');
  return String(name || 'tool');
}

function toolDetail(name, input = {}) {
  if (!input || typeof input !== 'object') return '';
  const short = (name || '').replace(/^mcp__claude-in-chrome__/, '');
  if (name === 'Bash') return clip(input.command, 300);
  if (input.url) return clip(input.url, 200);
  if (input.query) return clip(input.query, 200);
  if (short === 'computer') {
    const bits = [input.action, input.text && `"${clip(input.text, 60)}"`, input.ref, input.coordinate && `(${input.coordinate.join(',')})`];
    return bits.filter(Boolean).join(' ');
  }
  if (short === 'form_input') return clip(`${input.ref ?? ''} = ${typeof input.value === 'string' ? input.value : JSON.stringify(input.value)}`, 160);
  if (short === 'find') return clip(input.query, 120);
  if (input.file_path) return clip(input.file_path, 200);
  if (input.text) return clip(input.text, 160);
  return '';
}

/**
 * Convert one parsed stream-json object into zero or more readable log entries.
 * Returns an array of { kind, text, record? }. kind is system | say | tool | result | error | record.
 */
export function summarizeEvent(obj) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  switch (obj.type) {
    case 'system': {
      if (obj.subtype === 'init') {
        const tools = Array.isArray(obj.tools) ? obj.tools : [];
        const hasChrome = tools.some((t) => String(t).includes('claude-in-chrome'));
        out.push({ kind: 'system', text: `Agent started${obj.model ? ` (${obj.model})` : ''}.` });
        if (!hasChrome && tools.length) {
          // Held back until the agent ends: if the real problem is "not signed in", this hint would only mislead.
          out.push({ kind: 'error', defer: true, text: 'The browser tools are not available to this agent. Check "Claude in Chrome extension" in Settings and run Test connection.' });
        }
      } else if (obj.subtype === 'api_retry') {
        const wait = Math.max(0, Math.round((Number(obj.retry_delay_ms) || 0) / 1000));
        out.push({ kind: 'warn', text: `Claude is busy or unreachable${obj.error_status ? ` (error ${obj.error_status})` : ''}. Retry ${obj.attempt ?? '?'} of ${obj.max_retries ?? '?'} in ${wait}s.` });
      }
      break;
    }
    case 'rate_limit_event': {
      const info = obj.rate_limit_info || {};
      if (info.status && info.status !== 'allowed' && info.status !== 'allowed_warning') {
        const when = Number(info.resetsAt) ? ` It resets around ${new Date(Number(info.resetsAt) * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : '';
        out.push({ kind: 'warn', text: `Your Claude plan's usage limit has been reached (${info.status}).${when}` });
      } else if (info.status === 'allowed_warning') {
        out.push({ kind: 'warn', text: 'You are close to your Claude plan\'s usage limit.' });
      }
      break;
    }
    case 'assistant': {
      const content = obj.message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) out.push({ kind: 'say', text: clip(block.text, 700) });
        else if (block.type === 'tool_use') out.push({ kind: 'tool', text: `${toolLabel(block.name)}  ${toolDetail(block.name, block.input)}`.trim(), tool: block.name });
      }
      break;
    }
    case 'user': {
      const content = obj.message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c) => c.text || '').join(' ') : '';
        const m = /\{"ok":true,"status":"(submitted|ready|held|skipped)"/.exec(text);
        if (m) out.push({ kind: 'record', text: `Recorded: ${m[1]}`, record: m[1] });
        else if (block.is_error) out.push({ kind: 'error', text: clip(text, 300) || 'A tool call failed.' });
      }
      break;
    }
    case 'result': {
      const secs = obj.duration_ms ? ` in ${Math.round(obj.duration_ms / 1000)}s` : '';
      if (obj.is_error || (obj.subtype && obj.subtype !== 'success')) {
        const auth = authMessage(obj.result);
        out.push({ kind: 'error', authProblem: !!auth, text: auth || clip(obj.result || `Agent stopped: ${obj.subtype}`, 500) });
      } else {
        out.push({ kind: 'result', text: `Finished${obj.num_turns ? ` after ${obj.num_turns} turns` : ''}${secs}. ${clip(obj.result, 600)}`.trim() });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// --- the runner ------------------------------------------------------------------------------

const GUARD = path.join(ROOT, 'tools', 'guard.mjs');
export const KEEP_RUNS = 20;
export const MAX_RAW_LINE = 256 * 1024;
export const DEFAULT_STALL_MS = 5 * 60_000;

/** Delete the oldest run folders (logs and raw transcripts), keeping the newest `keep`. */
export function pruneRuns(store, keep = KEEP_RUNS) {
  try {
    const dir = store.resolve(FILES.runs);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('r_'));
    // Run ids start with a base-36 timestamp, so name order is age order.
    const old = entries.map((e) => e.name).sort().slice(0, Math.max(0, entries.length - keep));
    for (const name of old) fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return old.length;
  } catch {
    return 0;
  }
}

export class Runner extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.store    lib/store.mjs store
   * @param {object} [o.spec]   override how the CLI is started (tests use a fake CLI)
   * @param {boolean} [o.chrome] pass --chrome (default true)
   * @param {string} [o.cwd]    working directory for agents (default: repo root, so tools/log.mjs resolves)
   * @param {boolean} [o.guard] run each agent under tools/guard.mjs so it dies if this process does (default: on, except with a test spec)
   * @param {number} [o.stallMs] how long an agent may be silent before the log says so
   */
  constructor({ store, spec = null, chrome = true, cwd = ROOT, env = process.env, guard = !spec, stallMs = DEFAULT_STALL_MS } = {}) {
    super();
    this.store = store;
    this.spec = spec;
    this.chrome = chrome;
    this.cwd = cwd;
    this.env = env;
    this.guard = guard;
    this.stallMs = stallMs;
    this.run = null;
    this.children = new Map();
    this.buffer = [];
    this.seq = 0;
    this.timers = [];
  }

  snapshot() {
    if (!this.run) return { status: 'idle' };
    const { id, status, mode, task, startedAt, endedAt, agents, reason, counts } = this.run;
    return {
      id, status, mode, task, startedAt, endedAt, reason,
      agents: agents.map((a) => ({ number: a.number, status: a.status, turns: a.turns, limit: a.limit, sources: a.sources })),
      counts: { ...counts },
    };
  }

  recent(n = 300) {
    return this.buffer.slice(-n);
  }

  get active() {
    return !!this.run && this.run.status === 'running';
  }

  log(agent, kind, text, raw) {
    const entry = { seq: ++this.seq, ts: new Date().toISOString(), run: this.run?.id, agent, kind, text };
    if (raw) entry.raw = raw.length > 1500 ? raw.slice(0, 1500) + '…' : raw;
    this.buffer.push(entry);
    if (this.buffer.length > 600) this.buffer.splice(0, this.buffer.length - 600);
    try {
      if (this.run?.logFile) fs.appendFileSync(this.run.logFile, `${entry.ts} [${agent ? 'agent ' + agent : 'run'}] ${kind}: ${text}\n`, { mode: 0o600 });
    } catch {
      /* logging must never break a run */
    }
    this.emit('log', entry);
    return entry;
  }

  /**
   * Start a run. Returns the snapshot. Throws if one is already running.
   * opts: { profile, mode, agents, limit, task: 'search'|'held', maxMinutes, maxTurns, promptOverride,
   *         variant: 'standard'|'fresh-only', freshHours, lock (a lock the caller already holds), lockKind }
   */
  start(opts) {
    if (this.active) throw new Error('A run is already in progress.');
    const { profile } = opts;
    const mode = opts.mode === 'live' ? 'live' : 'practice';
    const task = opts.task === 'held' ? 'held' : 'search';
    const held = task === 'held' ? listRetryable(this.store) : [];
    if (task === 'held' && !held.length) throw new Error('There is nothing on hold.');
    const maxMinutes = Math.max(1, Math.round(Number(opts.maxMinutes ?? profile.settings?.maxMinutes ?? 45)));
    const maxTurns = Number(opts.maxTurns ?? profile.settings?.maxTurns ?? 200);
    const plans = planAgents(profile, { agents: opts.agents ?? profile.settings?.agents ?? 1, limit: opts.limit, task, held });

    this.store.ensure();
    // One run at a time across the whole machine: a scheduled run, a manual run and a second app window all share this lock.
    this.ownedLock = null;
    if (!opts.lock) {
      const got = acquireLock(this.store, opts.lockKind || 'manual');
      if (!got.ok) {
        const err = new Error(`Not started: ${describeHolder(got.holder)} is already running. Wait for it to finish, or stop it first.`);
        err.code = 'LOCKED';
        throw err;
      }
      this.ownedLock = got;
    }
    try {
      pruneRuns(this.store);
      const id = newId('r_');
      const dir = this.store.resolve(FILES.runs, id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.run = {
        id, mode, task, status: 'running', startedAt: new Date().toISOString(), endedAt: null, reason: '',
        dir, logFile: path.join(dir, 'run.log'), stopping: false, maxMinutes,
        counts: { submitted: 0, ready: 0, held: 0, skipped: 0 },
        agents: plans.map((p) => ({ number: p.number, status: 'starting', turns: 0, limit: p.limit, sources: p.sources, plan: p })),
      };
      this.children.clear();
      this.log(null, 'system', `Run started in ${mode === 'live' ? 'Live' : 'Practice'} mode with ${plans.length} agent${plans.length > 1 ? 's' : ''}.`);

      for (const agent of this.run.agents) {
        this.spawnAgent(agent, { profile, mode, maxTurns, promptOverride: opts.promptOverride, variant: opts.variant, freshHours: opts.freshHours });
      }

      const t = setTimeout(() => this.stop(`Time limit reached (${maxMinutes} minutes).`), maxMinutes * 60_000);
      t.unref?.();
      this.timers.push(t);
      if (this.stallMs > 0) {
        const w = setInterval(() => this.checkStalls(), Math.min(30_000, Math.max(50, this.stallMs / 2)));
        w.unref?.();
        this.timers.push(w);
      }
    } catch (e) {
      this.ownedLock?.release();
      this.ownedLock = null;
      for (const t of this.timers) clearTimeout(t);
      for (const t of this.timers) clearInterval(t);
      this.timers = [];
      for (const child of this.children.values()) killTree(child);
      if (this.run && this.run.status === 'running') this.run.status = 'failed';
      throw e;
    }
    this.emit('run', this.snapshot());
    return this.snapshot();
  }

  checkStalls() {
    const run = this.run;
    if (!run || run.status !== 'running' || run.stopping) return;
    const now = Date.now();
    for (const a of run.agents) {
      if (a.status !== 'running') continue;
      const quiet = now - (a.lastOutput || now);
      if (quiet >= this.stallMs && now - (a.lastStallNote || 0) >= this.stallMs) {
        a.lastStallNote = now;
        const mins = Math.max(1, Math.round(quiet / 60_000));
        this.log(a.number, 'warn', `No output from this agent for ${mins} minute${mins === 1 ? '' : 's'}. It may be waiting on a page, or Chrome may be showing a dialog. Press Stop if it does not recover.`);
      }
    }
  }

  spawnAgent(agent, { profile, mode, maxTurns, promptOverride, variant, freshHours }) {
    const run = this.run;
    const prompt = promptOverride ?? buildPrompt({ profile, mode, plan: agent.plan, variant, freshHours, maxTurns });
    const rawFile = path.join(run.dir, `agent-${agent.number}.jsonl`);
    let child;
    try {
      const s = claudeSpawnSpec(buildClaudeArgs({ chrome: this.chrome }), this.spec, this.env);
      const env = {
        ...cleanEnv(this.env),
        CJA_DATA_DIR: this.store.dataDir,
        CJA_AGENT: `agent-${agent.number}`,
        CJA_RUN: run.id,
        CJA_MODE: mode,
      };
      let command = s.command;
      let args = s.args;
      let options = s.options;
      if (this.guard) {
        // The guard starts the real command and kills it if this process disappears.
        env.CJA_GUARD_SPEC = JSON.stringify({ command: s.command, args: s.args, shell: !!s.options?.shell });
        command = process.execPath;
        args = [GUARD, String(process.pid)];
        options = { shell: false };
      }
      child = spawn(command, args, {
        ...options,
        cwd: this.cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      agent.status = 'failed';
      this.log(agent.number, 'error', e.code === 'CLAUDE_NOT_FOUND' ? 'Claude Code was not found. Install it, then try again.' : `Could not start the agent: ${e.message}`);
      this.maybeFinish();
      return;
    }
    this.children.set(agent.number, child);
    agent.status = 'running';
    agent.lastOutput = Date.now();
    agent.deferred = [];
    this.log(agent.number, 'system', 'Launching Claude Code…');

    let pending = '';
    const onLine = (line) => {
      if (!line.trim()) return;
      agent.lastOutput = Date.now();
      try {
        fs.appendFileSync(rawFile, (line.length > MAX_RAW_LINE ? line.slice(0, MAX_RAW_LINE) + ' …[line cut]' : line) + '\n', { mode: 0o600 });
      } catch {
        /* ignore */
      }
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        this.log(agent.number, 'say', clip(line, 300), line);
        return;
      }
      if (obj.type === 'assistant' && obj.message?.content?.some?.((b) => b.type === 'tool_use')) {
        agent.turns += 1;
        if (agent.turns > maxTurns) this.capAgent(agent, `Action limit reached (${maxTurns} actions for agent ${agent.number}).`);
      }
      for (const e of summarizeEvent(obj)) {
        if (e.defer) { agent.deferred.push(e); continue; }
        if (e.authProblem) agent.authProblem = true;
        if (e.kind === 'record') {
          run.counts[e.record] = (run.counts[e.record] || 0) + 1;
          this.emit('records', e.record);
          if (run.mode === 'practice' && e.record === 'submitted') {
            this.log(agent.number, 'error', 'A Practice run recorded a SUBMITTED application. That should not happen. Check your LinkedIn and job-board "applied" lists, and press Stop.');
          }
        }
        this.log(agent.number, e.kind, e.text, line);
      }
      this.emit('run', this.snapshot());
    };
    child.stdout.on('data', (d) => {
      pending += d.toString('utf8');
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, i).replace(/\r$/, ''));
        pending = pending.slice(i + 1);
      }
      // A line with no end in sight is not a stream-json line. Cut it so memory stays flat.
      if (pending.length > MAX_RAW_LINE) pending = pending.slice(-MAX_RAW_LINE);
    });
    child.stdout.on('end', () => {
      if (pending.trim()) onLine(pending);
      pending = '';
    });
    child.stderr.on('data', (d) => {
      agent.lastOutput = Date.now();
      const text = d.toString('utf8').trim();
      if (!text) return;
      const auth = authMessage(text);
      if (auth) agent.authProblem = true;
      this.log(agent.number, 'error', auth || clip(text, 400));
    });
    child.on('error', (e) => {
      agent.status = 'failed';
      this.log(agent.number, 'error', `The agent process failed: ${e.message}`);
      this.maybeFinish();
    });
    child.on('close', (code) => {
      this.children.delete(agent.number);
      if (agent.status === 'running') agent.status = run.stopping ? 'stopped' : code === 0 ? 'done' : 'failed';
      // The browser-tools warning is only a useful hint when sign-in is not the real problem.
      if (!agent.authProblem) for (const e of agent.deferred) this.log(agent.number, e.kind, e.text);
      const stopped = run.stopping || agent.status === 'stopped';
      this.log(agent.number, 'system', stopped ? 'Agent stopped.' : code === 0 ? 'Agent finished.' : `Agent exited with code ${code}. See ${path.join('runs', run.id, 'run.log')} in your data folder.`);
      this.maybeFinish();
    });
    try {
      child.stdin.on('error', () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      /* the process may have died instantly; the close handler reports it */
    }
  }

  /** One agent hit its action limit: stop that agent only. The others carry on. */
  capAgent(agent, reason) {
    const run = this.run;
    if (!run || agent.status !== 'running') return;
    agent.status = 'stopped';
    run.reason = run.reason || reason;
    this.log(agent.number, 'warn', `${reason} Stopping this agent.`);
    const child = this.children.get(agent.number);
    if (child) killTree(child);
  }

  maybeFinish() {
    const run = this.run;
    if (!run || run.status !== 'running') return;
    if (run.agents.some((a) => a.status === 'running' || a.status === 'starting')) return;
    run.status = run.stopping || run.agents.some((a) => a.status === 'stopped')
      ? 'stopped'
      : run.agents.every((a) => a.status === 'failed') ? 'failed' : 'finished';
    run.endedAt = new Date().toISOString();
    this.ownedLock?.release();
    this.ownedLock = null;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    const c = run.counts;
    this.log(null, 'system', `Run ${run.status}. Submitted ${c.submitted}, ready to review ${c.ready}, held ${c.held}, skipped ${c.skipped}.`);
    if (run.status === 'stopped' && run.mode === 'live') this.markUnfinished(run);
    this.emit('run', this.snapshot());
    this.emit('records', 'done');
  }

  /**
   * A Live run that was cut off may have clicked Submit on a posting it never got to record. Every posting an agent
   * claimed but did not record becomes a "held" row, so the next run does not apply to it blindly and you can check.
   */
  markUnfinished(run) {
    try {
      const recorded = new Set(listApplications(this.store).map((a) => appKey(a)));
      const mine = this.store.readJsonl(FILES.claims).filter((c) => c.run === run.id && c.url);
      let n = 0;
      for (const c of mine) {
        if (recorded.has(appKey({ url: c.url, company: c.companyRaw }))) continue;
        recordApplication(this.store, {
          status: 'held', company: c.companyRaw || 'Unknown company', role: c.roleRaw || '', url: c.url,
          note: 'The run was stopped while this one was in progress. Check whether it was submitted before applying again.',
        }, { agent: c.agent, run: run.id });
        n += 1;
      }
      this.log(null, 'warn', `The Live run was stopped early. An application that was being sent may have gone through without being recorded${n ? `; ${n} unfinished posting${n > 1 ? 's were' : ' was'} marked as held` : ''}. Check your "Applied" lists on LinkedIn and the job boards.`);
    } catch {
      /* the warning above is what matters */
    }
  }

  /** Stop the run: kill every agent process tree this runner started, and nothing else. */
  stop(reason = 'Stopped by you.') {
    const run = this.run;
    if (!run || run.status !== 'running' || run.stopping) return this.snapshot();
    run.stopping = true;
    run.reason = reason;
    this.log(null, 'system', `${reason} Stopping agents…`);
    for (const child of this.children.values()) killTree(child);
    // If nothing was ever spawned (instant failure), finish immediately.
    if (!this.children.size) this.maybeFinish();
    // Safety net: if close events never arrive, mark done after a few seconds.
    const t = setTimeout(() => {
      if (this.run === run && run.status === 'running') {
        for (const a of run.agents) if (a.status === 'running' || a.status === 'starting') a.status = 'stopped';
        this.maybeFinish();
      }
    }, 8000);
    t.unref?.();
    return this.snapshot();
  }

  /** The app is going away right now: kill every agent, waiting for each kill to land. */
  killAllSync() {
    for (const child of this.children.values()) killTreeSync(child);
    this.ownedLock?.release();
    this.ownedLock = null;
  }
}

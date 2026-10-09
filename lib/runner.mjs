// Runs the agents. Each agent is one `claude -p` process driving the person's own Chrome.
//
// Safety posture:
//   * never uses --dangerously-skip-permissions
//   * Bash is limited to the logging helper (Bash(node tools/log.mjs:*))
//   * the prompt goes in on stdin, so it never appears in a process list
//   * every run has a time cap and a turn cap, and can be stopped (the whole process tree is killed)
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { ROOT, FILES, newId } from './store.mjs';
import { claudeSpawnSpec, killTree, cleanEnv, ISOLATION_ARGS } from './claude.mjs';
import { buildPrompt, planAgents } from './prompts.mjs';
import { listRetryable } from './store.mjs';

export const ALLOWED_TOOLS = [
  'mcp__claude-in-chrome__*',
  'Read',
  'WebFetch',
  'WebSearch',
  'Bash(node tools/log.mjs:*)',
];

export function buildClaudeArgs({ chrome = true, allowedTools = ALLOWED_TOOLS } = {}) {
  const args = ['-p'];
  if (chrome) args.push('--chrome');
  args.push('--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--disable-slash-commands');
  args.push(...ISOLATION_ARGS);
  // Only the built-in tools the agents need exist at all. No Edit, Write or PowerShell.
  args.push('--tools', 'Read', 'WebFetch', 'WebSearch', 'Bash');
  // Last on purpose: --allowedTools takes a list.
  args.push('--allowedTools', ...allowedTools);
  return args;
}

// --- turning stream-json into readable lines ----------------------------------------------------

const clip = (s, n = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

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
          out.push({ kind: 'error', text: 'The browser tools are not available to this agent. Check "Claude in Chrome extension" in Settings and run Test connection.' });
        }
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
        out.push({ kind: 'error', text: clip(obj.result || `Agent stopped: ${obj.subtype}`, 500) });
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

export class Runner extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.store    lib/store.mjs store
   * @param {object} [o.spec]   override how the CLI is started (tests use a fake CLI)
   * @param {boolean} [o.chrome] pass --chrome (default true)
   * @param {string} [o.cwd]    working directory for agents (default: repo root, so tools/log.mjs resolves)
   */
  constructor({ store, spec = null, chrome = true, cwd = ROOT, env = process.env } = {}) {
    super();
    this.store = store;
    this.spec = spec;
    this.chrome = chrome;
    this.cwd = cwd;
    this.env = env;
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
      if (this.run?.logFile) fs.appendFileSync(this.run.logFile, `${entry.ts} [${agent ? 'agent ' + agent : 'run'}] ${kind}: ${text}\n`);
    } catch {
      /* logging must never break a run */
    }
    this.emit('log', entry);
    return entry;
  }

  /**
   * Start a run. Returns the snapshot. Throws if one is already running.
   * opts: { profile, mode, agents, limit, task: 'search'|'held', maxMinutes, maxTurns, promptOverride }
   */
  start(opts) {
    if (this.active) throw new Error('A run is already in progress.');
    const { profile } = opts;
    const mode = opts.mode === 'live' ? 'live' : 'practice';
    const task = opts.task === 'held' ? 'held' : 'search';
    const held = task === 'held' ? listRetryable(this.store) : [];
    if (task === 'held' && !held.length) throw new Error('There is nothing on hold.');
    const maxMinutes = Number(opts.maxMinutes ?? profile.settings?.maxMinutes ?? 45);
    const maxTurns = Number(opts.maxTurns ?? profile.settings?.maxTurns ?? 200);
    const plans = planAgents(profile, { agents: opts.agents ?? profile.settings?.agents ?? 1, limit: opts.limit, task, held });

    this.store.ensure();
    const id = newId('r_');
    const dir = this.store.resolve(FILES.runs, id);
    fs.mkdirSync(dir, { recursive: true });
    this.run = {
      id, mode, task, status: 'running', startedAt: new Date().toISOString(), endedAt: null, reason: '',
      dir, logFile: path.join(dir, 'run.log'), stopping: false,
      counts: { submitted: 0, ready: 0, held: 0, skipped: 0 },
      agents: plans.map((p) => ({ number: p.number, status: 'starting', turns: 0, limit: p.limit, sources: p.sources, plan: p })),
    };
    this.children.clear();
    this.log(null, 'system', `Run started in ${mode === 'live' ? 'Live' : 'Practice'} mode with ${plans.length} agent${plans.length > 1 ? 's' : ''}.`);

    for (const agent of this.run.agents) this.spawnAgent(agent, { profile, mode, maxTurns, promptOverride: opts.promptOverride });

    const t = setTimeout(() => this.stop(`Time limit reached (${maxMinutes} minutes).`), Math.max(1, maxMinutes) * 60_000);
    t.unref?.();
    this.timers.push(t);
    this.emit('run', this.snapshot());
    return this.snapshot();
  }

  spawnAgent(agent, { profile, mode, maxTurns, promptOverride }) {
    const run = this.run;
    const prompt = promptOverride ?? buildPrompt({ profile, mode, plan: agent.plan });
    const rawFile = path.join(run.dir, `agent-${agent.number}.jsonl`);
    let child;
    try {
      const s = claudeSpawnSpec(buildClaudeArgs({ chrome: this.chrome }), this.spec, this.env);
      const env = {
        ...cleanEnv(this.env),
        CJA_DATA_DIR: this.store.dataDir,
        CJA_AGENT: `agent-${agent.number}`,
        CJA_RUN: run.id,
      };
      child = spawn(s.command, s.args, {
        ...s.options,
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
    this.log(agent.number, 'system', 'Launching Claude Code…');

    let pending = '';
    const onLine = (line) => {
      if (!line.trim()) return;
      try {
        fs.appendFileSync(rawFile, line + '\n');
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
        if (agent.turns > maxTurns) this.stop(`Turn limit reached (${maxTurns} actions for one agent).`);
      }
      for (const e of summarizeEvent(obj)) {
        if (e.kind === 'record') {
          run.counts[e.record] = (run.counts[e.record] || 0) + 1;
          this.emit('records', e.record);
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
    });
    child.stdout.on('end', () => {
      if (pending.trim()) onLine(pending);
      pending = '';
    });
    child.stderr.on('data', (d) => {
      const text = d.toString('utf8').trim();
      if (text) this.log(agent.number, 'error', clip(text, 400));
    });
    child.on('error', (e) => {
      agent.status = 'failed';
      this.log(agent.number, 'error', `The agent process failed: ${e.message}`);
      this.maybeFinish();
    });
    child.on('close', (code) => {
      this.children.delete(agent.number);
      if (agent.status === 'running') agent.status = run.stopping ? 'stopped' : code === 0 ? 'done' : 'failed';
      this.log(agent.number, 'system', run.stopping ? 'Agent stopped.' : code === 0 ? 'Agent finished.' : `Agent exited with code ${code}.`);
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

  maybeFinish() {
    const run = this.run;
    if (!run || run.status !== 'running') return;
    if (run.agents.some((a) => a.status === 'running' || a.status === 'starting')) return;
    run.status = run.stopping ? 'stopped' : run.agents.every((a) => a.status === 'failed') ? 'failed' : 'finished';
    run.endedAt = new Date().toISOString();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const c = run.counts;
    this.log(null, 'system', `Run ${run.status}. Submitted ${c.submitted}, ready to review ${c.ready}, held ${c.held}, skipped ${c.skipped}.`);
    this.emit('run', this.snapshot());
    this.emit('records', 'done');
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
}

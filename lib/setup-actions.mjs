// One-click setup actions: install Claude Code, and sign in to Claude.
//
// The install commands are the official ones, copied from https://code.claude.com/docs/en/quickstart
// ("Native Install"). They are constants. No user input is ever added to them, and the app shows
// the exact command and its source in a confirmation dialog before anything runs.
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { claudeSpawnSpec, killTree, cleanEnv } from './claude.mjs';
import { newId } from './store.mjs';

export const INSTALL_SOURCE_URL = 'https://code.claude.com/docs/en/quickstart';

const INSTALL = {
  win32: {
    shell: 'Windows PowerShell',
    display: 'irm https://claude.ai/install.ps1 | iex',
    file: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'],
  },
  unix: {
    shell: 'bash',
    display: 'curl -fsSL https://claude.ai/install.sh | bash',
    file: 'bash',
    args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
  },
};

/** What the install button would run on this platform: { shell, display, source, file, args }. */
export function installCommand(platform = process.platform) {
  const c = platform === 'win32' ? INSTALL.win32 : INSTALL.unix;
  return { ...c, source: INSTALL_SOURCE_URL };
}

export const LOGIN_ARGS = ['auth', 'login', '--claudeai'];
export const LOGIN_DISPLAY = 'claude auth login --claudeai';

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Clean one chunk of process output into readable lines. Drops PowerShell's progress XML noise. */
export function cleanLines(text) {
  return String(text || '')
    .replace(ANSI, '')
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^#< CLIXML/.test(l) && !/^<Objs\b/.test(l) && !/^<\/Objs>/.test(l));
}

export class SetupJobs extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {function} [o.spawn]       child_process.spawn replacement (tests)
   * @param {object}   [o.installSpec] { file, args } replacement for the install command (tests)
   * @param {object}   [o.claudeSpec]  { command, args } replacement for the claude CLI (tests)
   * @param {number}   [o.timeoutMs]
   */
  constructor({ spawn = nodeSpawn, installSpec = null, claudeSpec = null, platform = process.platform, env = process.env, timeoutMs = 10 * 60_000 } = {}) {
    super();
    this.spawn = spawn;
    this.installSpec = installSpec;
    this.claudeSpec = claudeSpec;
    this.platform = platform;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.job = null;
    this.child = null;
  }

  get active() {
    return !!this.job && this.job.status === 'running';
  }

  snapshot() {
    if (!this.job) return { status: 'idle' };
    const { id, kind, status, startedAt, endedAt, exitCode, lines, command } = this.job;
    return { id, kind, status, startedAt, endedAt, exitCode, command, lines: lines.slice(-200) };
  }

  push(line) {
    this.job.lines.push(line);
    if (this.job.lines.length > 400) this.job.lines.splice(0, this.job.lines.length - 400);
    this.emit('event', { id: this.job.id, kind: this.job.kind, status: 'running', line });
  }

  /** Start 'install' or 'login'. Returns the snapshot. Throws if a job is already running. */
  start(kind) {
    if (this.active) throw Object.assign(new Error('Another setup step is still running.'), { code: 'BUSY' });
    let file;
    let args;
    let options = {};
    let display;
    if (kind === 'install') {
      const c = this.installSpec || installCommand(this.platform);
      file = c.file; args = c.args; display = this.installSpec ? this.installSpec.display || 'install' : c.display;
    } else if (kind === 'login') {
      const s = claudeSpawnSpec(LOGIN_ARGS, this.claudeSpec, this.env);
      file = s.command; args = s.args; options = s.options; display = LOGIN_DISPLAY;
    } else {
      throw new Error('Unknown setup step.');
    }
    this.job = { id: newId('s_'), kind, status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, lines: [], command: display, cancelled: false };
    const job = this.job;
    this.emit('event', { id: job.id, kind, status: 'running', start: true, command: display });
    this.push(kind === 'install' ? `Running: ${display}` : 'Opening your browser so you can sign in to Claude. Finish there, then come back to this page.');
    let child;
    try {
      child = this.spawn(file, args, { ...options, env: cleanEnv(this.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.end(job, 'failed', null, `Could not start: ${e.message}`);
      return this.snapshot();
    }
    this.child = child;
    // Keep stdin open for the sign-in flow (it can wait for a pasted code), but never write anything to it.
    child.stdin?.on?.('error', () => {});
    if (kind === 'install') child.stdin?.end?.();
    const onData = (d) => { if (this.job === job) for (const l of cleanLines(d.toString('utf8'))) this.push(l); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => this.end(job, 'failed', null, e.code === 'ENOENT' ? 'The program could not be found.' : `Failed: ${e.message}`));
    child.on('close', (code) => {
      if (job.cancelled) this.end(job, 'cancelled', code, 'Cancelled.');
      else this.end(job, code === 0 ? 'done' : 'failed', code, code === 0 ? 'Finished.' : `It stopped with exit code ${code}.`);
    });
    const timer = setTimeout(() => { job.cancelled = true; this.push('Taking too long. Stopping.'); killTree(child); }, this.timeoutMs);
    timer.unref?.();
    job.timer = timer;
    return this.snapshot();
  }

  end(job, status, exitCode, message) {
    if (job.status !== 'running') return;
    clearTimeout(job.timer);
    job.status = status;
    job.exitCode = exitCode;
    job.endedAt = new Date().toISOString();
    if (message) job.lines.push(message);
    this.child = null;
    this.emit('event', { id: job.id, kind: job.kind, status, line: message, exitCode, done: true });
  }

  cancel() {
    if (!this.active) return this.snapshot();
    this.job.cancelled = true;
    if (this.child) killTree(this.child);
    return this.snapshot();
  }
}

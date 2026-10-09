// Finding and launching the Claude Code CLI on Windows, macOS and Linux.
//
// The prompt is always sent on stdin, never on the command line. That sidesteps shell quoting
// and Windows' command-length limit, and it keeps personal details out of the process list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { ROOT } from './store.mjs';

const isWin = process.platform === 'win32';

/**
 * Keep agents away from every other connector the person has set up (mail, drive, chat...).
 * With an empty strict MCP config only the built-in Claude in Chrome tools remain. Verified with Claude Code 2.1.x.
 */
export const ISOLATION_ARGS = ['--strict-mcp-config', '--mcp-config', path.join(ROOT, 'agents', 'empty-mcp.json')];

/**
 * Environment for child Claude processes. An API key in the environment would silently switch
 * Claude Code away from the claude.ai login, and the Chrome integration does not work with API keys.
 */
export function cleanEnv(env = process.env) {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Locate the `claude` executable. Returns { path, kind } or null. */
export function findClaude(env = process.env) {
  if (env.CJA_CLAUDE && isFile(env.CJA_CLAUDE)) return describe(env.CJA_CLAUDE);
  const names = isWin ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'));
  if (isWin && env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  if (!isWin) dirs.push('/usr/local/bin', '/opt/homebrew/bin');
  // Prefer a real executable over an npm shim when both exist.
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return describe(candidate);
    }
  }
  return null;
}

function describe(p) {
  const shim = isWin && /\.(cmd|bat)$/i.test(p);
  return { path: p, kind: shim ? 'shim' : 'exe' };
}

function quoteForCmd(arg) {
  const s = String(arg);
  return /[\s()&|<>^"%!*;,=]/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * Build spawn arguments for the CLI. Returns { command, args, options } ready for child_process.spawn.
 * `spec` can be passed to override discovery (tests use this with a fake CLI).
 */
export function claudeSpawnSpec(args, spec = null, env = process.env) {
  if (spec) return { command: spec.command, args: [...(spec.args || []), ...args], options: { shell: false } };
  const found = findClaude(env);
  if (!found) {
    const err = new Error('Claude Code was not found on this computer.');
    err.code = 'CLAUDE_NOT_FOUND';
    throw err;
  }
  if (found.kind === 'shim') {
    // .cmd shims need a shell on Windows. Every argument is quoted and none carries user data.
    return {
      command: quoteForCmd(found.path),
      args: args.map(quoteForCmd),
      options: { shell: true },
    };
  }
  return { command: found.path, args, options: { shell: false } };
}

/** Run the CLI to completion and capture output (used for version, auth status, connection test). */
export function runClaude(args, { timeoutMs = 20_000, input, spec = null, env: rawEnv = process.env, cwd } = {}) {
  const env = cleanEnv(rawEnv);
  return new Promise((resolve) => {
    let child;
    try {
      const s = claudeSpawnSpec(args, spec, env);
      child = spawn(s.command, s.args, {
        ...s.options,
        cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: e.message, notFound: e.code === 'CLAUDE_NOT_FOUND', timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) =>
      finish({ ok: false, code: null, stdout, stderr: e.message, notFound: e.code === 'ENOENT', timedOut }),
    );
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut, code, stdout, stderr, notFound: false, timedOut }));
    try {
      if (input) child.stdin.write(input);
      child.stdin.end();
    } catch {
      /* the process may already have exited */
    }
  });
}

/** Kill a child and everything it started. Only ever called with a PID this app spawned. */
export function killTree(child) {
  if (!child || child.pid == null || child.exitCode !== null) return;
  const pid = child.pid;
  if (isWin) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 3000).unref();
  }
}

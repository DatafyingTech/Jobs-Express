// Finding and launching the Claude Code CLI on Windows, macOS and Linux.
//
// The prompt is always sent on stdin, never on the command line. That sidesteps shell quoting
// and Windows' command-length limit, and it keeps personal details out of the process list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, spawnSync } from 'node:child_process';
import { ROOT } from './store.mjs';

const isWin = process.platform === 'win32';

/**
 * Keep agents away from every other connector the person has set up (mail, drive, chat...).
 * With an empty strict MCP config only the built-in Claude in Chrome tools remain. Verified with Claude Code 2.1.x.
 */
// The path is relative to the folder every agent and check runs in (the app folder), so the app's own location never
// appears on a command line. That matters on Windows, where a "%" in a path would be expanded by cmd.exe.
export const ISOLATION_ARGS = ['--strict-mcp-config', '--mcp-config', 'agents/empty-mcp.json'];

// Names (case-insensitive) a child process may inherit. Everything else is left out, so a token, password or key that
// happens to be in your shell never reaches an agent. An API key would also silently switch Claude Code away from the
// claude.ai login, and the Chrome integration does not work with API keys.
const ENV_ALLOW = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'COMPUTERNAME',
  'USERNAME', 'USERDOMAIN', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'LANG', 'LANGUAGE', 'TZ', 'TEMP', 'TMP', 'TMPDIR',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  'ANTHROPIC_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH',
]);
// Prefixes: locale and desktop variables, this app's own, and the provider switches Claude Code reads. Nothing else that
// starts with CLAUDE_ gets through: session tokens and hook secrets from a parent Claude session stay out.
const ENV_ALLOW_PREFIX = [/^LC_/i, /^XDG_/i, /^CJA_/i, /^CLAUDE_CODE_USE_[A-Z0-9_]+$/i];
const ENV_NEVER = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)$/i;

/** The environment a child Claude process is given: an allow-list, never the whole shell. */
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || ENV_NEVER.test(k)) continue;
    if (ENV_ALLOW.has(k.toUpperCase()) || ENV_ALLOW_PREFIX.some((re) => re.test(k))) out[k] = v;
  }
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

/**
 * Quote one argument for cmd.exe. A "%" is refused: cmd expands %NAME% even inside quotes and there is no reliable way
 * to escape it on a /c command line, so a path with one would reach the program changed.
 */
export function quoteForCmd(arg) {
  const s = String(arg);
  if (s.includes('%')) {
    const err = new Error('Claude Code is installed in a folder whose name contains a percent sign, which Windows cannot pass along safely. Move it, or install it again (the installer button puts it in your user folder).');
    err.code = 'UNSAFE_PATH';
    throw err;
  }
  return /[\s()&|<>^"!*;,=]/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s;
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
    // .cmd shims need cmd.exe. It is started explicitly (what shell:true does, without Node's deprecation warning),
    // with every argument quoted. None carries user data.
    const line = [found.path, ...args].map(quoteForCmd).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { shell: false, windowsVerbatimArguments: true },
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

/** Same as killTree but waits for it: used when the app itself is going away and cannot wait for a callback. */
export function killTreeSync(child) {
  if (!child || child.pid == null || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
    else {
      try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch {
    /* already gone */
  }
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

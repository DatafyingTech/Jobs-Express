// Preflight: the six things that must be true before agents can do anything useful.
// Parsers are pure functions so they can be tested without Claude or Chrome installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { runClaude, findClaude, ISOLATION_ARGS } from './claude.mjs';
import { FILES, ROOT } from './store.mjs';

export const MIN_NODE_MAJOR = 18;
export const EXTENSION_URL = 'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn';
export const CLAUDE_INSTALL_URL = 'https://code.claude.com/docs/en/quickstart';
export const LINKEDIN_URL = 'https://www.linkedin.com/feed/';

// --- parsers ---------------------------------------------------------------------------------

export function parseNodeVersion(str) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(str || ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: m[0].replace(/^v/, '') };
}

export function parseClaudeVersion(output) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(output || ''));
  return m ? m[1] : null;
}

/** Compare dotted versions: returns -1, 0, 1. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Interpret the output of `claude auth status`. Never returns the account email.
 * state: 'ok' | 'api-key' | 'third-party' | 'logged-out' | 'unknown'
 */
export function parseAuthStatus(text) {
  const raw = String(text || '').trim();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(raw.slice(start, end + 1));
      } catch {
        data = null;
      }
    }
  }
  if (!data || typeof data !== 'object') {
    if (/not\s+logged\s+in|logged\s+out|no\s+active\s+session/i.test(raw)) return { state: 'logged-out', method: '', plan: '' };
    return { state: 'unknown', method: '', plan: '' };
  }
  const method = String(data.authMethod ?? data.auth_method ?? data.method ?? '');
  const plan = String(data.subscriptionType ?? data.subscription ?? data.plan ?? '');
  const provider = String(data.apiProvider ?? data.provider ?? 'firstParty');
  const loggedIn = data.loggedIn ?? data.logged_in ?? data.isLoggedIn;
  if (loggedIn === false) return { state: 'logged-out', method, plan };
  if (/bedrock|vertex|foundry/i.test(provider) || /bedrock|vertex|foundry/i.test(method)) return { state: 'third-party', method, plan };
  if (/api[_\s-]?key|console|token|apikey|helper/i.test(method)) return { state: 'api-key', method, plan };
  if (/claude\.?ai|oauth|subscription|max|pro|team|enterprise/i.test(method) || (loggedIn === true && /pro|max|team|enterprise/i.test(plan))) {
    return { state: 'ok', method, plan };
  }
  if (loggedIn === true) return { state: method ? 'unknown' : 'ok', method, plan };
  return { state: 'unknown', method, plan };
}

/** Look at what `claude -p ... --chrome` printed and decide whether the extension answered. */
export function parseConnectionTest(result) {
  const text = [result?.stdout, result?.stderr].filter(Boolean).join('\n');
  if (result?.notFound) return { ok: false, reason: 'claude-missing' };
  if (result?.timedOut) return { ok: false, reason: 'timeout' };
  let reply = text;
  try {
    const j = JSON.parse(String(result.stdout || '').trim());
    reply = String(j.result ?? '') + '\n' + (j.is_error ? 'ERROR' : '');
  } catch {
    /* plain text output is fine */
  }
  if (/\bCONNECTED\b/.test(reply) && !/NOT[_\s-]*CONNECTED/i.test(reply)) return { ok: true, reason: 'ok' };
  if (/^\s*FAILED\s*[.!]?\s*(\n\s*(ERROR)?\s*)?$/i.test(reply)) return { ok: false, reason: 'not-connected' };
  if (/not connected|not available|extension.*(not|isn't)|no browser|receiving end does not exist|403/i.test(text)) {
    return { ok: false, reason: 'not-connected' };
  }
  return { ok: false, reason: 'no-answer' };
}

// --- browsers --------------------------------------------------------------------------------

export function browserCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const pf = env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      { name: 'Google Chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', path: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Microsoft Edge', path: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Microsoft Edge', path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Brave', path: path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    ];
  }
  if (platform === 'darwin') {
    return [
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      { name: 'Google Chrome', path: path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') },
    ];
  }
  const dirs = ['/usr/bin', '/usr/local/bin', '/opt/google/chrome', '/snap/bin', '/opt/microsoft/msedge', '/opt/brave.com/brave'];
  const names = [
    ['Google Chrome', 'google-chrome'],
    ['Google Chrome', 'google-chrome-stable'],
    ['Chromium', 'chromium'],
    ['Chromium', 'chromium-browser'],
    ['Microsoft Edge', 'microsoft-edge'],
    ['Microsoft Edge', 'microsoft-edge-stable'],
    ['Brave', 'brave-browser'],
  ];
  return names.flatMap(([name, bin]) => dirs.map((d) => ({ name, path: path.join(d, bin) })));
}

export function detectBrowsers({ platform, env, home, exists = (p) => fs.existsSync(p) } = {}) {
  const seen = new Set();
  const found = [];
  for (const c of browserCandidates(platform, env, home)) {
    if (exists(c.path) && !seen.has(c.path)) {
      seen.add(c.path);
      found.push(c);
    }
  }
  return found;
}

// --- individual checks -----------------------------------------------------------------------

const row = (id, title, status, summary, hint = '', extra = {}) => ({ id, title, status, summary, hint, ...extra });

export function checkNode(version = process.version) {
  const v = parseNodeVersion(version);
  if (!v) return row('node', 'Node.js', 'fail', 'Could not read the Node.js version.', 'Install Node.js 18 or newer from nodejs.org.');
  if (v.major < MIN_NODE_MAJOR) {
    return row('node', 'Node.js', 'fail', `Node.js ${v.raw} is too old.`, `Install Node.js ${MIN_NODE_MAJOR} or newer (the LTS release is a safe choice) from nodejs.org, then start the app again.`);
  }
  return row('node', 'Node.js', 'ok', `Node.js ${v.raw}`, '');
}

export async function checkClaudeInstalled(opts = {}) {
  const found = opts.spec ? { path: 'custom' } : findClaude(opts.env);
  if (!found) {
    return row('claude', 'Claude Code', 'fail', 'Claude Code was not found.',
      `Install Claude Code, then click Re-check. The official install steps are at ${CLAUDE_INSTALL_URL} (on most computers it is one command in a terminal, then "claude" once to sign in).`,
      { url: CLAUDE_INSTALL_URL });
  }
  const r = await runClaude(['--version'], { timeoutMs: 15_000, spec: opts.spec, env: opts.env });
  const version = parseClaudeVersion(r.stdout);
  if (!r.ok || !version) {
    return row('claude', 'Claude Code', 'fail', 'Claude Code is installed but did not start.',
      'Open a terminal and run "claude --version" to see the error. Reinstalling Claude Code usually fixes it.', { url: CLAUDE_INSTALL_URL });
  }
  return row('claude', 'Claude Code', 'ok', `Claude Code ${version}`, '', { version });
}

export async function checkSignedIn(opts = {}) {
  const r = await runClaude(['auth', 'status'], { timeoutMs: 20_000, spec: opts.spec, env: opts.env });
  if (r.notFound) return row('auth', 'Signed in with a Claude plan', 'fail', 'Claude Code is not installed yet.', 'Finish the step above first.');
  const parsed = parseAuthStatus(r.stdout || r.stderr);
  switch (parsed.state) {
    case 'ok':
      return row('auth', 'Signed in with a Claude plan', 'ok', parsed.plan ? `Signed in with your claude.ai account (${parsed.plan} plan)` : 'Signed in with your claude.ai account', '');
    case 'api-key':
      return row('auth', 'Signed in with a Claude plan', 'fail', 'Claude Code is using an API key, not a claude.ai login.',
        'The Chrome integration only works with a claude.ai Pro, Max, Team or Enterprise login. In a terminal run "claude auth login" and choose the claude.ai option, then click Re-check. If ANTHROPIC_API_KEY is set in your environment, remove it first.');
    case 'third-party':
      return row('auth', 'Signed in with a Claude plan', 'fail', 'Claude Code is going through a cloud provider (Bedrock, Vertex or Foundry).',
        'The Chrome integration needs a direct claude.ai login. Run "claude auth login" with a claude.ai Pro or Max account.');
    case 'logged-out':
      return row('auth', 'Signed in with a Claude plan', 'fail', 'Claude Code is not signed in.', 'In a terminal run "claude auth login", pick the claude.ai option, finish in the browser, then click Re-check.');
    default:
      return row('auth', 'Signed in with a Claude plan', 'warn', 'Could not tell whether Claude Code is signed in.',
        'Run "claude auth status" in a terminal. You want to see loggedIn true with a claude.ai login. If it looks right, carry on.');
  }
}

export function checkBrowser(opts = {}) {
  const found = detectBrowsers(opts);
  if (!found.length) {
    return row('browser', 'Chrome or Edge', 'fail', 'No Chrome or Edge was found.', 'Install Google Chrome (google.com/chrome) or Microsoft Edge, then click Re-check.', { url: 'https://www.google.com/chrome/' });
  }
  return row('browser', 'Chrome or Edge', 'ok', found[0].name, '', { browsers: found.map((f) => f.name), browserPath: found[0].path });
}

/**
 * On Windows, Claude Code uses Git Bash for its Bash tool. Without Git for Windows it may offer PowerShell instead, and the
 * agents' only shell command (recording results with tools/log.mjs) would not be allowed. Not seen on a machine without Git
 * for Windows, so this is a warning, not a stop.
 */
export function checkShell({ platform = process.platform, env = process.env, exists = (p) => fs.existsSync(p), which = whichGit } = {}) {
  if (platform !== 'win32') return null;
  const local = env.LOCALAPPDATA || '';
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Git', 'bin', 'bash.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Git', 'bin', 'bash.exe'),
    local && path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
    which(env),
  ].filter(Boolean);
  const found = candidates.find((p) => exists(p));
  if (found) return row('shell', 'Git for Windows (Bash)', 'ok', 'Git Bash found', '', { path: found });
  return row('shell', 'Git for Windows (Bash)', 'warn', 'Git for Windows was not found.',
    'Claude Code uses Git Bash for the one shell command the agents need (recording results). Install Git for Windows from git-scm.com/downloads/win, then click Re-check. If runs fail to record anything, this is the first thing to fix.',
    { url: 'https://git-scm.com/downloads/win' });
}

/** Look for git.exe on PATH and return the bash.exe that ships next to it. */
function whichGit(env) {
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    if (fs.existsSync(path.join(dir, 'git.exe'))) return path.join(dir, '..', 'bin', 'bash.exe');
  }
  return null;
}

export function extensionRow(lastTest) {
  if (lastTest?.ok) {
    return row('extension', 'Claude in Chrome extension', 'ok', 'Connected', '', { testedAt: lastTest.at });
  }
  if (lastTest && lastTest.ok === false) {
    return row('extension', 'Claude in Chrome extension', 'fail', connectionMessage(lastTest.reason), connectionHint(lastTest.reason), { testedAt: lastTest.at, url: EXTENSION_URL });
  }
  return row('extension', 'Claude in Chrome extension', 'pending', 'Not tested yet', 'Click "Test connection". Chrome should be open with the Claude extension installed and signed in.', { url: EXTENSION_URL });
}

export function connectionMessage(reason) {
  switch (reason) {
    case 'timeout': return 'The test took too long and was stopped.';
    case 'not-connected': return 'Claude Code could not reach the extension.';
    case 'claude-missing': return 'Claude Code is not installed yet.';
    default: return 'Claude answered, but not with the expected reply.';
  }
}

export function connectionHint(reason) {
  const base = 'Try these in order: (1) install the "Claude" extension from the Chrome Web Store, version 1.0.36 or newer; (2) open the extension and sign in with the same claude.ai account Claude Code uses; (3) close every Chrome window and open Chrome again once (Chrome reads its connection settings only at startup); (4) click Test connection.';
  if (reason === 'claude-missing') return 'Install Claude Code first.';
  if (reason === 'timeout') return 'Make sure Chrome is open and not showing a pop-up dialog. ' + base;
  return base;
}

const CONNECTION_PROMPT =
  'Connection test. Call the browser tabs context tool (tabs_context_mcp) exactly once, without creating any tab. ' +
  'If it returns without an error, reply with the single word CONNECTED and nothing else. ' +
  'If the tool is unavailable or returns an error, reply with the single word FAILED.';

export const CONNECTION_ARGS = [
  '-p',
  '--chrome',
  '--output-format', 'json',
  '--no-session-persistence',
  '--disable-slash-commands',
  ...ISOLATION_ARGS,
  '--allowedTools', 'mcp__claude-in-chrome__tabs_context_mcp',
];

export async function testChromeConnection(opts = {}) {
  const result = await runClaude(CONNECTION_ARGS, {
    input: CONNECTION_PROMPT,
    timeoutMs: opts.timeoutMs ?? 120_000,
    spec: opts.spec,
    env: opts.env,
    cwd: opts.cwd || ROOT,
  });
  const parsed = parseConnectionTest(result);
  return { ...parsed, at: new Date().toISOString() };
}

export function linkedinRow(state) {
  if (state?.linkedinConfirmed) {
    return row('linkedin', 'LinkedIn is signed in', 'ok', 'You confirmed you are signed in', '', { confirmedAt: state.linkedinConfirmedAt });
  }
  return row('linkedin', 'LinkedIn is signed in', 'pending', 'Waiting for your confirmation',
    'Open LinkedIn in the same Chrome profile that has the Claude extension, sign in yourself, then tick the box.', { url: LINKEDIN_URL });
}

// --- everything at once ----------------------------------------------------------------------

export function loadState(store) {
  return store.readJson(FILES.state, {}) || {};
}

export function saveState(store, patch) {
  const next = { ...loadState(store), ...patch };
  store.writeJson(FILES.state, next);
  return next;
}

export async function runPreflight(store, opts = {}) {
  const state = loadState(store);
  const [claude, auth] = await Promise.all([checkClaudeInstalled(opts), checkSignedIn(opts)]);
  const rows = [
    checkNode(),
    claude,
    claude.status === 'ok' ? auth : { ...auth, status: 'pending', summary: 'Waiting for Claude Code', hint: 'Install Claude Code first.' },
    checkBrowser(opts),
    checkShell(opts),
    extensionRow(state.lastConnectionTest),
    linkedinRow(state),
  ].filter(Boolean);
  const blocking = rows.filter((r) => r.status === 'fail').length;
  const ready = rows.every((r) => r.status === 'ok' || r.status === 'warn');
  return { rows, ready, blocking, checkedAt: new Date().toISOString() };
}

export function platformLabel() {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform;
}

/** Open an http(s) URL in the detected Chrome/Edge (so it lands in the profile with the extension). */
export function openInBrowser(url, { allow = [] } = {}) {
  if (!allow.some((prefix) => url.startsWith(prefix))) throw new Error('That address is not one this app opens.');
  const browsers = detectBrowsers();
  try {
    if (browsers.length) {
      const p = browsers[0].path;
      if (process.platform === 'darwin') execFileSync('open', ['-a', p.split('/Contents/')[0], url], { stdio: 'ignore' });
      else spawnDetached(p, [url]);
      return { opened: browsers[0].name };
    }
  } catch {
    /* fall through to the system default */
  }
  if (process.platform === 'win32') spawnDetached('cmd', ['/c', 'start', '', url]);
  else if (process.platform === 'darwin') spawnDetached('open', [url]);
  else spawnDetached('xdg-open', [url]);
  return { opened: 'your default browser' };
}

function spawnDetached(cmd, args) {
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  c.on('error', () => {});
  c.unref();
}

// --- is a browser already running? -------------------------------------------------------------

const BROWSER_PROCESSES = {
  win32: ['chrome.exe', 'msedge.exe', 'brave.exe'],
  darwin: ['Google Chrome', 'Microsoft Edge', 'Brave Browser'],
  linux: ['chrome', 'chromium', 'chromium-browser', 'msedge', 'brave'],
};

/** True when Chrome (or Edge, Brave) has a process. Fixed arguments only: nothing here comes from the user. */
export async function isBrowserRunning({ platform = process.platform, exec } = {}) {
  const run = exec || ((file, args) => new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: stdout || '' }));
  }));
  const names = BROWSER_PROCESSES[platform] || [];
  for (const name of names) {
    if (platform === 'win32') {
      const r = await run('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH']);
      if (r.stdout.toLowerCase().includes(name)) return true;
    } else {
      const r = await run('pgrep', ['-x', name]);
      if (r.code === 0 && r.stdout.trim()) return true;
    }
  }
  return false;
}

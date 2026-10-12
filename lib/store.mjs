// Local file store. Everything the app remembers lives under one data directory
// (default: ./data, override with CJA_DATA_DIR). Nothing here talks to the network,
// and every path is checked so a bad name can never write outside that directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FILES = {
  profile: 'profile.json',
  state: 'state.json',
  applications: 'applications.jsonl',
  held: 'held.jsonl',
  claims: 'claims.jsonl',
  runs: 'runs',
  resume: 'resume',
};

export const STATUSES = ['submitted', 'ready', 'held', 'skipped'];

/**
 * Where your data lives when you have not chosen a place: outside the app folder, in your own user area.
 * (Agents work inside the app folder, so keeping the data out of it keeps them away from your profile and transcripts.)
 */
export function defaultDataDir(env = process.env, { home = os.homedir(), platform = process.platform } = {}) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'JobsExpress');
  return path.join(home, '.jobs-express');
}

export function resolveDataDir(env = process.env, opts) {
  return path.resolve(env.CJA_DATA_DIR || defaultDataDir(env, opts));
}

const hasData = (dir) => ['profile.json', 'applications.jsonl'].some((f) => fs.existsSync(path.join(dir, f)));

/**
 * resolveDataDir plus a one-time move of an older install's ./data folder (version 1.0) into the new place.
 * Returns { dir, migratedFrom?, note? }. If the move fails the old folder keeps being used and `note` says why.
 */
export function prepareDataDir(env = process.env, { root = ROOT, ...opts } = {}) {
  const dir = resolveDataDir(env, opts);
  if (env.CJA_DATA_DIR) return { dir };
  const legacy = path.join(root, 'data');
  if (!fs.existsSync(legacy) || !hasData(legacy) || hasData(dir)) return { dir };
  try {
    createStore(dir).ensure(); // a new folder is created private to the user
    for (const name of fs.readdirSync(legacy)) {
      const from = path.join(legacy, name);
      const to = path.join(dir, name);
      if (fs.existsSync(to) && fs.statSync(to).isDirectory()) fs.cpSync(from, to, { recursive: true });
      else {
        try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
      }
    }
    try { fs.rmSync(legacy, { recursive: true, force: true }); } catch { /* leftovers are harmless */ }
    return { dir, migratedFrom: legacy, note: `Moved your data from ${legacy} to ${dir}, outside the app folder.` };
  } catch (e) {
    return { dir: legacy, note: `Could not move your data out of the app folder (${e.code || e.message}). It stays in ${legacy} for now.` };
  }
}

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/** Thrown when a data file exists but cannot be read right now (locked by antivirus, permissions, a bad disk). */
export class StoreReadError extends Error {
  constructor(file, cause) {
    super(`Could not read ${file} (${cause?.code || cause?.message || 'unknown error'}). It may be open in another program. Try again in a moment.`);
    this.file = file;
    this.code = 'STORE_READ';
    this.status = 503;
  }
}

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/** Run a file operation, retrying briefly when the failure looks like a temporary lock. */
export function withRetry(fn, { tries = 5, base = 40 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      if (!TRANSIENT.has(e.code)) throw e;
      sleepSync(base * (i + 1));
    }
  }
  throw last;
}

const isUnix = process.platform !== 'win32';

export function createStore(dataDir = prepareDataDir().dir) {
  const base = path.resolve(dataDir);
  /** Files that could not be parsed and were set aside: [{ file, savedAs }]. Shown to the person as a warning. */
  const recovered = [];
  /** Other plain-language notes about the data folder: [{ id, text }]. */
  const notes = [];

  /** Resolve a relative path inside the data dir; throw if it would escape. */
  function resolve(...parts) {
    const target = path.resolve(base, ...parts);
    const rel = path.relative(base, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Refusing to touch a path outside the data folder: ${parts.join('/')}`);
    }
    return target;
  }

  function ensure() {
    const fresh = !fs.existsSync(base);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    fs.mkdirSync(resolve(FILES.runs), { recursive: true, mode: 0o700 });
    fs.mkdirSync(resolve(FILES.resume), { recursive: true, mode: 0o700 });
    if (fresh) harden();
    return base;
  }

  /**
   * Make the data folder private to this user. On macOS and Linux that is mode 0700. On Windows the folder
   * inherits permissions from wherever it lives (often readable by every local account), so inheritance is removed
   * and only you, SYSTEM and Administrators are granted access. Best effort: a failure never stops the app.
   */
  function harden() {
    try {
      if (path.parse(base).root === base) return false; // never rewrite the permissions of a whole drive
      if (isUnix) {
        fs.chmodSync(base, 0o700);
      } else if (process.env.USERNAME && !process.env.CJA_SKIP_ACL) {
        execFileSync('icacls', [base, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A folder that already existed was not created by this app, so its permissions are left alone. If it looks readable
   * by other accounts, say so (with the command that fixes it) instead of changing it.
   */
  function checkExposure() {
    try {
      let exposed = false;
      let fix = '';
      if (isUnix) {
        exposed = (fs.statSync(base).mode & 0o077) !== 0;
        fix = `chmod 700 "${base}"`;
      } else {
        const acl = execFileSync('icacls', [base], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        exposed = /\b(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)\b/.test(acl);
        fix = `icacls "${base}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`;
      }
      if (exposed) notes.push({ id: 'exposed', text: `Your data folder (${base}) can be read by other accounts on this computer. To make it private, run: ${fix}` });
      return exposed;
    } catch {
      return false;
    }
  }

  function readJson(rel, fallback = null, { quarantine = false } = {}) {
    const file = resolve(rel);
    let text;
    try {
      text = withRetry(() => fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      throw new StoreReadError(rel, e);
    }
    try {
      return JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      if (quarantine) {
        // Never overwrite a file we could not read: keep a copy first, and tell the person.
        const savedAs = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
          fs.renameSync(file, savedAs);
          recovered.push({ file: rel, savedAs: path.basename(savedAs) });
        } catch { /* leave it where it is */ }
      }
      return fallback;
    }
  }

  function writeJson(rel, obj) {
    const target = resolve(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    withRetry(() => fs.renameSync(tmp, target));
    return target;
  }

  function appendJsonl(rel, obj) {
    const target = resolve(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const line = JSON.stringify(obj) + '\n';
    withRetry(() => {
      const fd = fs.openSync(target, 'a+', 0o600);
      try {
        // A crash can leave the last line without its newline. Start a fresh line so the new record is not glued to it.
        const size = fs.fstatSync(fd).size;
        let prefix = '';
        if (size > 0) {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = '\n';
        }
        fs.writeSync(fd, prefix + line);
      } finally {
        fs.closeSync(fd);
      }
    });
    return obj;
  }

  /** Read a JSON-lines file, silently skipping any line that is not valid JSON. A missing file is empty. */
  function readJsonl(rel) {
    let text;
    try {
      text = withRetry(() => fs.readFileSync(resolve(rel), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw new StoreReadError(rel, e);
    }
    const out = [];
    for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
      } catch {
        /* a half-written line should never break the dashboard */
      }
    }
    return out;
  }

  return { dataDir: base, resolve, ensure, harden, checkExposure, notes, readJson, writeJson, appendJsonl, readJsonl, recovered };
}

// ---------------------------------------------------------------------------
// Applications and held questions
// ---------------------------------------------------------------------------

export const clean = (v, max = 500) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const COMPANY_SUFFIX = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc']);

/** Lower-case, accent-free, punctuation-free company name. Works for any alphabet, and is never empty for a real name. */
export function normalizeCompany(name) {
  const original = clean(name, 200).toLowerCase();
  const words = original
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const kept = words.filter((w) => !COMPANY_SUFFIX.has(w));
  const result = (kept.length ? kept : words).join(' ');
  return result || original;
}

const TRACKING_PARAMS = /^(utm_.*|src|source|ref|refid|referrer|trk|trkinfo|trackingid|tracking|gclid|fbclid|msclkid|lipi|midtoken|midsig|eid|campaign|cmpid|igshid|mc_.*)$/i;

/** One stable key per posting: the host and path plus any query that identifies the job, minus tracking noise. */
export function urlKey(raw) {
  const s = String(raw || '').trim();
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathPart = u.pathname.replace(/\/+$/, '').toLowerCase();
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).map(([k, v]) => `${k.toLowerCase()}=${v}`).sort();
    const hash = /^#[/!]/.test(u.hash) ? u.hash.toLowerCase() : '';
    return `${host}${pathPart}${params.length ? '?' + params.join('&') : ''}${hash}`;
  } catch {
    return s.replace(/^https?:\/\/(www\.)?/i, '').replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

export function appKey(r) {
  if (r.url) return 'u:' + urlKey(r.url);
  return 'c:' + normalizeCompany(r.company) + '|' + clean(r.role, 200).toLowerCase();
}

export function makeApplicationRecord(input, extra = {}) {
  const status = String(input.status || '').toLowerCase();
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const company = clean(input.company, 200);
  if (!company) throw new Error('company is required');
  const url = clean(input.url, 2000);
  if (url && !/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
  return {
    id: newId('a_'),
    ts: new Date().toISOString(),
    status,
    company,
    role: clean(input.role, 200),
    pay: clean(input.pay, 120),
    source: clean(input.source, 60),
    url,
    note: clean(input.note, 1000),
    agent: clean(extra.agent ?? input.agent, 40),
    run: clean(extra.run ?? input.run, 60),
  };
}

export function recordApplication(store, input, extra) {
  const rec = makeApplicationRecord(input, extra);
  store.appendJsonl(FILES.applications, rec);
  return rec;
}

/** Latest entry wins per posting, so a "held" row becomes "submitted" once it is finished. */
export function listApplications(store) {
  const latest = new Map();
  for (const r of store.readJsonl(FILES.applications)) {
    if (typeof r.company !== 'string' || !r.company || !STATUSES.includes(r.status)) continue;
    latest.set(appKey(r), r);
  }
  return [...latest.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/**
 * Dedupe check used by agents before they start on a posting.
 * mode 'live': a posting only filled in during Practice (status "ready") is NOT a duplicate, because the person has
 * not actually applied yet. mode 'practice' (the default): it is.
 */
export function checkDuplicate(store, { company, role, url }, { mode = 'practice' } = {}) {
  const rows = listApplications(store);
  const co = normalizeCompany(company);
  const want = clean(role, 200).toLowerCase();
  const live = mode === 'live';
  let practiceReady = null;
  for (const r of rows) {
    if (normalizeCompany(r.company) !== co) continue;
    if (r.status === 'submitted') return { duplicate: true, reason: 'already submitted to this company (one application per company)', status: r.status, role: r.role };
    if (r.status === 'ready' && (!want || clean(r.role, 200).toLowerCase() === want)) {
      if (live) practiceReady = r;
      else return { duplicate: true, reason: 'already filled in practice mode', status: r.status, role: r.role };
    }
  }
  if (url) {
    const key = appKey({ url });
    for (const r of rows) {
      if (r.url && appKey(r) === key && r.status !== 'skipped') {
        if (r.status === 'ready' && live) { practiceReady = r; continue; }
        return { duplicate: true, reason: 'this posting is already recorded', status: r.status, role: r.role };
      }
    }
  }
  if (practiceReady) return { duplicate: false, status: 'ready', note: 'Filled in during a Practice run, not submitted. This is a Live run, so apply for real.' };
  return { duplicate: false };
}

// --- claims: "I am working on this posting" ----------------------------------------------------

export const CLAIM_MINUTES = 45;

function sleepMs(ms) { sleepSync(ms); }

/**
 * Atomically claim a posting for one agent. Another agent asking for the same posting (same URL, or same company and
 * role) is told it is taken for the next CLAIM_MINUTES. The same agent may claim again.
 */
export function claimPosting(store, { company, role, url }, { agent = '', run = '' } = {}) {
  store.ensure();
  const lock = store.resolve('claims.lock');
  let have = false;
  for (let i = 0; i < 60 && !have; i++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      have = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true }); // a crashed holder
      } catch { /* it just went away */ }
      sleepMs(25 + (i % 5) * 10);
    }
  }
  if (!have) return { claimed: false, duplicate: false, reason: 'could not get the claim lock' };
  try {
    const now = Date.now();
    const co = normalizeCompany(company);
    const rl = clean(role, 200).toLowerCase();
    const key = url ? appKey({ url }) : null;
    const live = store.readJsonl(FILES.claims).filter((c) => Number(c.expires) > now);
    const mine = clean(agent, 40) || 'agent';
    for (const c of live) {
      if (c.agent === mine && c.run === clean(run, 60)) continue;
      const sameUrl = key && c.key === key;
      const sameRole = c.company === co && c.role === rl && rl;
      if (sameUrl || sameRole) return { claimed: false, duplicate: true, reason: 'another agent is already working on this posting', by: c.agent };
    }
    store.appendJsonl(FILES.claims, { ts: new Date(now).toISOString(), expires: now + CLAIM_MINUTES * 60_000, agent: mine, run: clean(run, 60), company: co, role: rl, key, url: clean(url, 2000), companyRaw: clean(company, 200), roleRaw: clean(role, 200) });
    // Keep the file small: rewrite it with only live claims when it grows.
    if (live.length > 200) store.writeJson(FILES.claims, live);
    return { claimed: true, duplicate: false };
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function recordHeld(store, input, extra = {}) {
  const question = clean(input.question, 1000);
  if (!question) throw new Error('question is required for held entries');
  const company = clean(input.company, 200);
  if (!company) throw new Error('company is required');
  const url = clean(input.url, 2000);
  if (url && !/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
  // The same question for the same posting is one question, however many agents or retries report it.
  const same = listHeld(store).find((h) => h.open && appKey(h) === appKey({ url, company, role: clean(input.role, 200) }) && h.question.toLowerCase() === question.toLowerCase());
  if (same) return same;
  const rec = {
    id: newId('h_'),
    ts: new Date().toISOString(),
    company,
    role: clean(input.role, 200),
    url,
    question,
    source: clean(input.source, 60),
    note: clean(input.note, 1000),
    agent: clean(extra.agent ?? input.agent, 40),
    run: clean(extra.run ?? input.run, 60),
  };
  store.appendJsonl(FILES.held, rec);
  return rec;
}

export function resolveHeld(store, id, { answer = '', dismissed = false } = {}) {
  const line = { id, resolved: true, ts: new Date().toISOString(), dismissed: !!dismissed, answer: clean(answer, 2000) };
  store.appendJsonl(FILES.held, line);
  return line;
}

/** Held questions, folded with their resolutions. Open ones first. */
export function listHeld(store) {
  const items = new Map();
  const resolutions = new Map();
  for (const r of store.readJsonl(FILES.held)) {
    if (r.resolved && r.id) resolutions.set(String(r.id), r);
    else if (r.id && typeof r.company === 'string' && r.company && typeof r.question === 'string' && r.question) items.set(String(r.id), r);
  }
  const out = [...items.values()].map((h) => {
    const res = resolutions.get(String(h.id));
    return { ...h, open: !res, answer: res?.answer || '', dismissed: !!res?.dismissed, resolvedAt: res?.ts || null };
  });
  return out.sort((a, b) => Number(b.open) - Number(a.open) || String(b.ts).localeCompare(String(a.ts)));
}

/**
 * Held postings that the person has since answered and that are still unfinished.
 * One entry per posting, with all of its questions and answers joined. A posting is left out when any of its
 * questions was dismissed ("not applying"), or when one is still open.
 */
export function listRetryable(store) {
  const apps = new Map(listApplications(store).map((a) => [appKey(a), a]));
  const groups = new Map();
  const blocked = new Set();
  for (const h of listHeld(store)) {
    const key = appKey(h);
    if (h.open || h.dismissed) blocked.add(key);
    if (h.open || h.dismissed) continue;
    const current = apps.get(key);
    if (current && current.status !== 'held') continue;
    const g = groups.get(key) || { ...h, question: [], answer: [] };
    g.question.push(h.question);
    if (h.answer) g.answer.push(h.answer);
    groups.set(key, g);
  }
  return [...groups.entries()].filter(([key]) => !blocked.has(key)).map(([, g]) => ({ ...g, question: g.question.join(' | '), answer: g.answer.join(' | ') }));
}

const CSV_COLUMNS = ['ts', 'company', 'role', 'pay', 'source', 'status', 'url', 'note'];

export function toCsv(rows) {
  const esc = (v) => {
    let s = String(v ?? '');
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

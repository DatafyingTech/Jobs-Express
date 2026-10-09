// Local file store. Everything the app remembers lives under one data directory
// (default: ./data, override with CJA_DATA_DIR). Nothing here talks to the network,
// and every path is checked so a bad name can never write outside that directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FILES = {
  profile: 'profile.json',
  state: 'state.json',
  applications: 'applications.jsonl',
  held: 'held.jsonl',
  runs: 'runs',
  resume: 'resume',
};

export const STATUSES = ['submitted', 'ready', 'held', 'skipped'];

export function resolveDataDir(env = process.env) {
  return path.resolve(env.CJA_DATA_DIR || path.join(ROOT, 'data'));
}

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

export function createStore(dataDir = resolveDataDir()) {
  const base = path.resolve(dataDir);

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
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(resolve(FILES.runs), { recursive: true });
    fs.mkdirSync(resolve(FILES.resume), { recursive: true });
    return base;
  }

  function readJson(rel, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(resolve(rel), 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJson(rel, obj) {
    const target = resolve(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return target;
  }

  function appendJsonl(rel, obj) {
    const target = resolve(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(obj) + '\n', 'utf8');
    return obj;
  }

  /** Read a JSON-lines file, silently skipping any line that is not valid JSON. */
  function readJsonl(rel) {
    let text;
    try {
      text = fs.readFileSync(resolve(rel), 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object') out.push(v);
      } catch {
        /* a half-written line should never break the dashboard */
      }
    }
    return out;
  }

  return { dataDir: base, resolve, ensure, readJson, writeJson, appendJsonl, readJsonl };
}

// ---------------------------------------------------------------------------
// Applications and held questions
// ---------------------------------------------------------------------------

const clean = (v, max = 500) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export function normalizeCompany(name) {
  return clean(name, 200)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|gmbh|plc)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function appKey(r) {
  if (r.url) return 'u:' + String(r.url).replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  return 'c:' + normalizeCompany(r.company) + '|' + clean(r.role, 200).toLowerCase();
}

export function makeApplicationRecord(input, extra = {}) {
  const status = String(input.status || '').toLowerCase();
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const company = clean(input.company, 200);
  if (!company) throw new Error('company is required');
  const url = clean(input.url, 1000);
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
    if (!r.company || !STATUSES.includes(r.status)) continue;
    latest.set(appKey(r), r);
  }
  return [...latest.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/** Dedupe check used by agents before they start on a posting. */
export function checkDuplicate(store, { company, role, url }) {
  const rows = listApplications(store);
  const co = normalizeCompany(company);
  const want = clean(role, 200).toLowerCase();
  for (const r of rows) {
    if (normalizeCompany(r.company) !== co) continue;
    if (r.status === 'submitted') return { duplicate: true, reason: 'already submitted to this company', status: r.status, role: r.role };
    if (r.status === 'ready' && (!want || clean(r.role, 200).toLowerCase() === want)) {
      return { duplicate: true, reason: 'already filled in practice mode', status: r.status, role: r.role };
    }
  }
  if (url) {
    const key = appKey({ url });
    for (const r of rows) {
      if (r.url && appKey(r) === key && r.status !== 'skipped') {
        return { duplicate: true, reason: 'this posting is already recorded', status: r.status, role: r.role };
      }
    }
  }
  return { duplicate: false };
}

export function recordHeld(store, input, extra = {}) {
  const question = clean(input.question, 1000);
  if (!question) throw new Error('question is required for held entries');
  const company = clean(input.company, 200);
  if (!company) throw new Error('company is required');
  const url = clean(input.url, 1000);
  if (url && !/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
  const rec = {
    id: newId('h_'),
    ts: new Date().toISOString(),
    company,
    role: clean(input.role, 200),
    url,
    question,
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
    if (r.resolved && r.id) resolutions.set(r.id, r);
    else if (r.id && r.company && r.question) items.set(r.id, r);
  }
  const out = [...items.values()].map((h) => {
    const res = resolutions.get(h.id);
    return { ...h, open: !res, answer: res?.answer || '', dismissed: !!res?.dismissed, resolvedAt: res?.ts || null };
  });
  return out.sort((a, b) => Number(b.open) - Number(a.open) || String(b.ts).localeCompare(String(a.ts)));
}

/**
 * Held postings that the person has since answered and that are still unfinished.
 * One entry per posting, with all of its questions and answers joined.
 */
export function listRetryable(store) {
  const apps = new Map(listApplications(store).map((a) => [appKey(a), a]));
  const groups = new Map();
  for (const h of listHeld(store)) {
    if (h.open || h.dismissed) continue;
    const key = appKey(h);
    const current = apps.get(key);
    if (current && current.status !== 'held') continue;
    const g = groups.get(key) || { ...h, question: [], answer: [] };
    g.question.push(h.question);
    if (h.answer) g.answer.push(h.answer);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, question: g.question.join(' | '), answer: g.answer.join(' | ') }));
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

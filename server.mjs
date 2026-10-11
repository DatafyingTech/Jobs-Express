#!/usr/bin/env node
// Jobs Express: a tiny local web server. Binds to 127.0.0.1 only, no dependencies.
//   node server.mjs            normal mode, your data in ./data
//   node server.mjs --demo     fictional sample data, no real browser or Claude calls
//   node server.mjs --port 4400 --no-open
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, FILES, createStore, resolveDataDir, listApplications, listHeld, listRetryable, resolveHeld, toCsv, STATUSES,
} from './lib/store.mjs';
import { loadProfile, saveProfile, saveResume, addQa, removeQa, profileGaps, profileWarnings, MAX_RESUME_BYTES, CATEGORY_OPTIONS, SENIORITY_OPTIONS, WORK_MODES, WORK_AUTH_OPTIONS } from './lib/profile.mjs';
import {
  runPreflight, testChromeConnection, loadState, saveState, openInBrowser, platformLabel, EXTENSION_URL, LINKEDIN_URL,
} from './lib/preflight.mjs';
import { Runner } from './lib/runner.mjs';
import { DemoRunner, seedDemo, demoPreflight } from './lib/demo.mjs';
import {
  loadSchedule, saveSchedule, validateSchedule, scheduleSummary, listDigests, readDigest, LIMITS, LIVE_ACCEPT_TEXT, TASK_NAME,
} from './lib/schedule.mjs';
import {
  installSchedule, querySchedule, removeSchedule, schedulerKind, KIND_LABEL, SchedulerError, taskNameFromEnv, scheduledArgs,
} from './lib/scheduler.mjs';
import { runScheduled, planScheduledRun, TEST_LIMITS } from './lib/daily.mjs';
import { SetupJobs, installCommand, LOGIN_DISPLAY } from './lib/setup-actions.mjs';
import { describeHolder } from './lib/lock.mjs';

export const APP_NAME = 'jobs-express';
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PUBLIC_DIR = path.join(ROOT, 'public');
const START_PORT = 4317;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body, { head = false } = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(head ? undefined : data);
}

const DRAIN_LIMIT = 256 * 1024 * 1024;

/**
 * Read a request body. If it is larger than `limit` the rest is read and thrown away (not kept in memory), so the
 * browser can finish sending and then receives a proper 413 message instead of a dropped connection.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > DRAIN_LIMIT) {
        req.destroy();
        reject(new HttpError(413, 'That upload is too large.'));
        return;
      }
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(new HttpError(413, 'That upload is too large.')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/** The JSON body as a plain object. An empty body is {}. Anything that is not an object (null, a list, a number) is a 400. */
async function readJson(req, limit = 1_000_000) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  let v;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request was not valid JSON.');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'The request body must be a JSON object.');
  return v;
}

function decodeParam(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new HttpError(400, 'That address is not valid.');
  }
}

/**
 * One "world": a data store, a runner, the API routes and the live-event clients.
 * The real app and the demo are two separate worlds, so demo mode can never touch real data.
 */
function createContext({ store, demo, runner, preflight, getPort, schedulerCtx, setupJobs, scheduleDeps }) {
  store.ensure();
  const theRunner = runner || (demo ? new DemoRunner({ store }) : new Runner({ store }));
  const sseClients = new Set();
  const jobs = setupJobs || new SetupJobs();
  let testing = false;

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      // A viewer that stopped reading must not make the server balloon. Drop it; the page reconnects by itself.
      if (res.writableLength > 2 * 1024 * 1024) {
        sseClients.delete(res);
        res.destroy();
        continue;
      }
      res.write(payload);
    }
  };
  theRunner.on('log', (e) => broadcast('log', e));
  theRunner.on('run', (s) => broadcast('run', s));
  theRunner.on('records', (k) => broadcast('records', { kind: k }));
  jobs.on('event', (e) => broadcast('setup', e));

  // The operating-system side of the daily schedule. Demo mode gets a stand-in that touches nothing.
  const osApi = demo
    ? {
      kind: 'demo', label: 'Sample scheduler (demo mode, nothing is installed)',
      install: async () => ({ kind: 'demo', label: 'Sample scheduler (demo mode, nothing is installed)' }),
      query: async () => { const sc = loadSchedule(store); return { installed: sc.enabled, kind: 'demo', label: 'Sample scheduler (demo mode)', time: sc.time, days: sc.days, startWhenAvailable: true, wakeToRun: true }; },
      remove: async () => ({ removed: true }),
    }
    : (() => {
      const name = taskNameFromEnv();
      const kind = schedulerKind(schedulerCtx?.platform);
      return {
        kind, label: KIND_LABEL[kind],
        install: (spec) => installSchedule({ ...spec, name }, schedulerCtx),
        query: () => querySchedule(name, schedulerCtx),
        remove: () => removeSchedule(name, schedulerCtx),
      };
    })();

  const osSpec = (v) => ({
    time: v.time, days: v.days,
    nodePath: process.execPath, scriptPath: path.join(ROOT, 'server.mjs'), workDir: ROOT,
    dataDir: path.resolve(store.dataDir) === path.resolve(ROOT, 'data') ? '' : store.dataDir,
    limitMinutes: v.maxMinutes + 30,
    display: process.env.DISPLAY,
  });

  /** The scheduler stores the command it will run. If Node or this folder moved, it is out of date. */
  const isStale = (system, v) => {
    if (!system?.installed || !system.command || demo) return false;
    const spec = osSpec(v);
    const want = [spec.nodePath, spec.scriptPath, ...scheduledArgs(spec)].join(' ').replace(/"/g, '').toLowerCase();
    return system.command.replace(/"/g, '').toLowerCase() !== want;
  };

  async function schedulePayload({ system = false } = {}) {
    const sc = loadSchedule(store);
    const out = {
      schedule: { enabled: sc.enabled, time: sc.time, days: sc.days, mode: sc.mode, liveAccepted: sc.liveAccepted, agents: sc.agents, maxApps: sc.maxApps, freshHours: sc.freshHours, maxMinutes: sc.maxMinutes },
      summary: scheduleSummary(sc),
      limits: LIMITS, testLimits: TEST_LIMITS, liveText: LIVE_ACCEPT_TEXT,
      os: { kind: osApi.kind, label: osApi.label, supported: osApi.kind !== 'unsupported' },
      digests: listDigests(store, 10),
      testRunning: testing,
    };
    if (system) {
      out.system = await osApi.query();
      out.system.stale = isStale(out.system, sc);
    }
    return out;
  }

  // The real preflight starts Claude Code twice. Share one result between callers for a few seconds.
  let pfCache = { at: 0, promise: null };
  const getPreflight = async ({ fresh = false } = {}) => {
    if (preflight) return preflight(store);
    if (demo) return demoPreflight(loadState(store));
    const now = Date.now();
    if (!fresh && pfCache.promise && now - pfCache.at < 4000) return pfCache.promise;
    const promise = runPreflight(store);
    pfCache = { at: now, promise };
    promise.catch(() => { if (pfCache.promise === promise) pfCache = { at: 0, promise: null }; });
    return promise;
  };
  let testingConnection = null;

  const routes = {
    'GET /api/health': async () => ({ ok: true, app: APP_NAME, version: VERSION, demo, port: getPort(), dataDir: demo ? '' : store.dataDir }),

    'GET /api/state': async () => {
      const profile = loadProfile(store);
      return {
        app: APP_NAME, version: VERSION, demo, platform: platformLabel(),
        dataDir: demo ? '(sample data, not saved)' : store.dataDir,
        profile,
        gaps: profileGaps(profile),
        run: theRunner.snapshot(),
        options: { categories: CATEGORY_OPTIONS, seniority: SENIORITY_OPTIONS, workModes: WORK_MODES, workAuth: WORK_AUTH_OPTIONS },
        counts: countApplications(),
        warnings: profileWarnings(store, profile),
        openHeld: listHeld(store).filter((h) => h.open).length,
        schedule: scheduleSummary(loadSchedule(store)),
        retryable: listRetryable(store).length,
        urls: { extension: EXTENSION_URL, linkedin: LINKEDIN_URL },
      };
    },

    'GET /api/profile': async () => loadProfile(store),
    'PUT /api/profile': async (req) => {
      const body = await readJson(req);
      return saveProfile(store, body);
    },

    'POST /api/answers/remove': async (req) => {
      const { q } = await readJson(req);
      if (typeof q !== 'string' || !q.trim()) throw new HttpError(400, 'Which answer?');
      removeQa(store, q);
      return { ok: true, profile: loadProfile(store) };
    },

    'POST /api/resume': async (req) => {
      const name = decodeParam(String(req.headers['x-filename'] || ''));
      const buf = await readBody(req, MAX_RESUME_BYTES + 1024);
      try {
        const p = saveResume(store, name, buf);
        return { ok: true, resumeName: p.about.resumeName };
      } catch (e) {
        throw new HttpError(400, e.message);
      }
    },

    'GET /api/preflight': async () => getPreflight(),
    'POST /api/preflight/test-connection': async () => {
      if (testingConnection) throw new HttpError(409, 'A connection test is already running.');
      let result;
      testingConnection = true;
      try {
        if (demo) {
          await new Promise((r) => setTimeout(r, 1200));
          result = { ok: true, reason: 'ok', at: new Date().toISOString() };
        } else {
          result = await testChromeConnection({ cwd: ROOT });
        }
      } finally {
        testingConnection = null;
      }
      saveState(store, { lastConnectionTest: result });
      return { result, preflight: await getPreflight({ fresh: true }) };
    },
    'POST /api/preflight/linkedin': async (req) => {
      const { confirmed } = await readJson(req);
      saveState(store, { linkedinConfirmed: confirmed === true, linkedinConfirmedAt: confirmed === true ? new Date().toISOString() : null });
      return getPreflight();
    },
    'POST /api/open': async (req) => {
      const { target } = await readJson(req);
      const url = target === 'linkedin' ? LINKEDIN_URL : target === 'extension' ? EXTENSION_URL : null;
      if (!url) throw new HttpError(400, 'Unknown target.');
      if (demo) return { ok: true, opened: 'nothing (demo mode)' };
      return { ok: true, ...openInBrowser(url, { allow: [LINKEDIN_URL, EXTENSION_URL] }) };
    },

    'GET /api/applications': async (req, url) => {
      let rows = listApplications(store);
      const status = url.searchParams.get('status');
      if (status && STATUSES.includes(status)) rows = rows.filter((r) => r.status === status);
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (q) rows = rows.filter((r) => `${r.company} ${r.role} ${r.source} ${r.note}`.toLowerCase().includes(q));
      return { rows, counts: countApplications() };
    },

    'GET /api/held': async () => ({ items: listHeld(store), retryable: listRetryable(store).length }),
    'POST /api/held/answer': async (req) => {
      const { id, answer, remember = true } = await readJson(req);
      const item = listHeld(store).find((h) => h.id === id);
      if (!item) throw new HttpError(404, 'That question was not found.');
      if (typeof answer !== 'string') throw new HttpError(400, 'Please type an answer first.');
      const a = answer.trim();
      if (!a) throw new HttpError(400, 'Please type an answer first.');
      resolveHeld(store, id, { answer: a });
      if (remember !== false) addQa(store, item.question, a);
      return { ok: true, items: listHeld(store), retryable: listRetryable(store).length };
    },
    'POST /api/held/dismiss': async (req) => {
      const { id } = await readJson(req);
      if (!listHeld(store).some((h) => h.id === id)) throw new HttpError(404, 'That question was not found.');
      resolveHeld(store, id, { dismissed: true });
      return { ok: true, items: listHeld(store), retryable: listRetryable(store).length };
    },

    'GET /api/run': async () => ({ run: theRunner.snapshot(), log: theRunner.recent(300) }),
    'POST /api/run/start': async (req) => {
      if (theRunner.active) throw new HttpError(409, 'A run is already going. Stop it first.');
      const body = await readJson(req);
      const profile = loadProfile(store);
      const mode = body.mode === 'live' ? 'live' : 'practice';
      if (mode === 'live' && body.confirmLive !== true) throw new HttpError(400, 'Live mode needs your explicit confirmation.');
      const gaps = profileGaps(profile);
      if (gaps.length && !demo) throw new HttpError(400, `Finish setup first. Still missing: ${gaps.join(', ')}.`);
      const task = body.task === 'held' ? 'held' : 'search';
      const agents = Math.min(3, Math.max(1, Number(body.agents) || 1));
      const limit = Math.min(100, Math.max(1, Number(body.limit) || profile.prefs.perRun || 10));
      const state = loadState(store);
      if (!demo && profile.prefs.sources.linkedin && !state.linkedinConfirmed) {
        throw new HttpError(400, 'Confirm that you are signed in to LinkedIn first (Settings, Requirements).');
      }
      saveProfile(store, { settings: { mode, agents } });
      try {
        const snap = theRunner.start({
          profile: loadProfile(store), mode, agents, limit, task, demoFast: demo && body.demoFast === true,
        });
        return { ok: true, run: snap };
      } catch (e) {
        throw new HttpError(e.code === 'LOCKED' ? 409 : 400, e.message);
      }
    },
    'POST /api/run/stop': async () => ({ ok: true, run: theRunner.stop('Stopped by you.') }),

    // --- daily schedule ----------------------------------------------------------------------
    'GET /api/schedule': async (req, url) => schedulePayload({ system: url.searchParams.get('system') === '1' }),
    'PUT /api/schedule': async (req) => {
      const body = await readJson(req);
      const v = validateSchedule(body);
      if (!v.ok) throw new HttpError(400, v.errors.join(' '));
      if (osApi.kind === 'unsupported') throw new HttpError(400, 'Scheduling is not supported on this operating system.');
      try {
        await osApi.install(osSpec(v.value));
      } catch (e) {
        if (e instanceof SchedulerError) throw new HttpError(502, e.message);
        throw e;
      }
      saveSchedule(store, { ...v.value, enabled: true, savedAt: new Date().toISOString() });
      return { ok: true, ...(await schedulePayload({ system: true })) };
    },
    'DELETE /api/schedule': async () => {
      try {
        await osApi.remove();
      } catch (e) {
        if (e instanceof SchedulerError) throw new HttpError(502, e.message);
        throw e;
      }
      saveSchedule(store, { enabled: false });
      return { ok: true, ...(await schedulePayload({ system: true })) };
    },
    'POST /api/schedule/preview': async (req) => {
      const body = await readJson(req);
      const plan = await planScheduledRun({ store, test: body.test !== false, deps: { preflight: () => getPreflight(), ...scheduleDeps } });
      return { ok: true, plan };
    },
    'POST /api/schedule/test': async (req) => {
      const { confirm } = await readJson(req);
      if (confirm !== true) throw new HttpError(400, 'Please confirm the test run first.');
      if (testing || theRunner.active) throw new HttpError(409, 'A run is already going. Stop it first.');
      testing = true;
      const done = (extra) => { broadcast('schedule', { done: true, ...extra }); broadcast('records', { kind: 'done' }); };
      if (demo) {
        setTimeout(() => { testing = false; done({ status: 'finished', demo: true }); }, 600).unref?.();
        broadcast('schedule', { line: 'Demo mode: no agents are launched.' });
        return { ok: true, started: true, demo: true };
      }
      runScheduled({ store, test: true, runner: theRunner, log: (line) => broadcast('schedule', { line }), deps: { preflight: () => getPreflight(), ...scheduleDeps } })
        .then((r) => done({ status: r.status, digest: r.digestName, error: r.digest.error, hint: r.digest.hint }))
        .catch((e) => done({ status: 'failed', error: e.message }))
        .finally(() => { testing = false; });
      return { ok: true, started: true };
    },
    'GET /api/digests': async () => ({ items: listDigests(store, 30) }),
    'GET /api/digest': async (req, url) => {
      const d = readDigest(store, url.searchParams.get('name') || '');
      if (!d) throw new HttpError(404, 'That digest was not found.');
      return d;
    },

    // --- one-click setup ---------------------------------------------------------------------
    'GET /api/setup': async () => ({ install: installCommand(), login: { display: LOGIN_DISPLAY }, job: jobs.snapshot(), enabled: !demo }),
    'POST /api/setup/install': async (req) => {
      const { confirm } = await readJson(req);
      if (confirm !== true) throw new HttpError(400, 'Please confirm the install first.');
      if (demo) throw new HttpError(400, 'Installing is turned off in demo mode.');
      try {
        return { ok: true, job: jobs.start('install') };
      } catch (e) {
        throw new HttpError(e.code === 'BUSY' ? 409 : 400, e.message);
      }
    },
    'POST /api/setup/login': async () => {
      if (demo) throw new HttpError(400, 'Signing in is turned off in demo mode.');
      try {
        return { ok: true, job: jobs.start('login') };
      } catch (e) {
        if (e.code === 'CLAUDE_NOT_FOUND') throw new HttpError(400, 'Claude Code is not installed yet. Install it first.');
        throw new HttpError(e.code === 'BUSY' ? 409 : 400, e.message);
      }
    },
    'POST /api/setup/cancel': async () => ({ ok: true, job: jobs.cancel() }),
  };

  function countApplications() {
    const c = { all: 0, submitted: 0, ready: 0, held: 0, skipped: 0 };
    for (const r of listApplications(store)) {
      c.all += 1;
      c[r.status] += 1;
    }
    return c;
  }

  function handleSse(req, res) {
    if (sseClients.size >= 20) throw new HttpError(503, 'Too many open windows.');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ app: APP_NAME, demo, run: theRunner.snapshot() })}\n\n`);
    sseClients.add(res);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    beat.unref?.();
    req.on('close', () => {
      clearInterval(beat);
      sseClients.delete(res);
    });
  }


  return {
    routes, handleSse, runner: theRunner, store, demo,
    closeClients() { for (const res of sseClients) res.end(); sseClients.clear(); },
    shutdown() { jobs.cancel(); },
  };
}

/**
 * Create the app. Returns { server, runner, store, listen(port), close() }.
 * @param {object} o
 * @param {object} [o.store]
 * @param {boolean} [o.demo]   serve fictional sample data only
 * @param {object} [o.runner]  inject a runner (tests)
 */
export function createApp({ store = createStore(), demo = false, runner = null, preflight = null, token = null, schedulerCtx = null, setupJobs = null, scheduleDeps = null } = {}) {
  let boundPort = 0;
  const getPort = () => boundPort;
  // A fresh random secret per launch. The page that this server hands out carries it; a web page on any other
  // origin has no way to read it, so it cannot start agents or read your data through localhost.
  const secret = token || crypto.randomBytes(32).toString('hex');
  const main = createContext({ store, demo, runner, preflight, getPort, schedulerCtx, setupJobs, scheduleDeps });
  let demoCtx = demo ? main : null;
  let demoDir = null;
  // ?demo=1 on a normal server gets its own throw-away world with sample data.
  const contextFor = (req, url) => {
    const wants = url.searchParams.get('demo') === '1' || req.headers['x-cja-demo'] === '1';
    if (!wants || demo) return main;
    if (!demoCtx) {
      demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-demo-'));
      const dstore = createStore(demoDir);
      seedDemo(dstore);
      demoCtx = createContext({ store: dstore, demo: true, runner: null, preflight: null, getPort, schedulerCtx, setupJobs: null, scheduleDeps: null });
    }
    return demoCtx;
  };

  // DNS rebinding defence: only our own address, on our own port.
  function hostAllowed(req) {
    const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(String(req.headers.host || '').toLowerCase());
    return !!m && Number(m[2]) === boundPort;
  }

  const allowedOrigins = () => new Set(['127.0.0.1', 'localhost', '[::1]'].map((h) => `http://${h}:${boundPort}`));

  // CSRF defence for anything that changes state: the Origin must be this server, or absent with no cross-site hint.
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (origin === undefined) {
      const site = req.headers['sec-fetch-site'];
      return !site || site === 'same-origin' || site === 'none';
    }
    return allowedOrigins().has(String(origin).toLowerCase());
  }

  function cookieValue(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }

  const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const tokenOk = (req) => same(String(req.headers['x-cja-token'] || ''), secret) || same(cookieValue(req, 'cja_token'), secret);

  function serveStatic(req, res, pathname) {
    let rel = decodeParam(pathname);
    if (rel === '/') rel = '/index.html';
    const target = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) throw new HttpError(403, 'Forbidden');
    let file = target;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(rel)) throw new HttpError(404, 'Not found');
      file = path.join(PUBLIC_DIR, 'index.html');
    }
    let data = fs.readFileSync(file);
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (path.basename(file) === 'index.html') {
      data = Buffer.from(data.toString('utf8').replace('__CJA_TOKEN__', secret), 'utf8');
      headers['Set-Cookie'] = `cja_token=${secret}; Path=/; HttpOnly; SameSite=Strict`;
    }
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) throw new HttpError(403, 'This server only answers on localhost.');
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        throw new HttpError(400, 'That address is not valid.');
      }
      const method = req.method || 'GET';
      const ctx = contextFor(req, url);
      const { routes, handleSse, store: cstore } = ctx;

      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
        if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req)) throw new HttpError(403, 'This request came from another website, so it was refused.');
        if (!tokenOk(req)) {
          throw Object.assign(new HttpError(403, 'This page is out of date or did not come from the app. Reload the page and try again.'), { code: 'token' });
        }
      }

      if (method === 'GET' && url.pathname === '/api/events') return handleSse(req, res);

      if (method === 'GET' && url.pathname === '/api/applications.csv') {
        const csv = toCsv(listApplications(cstore));
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="applications.csv"',
          'Cache-Control': 'no-store',
        });
        return res.end('﻿' + csv);
      }

      if (url.pathname.startsWith('/api/')) {
        // Browsers cannot add this header to a cross-site request without our consent, so it blocks CSRF.
        if (method !== 'GET' && method !== 'HEAD' && req.headers['x-cja'] !== '1') {
          throw new HttpError(403, 'Missing X-CJA header.');
        }
        const handler = routes[`${method === 'HEAD' ? 'GET' : method} ${url.pathname}`];
        if (!handler) throw new HttpError(404, 'No such endpoint.');
        return sendJson(res, 200, await handler(req, url), { head: method === 'HEAD' });
      }

      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e.status || 500;
      if (status === 500) console.error('[server]', e.stack || e);
      sendJson(res, status, { ok: false, error: status === 500 ? 'Something went wrong on the server.' : e.message, ...(e.code === 'token' ? { code: 'token' } : {}) });
    }
  });

  function listen(port = START_PORT, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        boundPort = server.address().port;
        resolve(boundPort);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  function close() {
    main.closeClients();
    main.shutdown();
    if (demoCtx) { demoCtx.closeClients(); demoCtx.shutdown(); }
    if (demoDir) fs.rmSync(demoDir, { recursive: true, force: true });
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, runner: main.runner, store, listen, close, token: secret };
}

// --- the unattended daily run ----------------------------------------------------------------
//   node server.mjs --scheduled-run               what the operating system's scheduler starts
//   node server.mjs --scheduled-run --dry-run     print what it would do, launch nothing (add --json for machine output)
//   node server.mjs --scheduled-run --test        a small Practice-only run, the same one the Settings button starts

async function scheduledMain(args) {
  const store = createStore(resolveDataDir());
  store.ensure();
  const dry = args.includes('--dry-run');
  const test = args.includes('--test');
  const json = args.includes('--json');
  if (dry) {
    const plan = await planScheduledRun({ store, test });
    console.log(json ? JSON.stringify(plan, null, 2) : plan.lines.join('\n'));
    return plan.ok ? 0 : 1;
  }
  const logFile = store.resolve('scheduled-run.log');
  try {
    // Keep the log small: start over once it passes 1 MB.
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.rmSync(logFile);
  } catch { /* the log is a convenience */ }
  const log = (line) => {
    const text = `${new Date().toISOString()} ${line}`;
    console.log(text);
    try { fs.appendFileSync(logFile, text + '\n'); } catch { /* ignore */ }
  };
  log(`Jobs Express ${VERSION}: scheduled run${test ? ' (test)' : ''} starting. Data folder: ${store.dataDir}`);
  const runner = new Runner({ store });
  const stopNow = () => runner.stop('The computer is shutting this run down.');
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, stopNow);
  process.on('exit', () => runner.killAllSync());
  const result = await runScheduled({ store, test, runner, log });
  log(`Scheduled run ${result.status}. Exit code ${result.exitCode}.`);
  return result.exitCode;
}

// --- start-up ---------------------------------------------------------------------------------

async function listenOnFreePort(app, first) {
  for (let port = first; port < first + 20; port++) {
    try {
      return await app.listen(port);
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  return app.listen(0);
}

async function findRunningInstance(first, dataDir) {
  for (let port = first; port < first + 20; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(600) });
      const j = await res.json();
      if (j.app === APP_NAME && !j.demo) return { port, dataDir: j.dataDir || '', same: !j.dataDir || path.resolve(j.dataDir) === path.resolve(dataDir) };
    } catch {
      /* nothing there */
    }
  }
  return null;
}

function openDefaultBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const c = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
  } catch {
    /* the URL is printed anyway */
  }
}

// Compare real paths, so starting the app through a shortcut, symlink or junction still works.
const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const noOpen = args.includes('--no-open') || !!process.env.CJA_NO_OPEN;
  const portIdx = args.indexOf('--port');
  const wantedPort = portIdx >= 0 ? Number(args[portIdx + 1]) : START_PORT;
  if (portIdx >= 0 && !(Number.isInteger(wantedPort) && wantedPort >= 1 && wantedPort <= 65535)) {
    console.error(`"--port ${args[portIdx + 1] ?? ''}" is not a port number. Use a whole number from 1 to 65535, like: node server.mjs --port 4400`);
    process.exit(1);
  }

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`Jobs Express needs Node.js 18 or newer. You have ${process.versions.node}. Get the LTS release at https://nodejs.org`);
    process.exit(1);
  }

  const dirIdx = args.indexOf('--data-dir');
  if (dirIdx >= 0 && args[dirIdx + 1]) process.env.CJA_DATA_DIR = path.resolve(args[dirIdx + 1]);

  if (args.includes('--scheduled-run')) {
    process.exit(await scheduledMain(args));
  }

  if (!demo) {
    const existing = await findRunningInstance(wantedPort, resolveDataDir());
    if (existing) {
      const url = `http://127.0.0.1:${existing.port}/`;
      console.log(`Jobs Express is already running (data folder: ${existing.dataDir || 'unknown'}).${existing.same ? '' : ' That is a different data folder from the one you asked for.'}`);
      if (noOpen) console.log(`Not opening a window. It is at ${url}`);
      else {
        console.log(`Opening ${url}`);
        openDefaultBrowser(url);
      }
      process.exit(0);
    }
  }

  let store;
  let demoDir = null;
  try {
    if (demo) {
      demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-demo-'));
      store = createStore(demoDir);
      seedDemo(store);
    } else {
      store = createStore(resolveDataDir());
      store.ensure();
      store.harden();
    }
  } catch (e) {
    console.error(`Jobs Express cannot use its data folder (${demo ? demoDir : resolveDataDir()}): ${e.code || e.message}. Pick a folder you can write to, for example: set CJA_DATA_DIR=C:\\Users\\you\\JobsExpressData`);
    process.exit(1);
  }

  const app = createApp({ store, demo });
  const port = await listenOnFreePort(app, wantedPort);
  const url = `http://127.0.0.1:${port}/${demo ? '?demo=1' : ''}`;
  console.log(`\n  Jobs Express ${VERSION}${demo ? '  (demo mode, sample data)' : ''}`);
  console.log(`  Running at ${url}`);
  console.log(`  Your data stays in: ${demo ? '(nothing is saved in demo mode)' : store.dataDir}`);
  console.log('  Press Ctrl+C to stop.\n');
  if (!noOpen) openDefaultBrowser(url);

  // Closing the window (SIGHUP on macOS and Linux, a console close on Windows) must stop the agents too.
  // exit handlers cannot wait, so the kill is synchronous.
  let leaving = false;
  const cleanup = () => {
    if (leaving) return;
    leaving = true;
    try { app.runner.killAllSync?.(); } catch { /* best effort */ }
    if (demoDir) { try { fs.rmSync(demoDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } }
  };
  const shutdown = async () => {
    app.runner.stop?.('The app is closing.');
    cleanup();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.on('SIGBREAK', shutdown);
  process.on('exit', cleanup);
}

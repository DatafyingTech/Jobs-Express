#!/usr/bin/env node
// Jobs Express: a tiny local web server. Binds to 127.0.0.1 only, no dependencies.
//   node server.mjs            normal mode, your data in ./data
//   node server.mjs --demo     fictional sample data, no real browser or Claude calls
//   node server.mjs --port 4400 --no-open
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, FILES, createStore, resolveDataDir, listApplications, listHeld, listRetryable, resolveHeld, toCsv, STATUSES,
} from './lib/store.mjs';
import { loadProfile, saveProfile, saveResume, addQa, profileGaps, MAX_RESUME_BYTES, CATEGORY_OPTIONS, SENIORITY_OPTIONS, WORK_MODES, WORK_AUTH_OPTIONS } from './lib/profile.mjs';
import {
  runPreflight, testChromeConnection, loadState, saveState, openInBrowser, platformLabel, EXTENSION_URL, LINKEDIN_URL,
} from './lib/preflight.mjs';
import { Runner } from './lib/runner.mjs';
import { DemoRunner, seedDemo, demoPreflight } from './lib/demo.mjs';

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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'That upload is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 1_000_000) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request was not valid JSON.');
  }
}

/**
 * One "world": a data store, a runner, the API routes and the live-event clients.
 * The real app and the demo are two separate worlds, so demo mode can never touch real data.
 */
function createContext({ store, demo, runner, preflight, getPort }) {
  store.ensure();
  const theRunner = runner || (demo ? new DemoRunner({ store }) : new Runner({ store }));
  const sseClients = new Set();

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  theRunner.on('log', (e) => broadcast('log', e));
  theRunner.on('run', (s) => broadcast('run', s));
  theRunner.on('records', (k) => broadcast('records', { kind: k }));

  const getPreflight = async () => {
    if (preflight) return preflight(store);
    if (demo) return demoPreflight(loadState(store));
    return runPreflight(store);
  };

  const routes = {
    'GET /api/health': async () => ({ ok: true, app: APP_NAME, version: VERSION, demo, port: getPort() }),

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
        openHeld: listHeld(store).filter((h) => h.open).length,
        retryable: listRetryable(store).length,
        urls: { extension: EXTENSION_URL, linkedin: LINKEDIN_URL },
      };
    },

    'GET /api/profile': async () => loadProfile(store),
    'PUT /api/profile': async (req) => {
      const body = await readJson(req);
      return saveProfile(store, body);
    },

    'POST /api/resume': async (req) => {
      const name = decodeURIComponent(String(req.headers['x-filename'] || ''));
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
      let result;
      if (demo) {
        await new Promise((r) => setTimeout(r, 1200));
        result = { ok: true, reason: 'ok', at: new Date().toISOString() };
      } else {
        result = await testChromeConnection({ cwd: ROOT });
      }
      saveState(store, { lastConnectionTest: result });
      return { result, preflight: await getPreflight() };
    },
    'POST /api/preflight/linkedin': async (req) => {
      const { confirmed } = await readJson(req);
      saveState(store, { linkedinConfirmed: !!confirmed, linkedinConfirmedAt: confirmed ? new Date().toISOString() : null });
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
      const a = String(answer || '').trim();
      if (!a) throw new HttpError(400, 'Please type an answer first.');
      resolveHeld(store, id, { answer: a });
      if (remember) addQa(store, item.question, a);
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
        throw new HttpError(400, e.message);
      }
    },
    'POST /api/run/stop': async () => ({ ok: true, run: theRunner.stop('Stopped by you.') }),
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


  return { routes, handleSse, runner: theRunner, store, demo, closeClients() { for (const res of sseClients) res.end(); sseClients.clear(); } };
}

/**
 * Create the app. Returns { server, runner, store, listen(port), close() }.
 * @param {object} o
 * @param {object} [o.store]
 * @param {boolean} [o.demo]   serve fictional sample data only
 * @param {object} [o.runner]  inject a runner (tests)
 */
export function createApp({ store = createStore(), demo = false, runner = null, preflight = null } = {}) {
  let boundPort = 0;
  const getPort = () => boundPort;
  const main = createContext({ store, demo, runner, preflight, getPort });
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
      demoCtx = createContext({ store: dstore, demo: true, runner: null, preflight: null, getPort });
    }
    return demoCtx;
  };

  function hostAllowed(req) {
    const host = String(req.headers.host || '').toLowerCase();
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const target = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) throw new HttpError(403, 'Forbidden');
    let file = target;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(rel)) throw new HttpError(404, 'Not found');
      file = path.join(PUBLIC_DIR, 'index.html');
    }
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) throw new HttpError(403, 'This server only answers on localhost.');
      const url = new URL(req.url, 'http://localhost');
      const method = req.method || 'GET';
      const ctx = contextFor(req, url);
      const { routes, handleSse, store: cstore } = ctx;

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
        const handler = routes[`${method} ${url.pathname}`];
        if (!handler) throw new HttpError(404, 'No such endpoint.');
        return sendJson(res, 200, await handler(req, url));
      }

      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e.status || 500;
      if (status === 500) console.error('[server]', e);
      sendJson(res, status, { ok: false, error: status === 500 ? 'Something went wrong on the server.' : e.message });
    }
  });

  function listen(port = START_PORT, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        boundPort = server.address().port;
        resolve(boundPort);
      });
    });
  }

  function close() {
    main.closeClients();
    if (demoCtx) demoCtx.closeClients();
    if (demoDir) fs.rmSync(demoDir, { recursive: true, force: true });
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, runner: main.runner, store, listen, close };
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

async function findRunningInstance(first) {
  for (let port = first; port < first + 20; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(600) });
      const j = await res.json();
      if (j.app === APP_NAME && !j.demo) return port;
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const noOpen = args.includes('--no-open') || !!process.env.CJA_NO_OPEN;
  const portIdx = args.indexOf('--port');
  const wantedPort = portIdx >= 0 ? Number(args[portIdx + 1]) : START_PORT;

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`Jobs Express needs Node.js 18 or newer. You have ${process.versions.node}. Get the LTS release at https://nodejs.org`);
    process.exit(1);
  }

  if (!demo) {
    const existing = await findRunningInstance(wantedPort);
    if (existing) {
      const url = `http://127.0.0.1:${existing}/`;
      console.log(`Jobs Express is already running. Opening ${url}`);
      if (!noOpen) openDefaultBrowser(url);
      process.exit(0);
    }
  }

  let store;
  let demoDir = null;
  if (demo) {
    demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-demo-'));
    store = createStore(demoDir);
    seedDemo(store);
  } else {
    store = createStore(resolveDataDir());
  }

  const app = createApp({ store, demo });
  const port = await listenOnFreePort(app, wantedPort);
  const url = `http://127.0.0.1:${port}/${demo ? '?demo=1' : ''}`;
  console.log(`\n  Jobs Express ${VERSION}${demo ? '  (demo mode, sample data)' : ''}`);
  console.log(`  Running at ${url}`);
  console.log(`  Your data stays in: ${demo ? '(nothing is saved in demo mode)' : store.dataDir}`);
  console.log('  Press Ctrl+C to stop.\n');
  if (!noOpen) openDefaultBrowser(url);

  const shutdown = async () => {
    app.runner.stop?.('The app is closing.');
    await app.close();
    if (demoDir) fs.rmSync(demoDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

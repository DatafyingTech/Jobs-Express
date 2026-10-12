#!/usr/bin/env node
// Renders the demo-mode UI to PNG screenshots in docs/images/ and (if ffmpeg is on PATH) assembles docs/images/demo.gif.
//
//   node tools/record_demo.mjs              screenshots + gif
//   node tools/record_demo.mjs --no-gif     screenshots only
//
// Uses Playwright when it can be found (import 'playwright', or a folder given in CJA_PLAYWRIGHT_DIR),
// and otherwise falls back to headless Chrome or Edge screenshots. Playwright is NOT a dependency of this project.
// Everything shown is fictional sample data from lib/demo.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { createStore, ROOT } from '../lib/store.mjs';
import { seedDemo } from '../lib/demo.mjs';
import { detectBrowsers } from '../lib/preflight.mjs';
import { loadPlaywright } from './pw.mjs';

const OUT = path.join(ROOT, 'docs', 'images');
const W = 1440;
const H = 900;

// name, route, options
const SCENES = [
  ['01-setup-requirements', '/?demo=1#/setup/1', { wait: '.check-row' }],
  ['02-about-you', '/?demo=1#/setup/2', { wait: '.dropzone' }],
  ['03-preferences', '/?demo=1#/setup/3', { wait: '.chips' }],
  ['04-honest-profile', '/?demo=1#/setup/4', { wait: '.notice.calm' }],
  ['05-dashboard-live-run', '/?demo=1&scene=live#/', { wait: '.log-line', min: 8, settle: 1200 }],
  ['06-applications', '/?demo=1#/applications', { wait: 'table.apps' }],
  ['07-needs-input', '/?demo=1#/input', { wait: '.q-item' }],
  ['08-dashboard-dark', '/?demo=1&scene=live#/', { wait: '.log-line', min: 8, settle: 1200, dark: true, onlyPlaywright: true }],
  ['09-phone-dashboard', '/?demo=1&scene=live#/', { wait: '.log-line', min: 6, settle: 1000, phone: true, onlyPlaywright: true }],
  ['10-phone-applications', '/?demo=1#/applications', { wait: 'table.apps tbody tr', phone: true, onlyPlaywright: true }],
  ['11-daily-schedule', '/?demo=1#/settings/schedule', { wait: '.digest', settle: 1200, onlyPlaywright: true }],
  ['12-daily-digest', '/?demo=1#/settings/schedule', { wait: '.digest', settle: 1000, onlyPlaywright: true,
    act: async (page) => { await page.locator('.digest').first().locator('button').click(); await page.waitForSelector('.digest-detail ul'); await page.locator('.digest').first().scrollIntoViewIfNeeded(); await page.waitForTimeout(500); } }],
  ['13-phone-schedule', '/?demo=1#/settings/schedule', { wait: '.sched-actions', settle: 1200, phone: true, onlyPlaywright: true }],
  // The "Install Claude Code" button with its confirmation dialog, shown against a computer that has no Claude Code yet.
  ['14-install-claude', '/?demo=1#/setup/1', { wait: '.check-row', onlyPlaywright: true, missingClaude: true,
    act: async (page) => { await page.locator('button:has-text("Install Claude Code")').click(); await page.waitForSelector('dialog[open] pre.cmd'); await page.waitForTimeout(400); } }],
];

// The loop opens on the strongest image, the dashboard mid-run, then walks through setup and results, then the phone.
const GIF_ORDER = ['05-dashboard-live-run', '01-setup-requirements', '14-install-claude', '03-preferences', '04-honest-profile', '11-daily-schedule', '12-daily-digest', '06-applications', '07-needs-input', '09-phone-dashboard', '13-phone-schedule'];

// Rows for a computer that has not installed Claude Code yet (used only for the install screenshot).
const MISSING_CLAUDE = {
  rows: [
    { id: 'node', title: 'Node.js', status: 'ok', summary: 'Node.js 22.11.0 (sample)', hint: '' },
    { id: 'claude', title: 'Claude Code', status: 'fail', summary: 'Claude Code was not found.', hint: 'Install Claude Code, then click Re-check.', url: 'https://code.claude.com/docs/en/quickstart' },
    { id: 'auth', title: 'Signed in with a Claude plan', status: 'pending', summary: 'Waiting for Claude Code', hint: 'Install Claude Code first.' },
    { id: 'browser', title: 'Chrome or Edge', status: 'ok', summary: 'Google Chrome', hint: '' },
    { id: 'extension', title: 'Claude in Chrome extension', status: 'pending', summary: 'Not tested yet', hint: 'Click "Test connection". Chrome should be open with the Claude extension installed and signed in.' },
    { id: 'linkedin', title: 'LinkedIn is signed in', status: 'pending', summary: 'Waiting for your confirmation', hint: 'Open LinkedIn in the same Chrome profile that has the Claude extension, sign in yourself, then tick the box.' },
  ],
};

async function main() {
  const wantGif = !process.argv.includes('--no-gif');
  fs.mkdirSync(OUT, { recursive: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-record-'));
  const store = createStore(dir);
  seedDemo(store);
  const app = createApp({ store, demo: true });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const apiHeaders = { 'x-cja': '1', 'x-cja-token': app.token };
  const store2 = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cja-record2-')));
  seedDemo(store2);
  const app2 = createApp({ store: store2, demo: true, preflight: async () => MISSING_CLAUDE });
  const base2 = `http://127.0.0.1:${await app2.listen(0)}`;

  const browser = detectBrowsers()[0];
  const pw = await loadPlaywright();
  const shots = [];
  try {
    if (pw) {
      console.log('Using Playwright with', browser ? browser.name : 'its bundled Chromium');
      const b = await pw.chromium.launch({ headless: true, ...(browser ? { executablePath: browser.path } : {}) });
      for (const [name, route, o] of SCENES) {
        // The scripted run is global to the demo server, so give each scene a fresh server state.
        await fetch(`${base}/api/run/stop`, { method: 'POST', headers: apiHeaders }).catch(() => {});
        const ctx = await b.newContext(o.phone
          ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' }
          : { viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: o.dark ? 'dark' : 'light' });
        const target = o.missingClaude ? { url: base2, app: app2 } : { url: base, app };
        // The app only answers a window it opened itself: hand this browser the session cookie.
        await ctx.addCookies([{ name: 'cja_token', value: target.app.token, url: target.url }]);
        const page = await ctx.newPage();
        await page.goto(target.url + route);
        await page.waitForSelector(o.wait, { timeout: 15000 });
        if (o.min) await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length >= n, [o.wait, o.min], { timeout: 15000 });
        await page.waitForTimeout(o.settle ?? 600);
        if (o.act) await o.act(page);
        const file = path.join(OUT, `${name}.png`);
        await page.screenshot({ path: file, fullPage: !!o.full });
        shots.push([name, file]);
        console.log('  wrote', path.relative(ROOT, file));
        await ctx.close();
      }
      await b.close();
    } else if (browser) {
      console.log('Playwright not found; using headless', browser.name);
      for (const [name, route, o] of SCENES) {
        if (o.onlyPlaywright) continue;
        await fetch(`${base}/api/run/stop`, { method: 'POST', headers: apiHeaders }).catch(() => {});
        const file = path.join(OUT, `${name}.png`);
        const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-browser-'));
        const res = spawnSync(browser.path, [
          '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profileDir}`,
          `--window-size=${W},${H}`, '--force-device-scale-factor=2', '--virtual-time-budget=9000',
          // No cookie jar to fill here, so open the app's one-time link: it sets the cookie and redirects (the #fragment is kept).
          `--screenshot=${file}`, `${base}/?launch=${app.issueLaunchCode()}&demo=1${route.replace('/?demo=1', '').replace('/?demo=1&', '&')}`,
        ], { encoding: 'utf8', timeout: 60000 });
        // Edge can still hold the profile for a moment after it exits (EPERM, ENOTEMPTY on Windows). Cleaning up is never worth a failure.
        try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* leave it for the OS temp cleaner */ }
        if (!fs.existsSync(file)) throw new Error(`Screenshot failed for ${name}: ${res.stderr?.slice(0, 300)}`);
        shots.push([name, file]);
        console.log('  wrote', path.relative(ROOT, file));
      }
    } else {
      throw new Error('No Playwright and no Chrome or Edge found, so there is nothing to render with.');
    }
  } finally {
    await app.close();
    await app2.close();
    try { fs.rmSync(store2.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ }
  }

  if (wantGif) makeGif(shots);
}

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function makeGif(shots) {
  if (!hasFfmpeg()) {
    console.log('ffmpeg not found; skipped docs/images/demo.gif. Install ffmpeg and re-run to build it.');
    return;
  }
  const byName = Object.fromEntries(shots);
  let frames = GIF_ORDER.map((n) => byName[n]).filter(Boolean);
  if (frames.length < 2) return;
  const hold = 2.2;
  const fade = 0.5;
  const outW = 1000;
  const outH = Math.round(outW * (H / W));
  const out = path.join(OUT, 'demo.gif');
  // Phone screenshots are portrait. Scale them by height only and centre them on a desktop-shaped canvas
  // (2x size, same background colour as the app) BEFORE they become ffmpeg inputs, so they are never stretched.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-gif-'));
  frames = frames.map((f, i) => {
    if (!path.basename(f).includes('phone')) return f;
    const padded = path.join(tmp, `phone-${i}.png`);
    const r0 = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, '-vf', `scale=-2:${outH * 2},pad=${outW * 2}:${outH * 2}:(ow-iw)/2:0:color=0xf5f4f1`, '-frames:v', '1', padded], { encoding: 'utf8' });
    if (r0.status !== 0) throw new Error('Could not pad a phone frame: ' + (r0.stderr || '').slice(0, 300));
    return padded;
  });
  const args = ['-y', '-loglevel', 'error'];
  for (const f of frames) args.push('-loop', '1', '-t', String(hold + fade), '-i', f);
  let filter = frames.map((_, i) => `[${i}:v]scale=${outW}:${outH}:flags=lanczos,fps=10,format=yuv420p[v${i}]`).join(';');
  let last = 'v0';
  frames.slice(1).forEach((_, i) => {
    const n = i + 1;
    const offset = (hold * n).toFixed(2);
    filter += `;[${last}][v${n}]xfade=transition=fade:duration=${fade}:offset=${offset}[x${n}]`;
    last = `x${n}`;
  });
  filter += `;[${last}]split[a][b];[a]palettegen=max_colors=72:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', '-loop', '0', out);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) {
    if (process.env.CJA_DEBUG) console.log(args.join(' '));
    console.log('ffmpeg could not assemble the GIF (screenshots are still in docs/images/):', (r.stderr || '').slice(0, 400));
    return;
  }
  console.log('  wrote', path.relative(ROOT, out), `${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

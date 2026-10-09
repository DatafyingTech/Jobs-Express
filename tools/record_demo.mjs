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
import { createRequire } from 'node:module';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { createStore, ROOT } from '../lib/store.mjs';
import { seedDemo } from '../lib/demo.mjs';
import { detectBrowsers } from '../lib/preflight.mjs';

const OUT = path.join(ROOT, 'docs', 'images');
const W = 1440;
const H = 900;

// name, route, options
const SCENES = [
  ['01-setup-requirements', '/?demo=1#/setup/1', { wait: '.check-row' }],
  ['02-about-you', '/?demo=1#/setup/2', { wait: '.dropzone' }],
  ['03-preferences', '/?demo=1#/setup/3', { wait: '.chips' }],
  ['04-honest-profile', '/?demo=1#/setup/4', { wait: '.notice.calm' }],
  ['05-dashboard-live-run', '/?demo=1&scene=live#/', { wait: '.log-line', min: 14, settle: 1200 }],
  ['06-applications', '/?demo=1#/applications', { wait: 'table.apps' }],
  ['07-needs-input', '/?demo=1#/input', { wait: '.q-item' }],
  ['08-dashboard-dark', '/?demo=1&scene=live#/', { wait: '.log-line', min: 14, settle: 1200, dark: true, onlyPlaywright: true }],
];

const GIF_ORDER = ['01-setup-requirements', '02-about-you', '03-preferences', '04-honest-profile', '05-dashboard-live-run', '06-applications', '07-needs-input'];

async function loadPlaywright() {
  const attempts = [() => import('playwright')];
  const dirs = [process.env.CJA_PLAYWRIGHT_DIR].filter(Boolean);
  try {
    dirs.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* npm not available */ }
  for (const d of dirs) {
    attempts.push(async () => {
      const req = createRequire(path.join(d, 'noop.js'));
      return req('playwright');
    });
    attempts.push(async () => {
      const req = createRequire(path.join(d, 'noop.js'));
      return req(path.join(d, 'node_modules', 'playwright'));
    });
  }
  for (const a of attempts) {
    try {
      const m = await a();
      const pw = m.chromium ? m : m.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  return null;
}

async function main() {
  const wantGif = !process.argv.includes('--no-gif');
  fs.mkdirSync(OUT, { recursive: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-record-'));
  const store = createStore(dir);
  seedDemo(store);
  const app = createApp({ store, demo: true });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const browser = detectBrowsers()[0];
  const pw = await loadPlaywright();
  const shots = [];
  try {
    if (pw) {
      console.log('Using Playwright with', browser ? browser.name : 'its bundled Chromium');
      const b = await pw.chromium.launch({ headless: true, ...(browser ? { executablePath: browser.path } : {}) });
      for (const [name, route, o] of SCENES) {
        // The scripted run is global to the demo server, so give each scene a fresh server state.
        await fetch(`${base}/api/run/stop`, { method: 'POST', headers: { 'x-cja': '1' } }).catch(() => {});
        const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: o.dark ? 'dark' : 'light' });
        const page = await ctx.newPage();
        await page.goto(base + route);
        await page.waitForSelector(o.wait, { timeout: 15000 });
        if (o.min) await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length >= n, [o.wait, o.min], { timeout: 15000 });
        await page.waitForTimeout(o.settle ?? 600);
        const file = path.join(OUT, `${name}.png`);
        await page.screenshot({ path: file });
        shots.push([name, file]);
        console.log('  wrote', path.relative(ROOT, file));
        await ctx.close();
      }
      await b.close();
    } else if (browser) {
      console.log('Playwright not found; using headless', browser.name);
      for (const [name, route, o] of SCENES) {
        if (o.onlyPlaywright) continue;
        await fetch(`${base}/api/run/stop`, { method: 'POST', headers: { 'x-cja': '1' } }).catch(() => {});
        const file = path.join(OUT, `${name}.png`);
        const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-browser-'));
        const res = spawnSync(browser.path, [
          '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profileDir}`,
          `--window-size=${W},${H}`, '--force-device-scale-factor=2', '--virtual-time-budget=9000',
          `--screenshot=${file}`, base + route,
        ], { encoding: 'utf8', timeout: 60000 });
        fs.rmSync(profileDir, { recursive: true, force: true });
        if (!fs.existsSync(file)) throw new Error(`Screenshot failed for ${name}: ${res.stderr?.slice(0, 300)}`);
        shots.push([name, file]);
        console.log('  wrote', path.relative(ROOT, file));
      }
    } else {
      throw new Error('No Playwright and no Chrome or Edge found, so there is nothing to render with.');
    }
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
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
  const frames = GIF_ORDER.map((n) => byName[n]).filter(Boolean);
  if (frames.length < 2) return;
  const hold = 2.6;
  const fade = 0.5;
  const outW = 1000;
  const out = path.join(OUT, 'demo.gif');
  const args = ['-y', '-loglevel', 'error'];
  for (const f of frames) args.push('-loop', '1', '-t', String(hold + fade), '-i', f);
  // Scale every frame, cross-fade them one after another, then build a proper palette.
  let filter = frames.map((_, i) => `[${i}:v]scale=${outW}:-2:flags=lanczos,fps=12,format=yuv420p[v${i}]`).join(';');
  let last = 'v0';
  frames.slice(1).forEach((_, i) => {
    const n = i + 1;
    const offset = (hold * n).toFixed(2);
    filter += `;[${last}][v${n}]xfade=transition=fade:duration=${fade}:offset=${offset}[x${n}]`;
    last = `x${n}`;
  });
  filter += `;[${last}]split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', '-loop', '0', out);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) {
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

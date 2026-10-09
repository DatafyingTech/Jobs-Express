#!/usr/bin/env node
// Dev check: renders every route of the demo UI at phone, tablet and desktop widths with Playwright
// and fails if any page scrolls sideways or the main call to action is cut off.
//   CJA_PLAYWRIGHT_DIR=/path/to/playwright-folder node tools/check_layout.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { createStore } from '../lib/store.mjs';
import { seedDemo } from '../lib/demo.mjs';
import { detectBrowsers } from '../lib/preflight.mjs';
import { loadPlaywright } from './pw.mjs';

const WIDTHS = [360, 390, 768, 1440];
const ROUTES = [
  '#/setup/1', '#/setup/2', '#/setup/3', '#/setup/4', '#/setup/5',
  '#/', '#/applications', '#/input',
  '#/settings/requirements', '#/settings/about', '#/settings/preferences', '#/settings/honest', '#/settings/answers', '#/settings/limits',
];

const pw = await loadPlaywright();
if (!pw) {
  console.error('Playwright was not found. Set CJA_PLAYWRIGHT_DIR to a folder that contains it.');
  process.exit(2);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-layout-'));
const store = createStore(dir);
seedDemo(store);
const app = createApp({ store, demo: true });
const port = await app.listen(0);
const browser = detectBrowsers()[0];
const b = await pw.chromium.launch({ headless: true, ...(browser ? { executablePath: browser.path } : {}) });
let failures = 0;
for (const width of WIDTHS) {
  const ctx = await b.newContext({ viewport: { width, height: 844 }, hasTouch: width < 800, isMobile: width < 500 });
  const page = await ctx.newPage();
  for (const route of ROUTES) {
    await page.goto(`http://127.0.0.1:${port}/?demo=1${route}`);
    await page.waitForSelector('.main > *', { timeout: 10000 });
    await page.waitForTimeout(250);
    const r = await page.evaluate((cfgWidth) => {
      const sw = document.documentElement.scrollWidth;
      const wide = [...document.querySelectorAll('.main *, .side *')].filter((el) => {
        const rc = el.getBoundingClientRect();
        return rc.width > 0 && rc.right > cfgWidth + 1 && !el.closest('.table-wrap, .nav, .log, .subnav, .seg-wrap');
      }).slice(0, 3).map((el) => el.tagName + '.' + el.className);
      const start = [...document.querySelectorAll('button')].find((x) => /Start applying/.test(x.textContent));
      const sr = start?.getBoundingClientRect();
      return { sw, layoutW: window.innerWidth, iw: cfgWidth, wide, startCut: sr ? sr.right > cfgWidth + 1 || sr.left < 0 : null };
    }, width);
    const bad = r.sw > r.iw || r.layoutW > r.iw || r.wide.length || r.startCut;
    if (bad) {
      failures++;
      console.log(`FAIL ${width}px ${route}: scrollWidth ${r.sw}, layout viewport ${r.layoutW}, wanted ${r.iw}${r.wide.length ? ' wide: ' + r.wide.join(', ') : ''}${r.startCut ? ' Start button cut off' : ''}`);
    }
  }
  await ctx.close();
  console.log(`checked ${ROUTES.length} routes at ${width}px`);
}
await b.close();
await app.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `${failures} failing page(s)` : 'No horizontal overflow at any width.');
process.exit(failures ? 1 : 0);

// Finds Playwright for the dev tools (record_demo, check_layout). Playwright is NOT a dependency of this project.
// Looks for `import 'playwright'`, a folder in CJA_PLAYWRIGHT_DIR, or the global npm root.
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

export async function loadPlaywright() {
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

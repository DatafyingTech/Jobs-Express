// The unattended daily run (node server.mjs --scheduled-run). No UI, no questions asked.
//
//   preflight  ->  lock  ->  make sure Chrome and the extension are up  ->  fresh-only agents  ->  digest
//
// If any prerequisite is missing it writes a "failed" digest that says what to fix, and exits non-zero.
// Every outside effect (Claude, Chrome, sleeping) is injectable so the whole flow is testable with fakes.
import { ROOT, listApplications, listHeld } from './store.mjs';
import { loadProfile, profileGaps } from './profile.mjs';
import {
  runPreflight, loadState, testChromeConnection, isBrowserRunning, openInBrowser, connectionHint, connectionMessage, LINKEDIN_URL,
} from './preflight.mjs';
import { acquireLock, lockHolder, describeHolder } from './lock.mjs';
import { loadSchedule, saveSchedule, buildDigest, writeDigest, describeDays, formatTime12 } from './schedule.mjs';
import { planAgents, buildPrompt } from './prompts.mjs';
import { Runner } from './runner.mjs';

export const EXIT = { ok: 0, failed: 1, skipped: 3 };
export const TEST_LIMITS = { maxApps: 3, maxMinutes: 30 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function defaultDeps() {
  return {
    preflight: (store) => runPreflight(store, { cwd: ROOT }),
    browserRunning: () => isBrowserRunning(),
    startBrowser: () => openInBrowser(LINKEDIN_URL, { allow: [LINKEDIN_URL] }),
    testConnection: () => testChromeConnection({ cwd: ROOT }),
    sleep,
    now: () => new Date(),
  };
}

/** Turn the saved schedule into what this particular run will do. A test run is always Practice and small. */
export function effectiveOptions(schedule, { test = false } = {}) {
  const live = schedule.mode === 'live' && schedule.liveAccepted === true && !test;
  return {
    mode: live ? 'live' : 'practice',
    agents: schedule.agents,
    maxApps: test ? Math.min(schedule.maxApps, TEST_LIMITS.maxApps) : schedule.maxApps,
    freshHours: schedule.freshHours,
    maxMinutes: test ? Math.min(schedule.maxMinutes, TEST_LIMITS.maxMinutes) : schedule.maxMinutes,
    test,
  };
}

const FIX = {
  claude: 'Claude Code is not installed. Open Jobs Express, go to Settings, Requirements, and press "Install Claude Code".',
  auth: 'Claude Code is not signed in with a claude.ai plan. Open Jobs Express, go to Settings, Requirements, and press "Sign in to Claude".',
  browser: 'Install Google Chrome or Microsoft Edge, then open Jobs Express and press Re-check under Settings, Requirements.',
  setup: 'Open Jobs Express and finish the setup wizard. The scheduled run needs the same profile as a manual run.',
  linkedin: 'Open Jobs Express, go to Settings, Requirements, sign in to LinkedIn in Chrome yourself, and tick "I am signed in to LinkedIn". Or turn LinkedIn off in Job preferences.',
  live: 'Open Jobs Express, go to Settings, Daily schedule, and either switch to Practice or tick the box that accepts automatic submissions, then save.',
  noSchedule: 'Open Jobs Express, go to Settings, Daily schedule, choose a time and press Save schedule.',
};

/** What would stop this run from starting? Returns [{ what, hint }]. */
export function findBlockers({ rows = [], profile, schedule, state, options }) {
  const out = [];
  const row = (id) => rows.find((r) => r.id === id);
  const gaps = profileGaps(profile);
  if (gaps.length) out.push({ what: `Setup is not finished (still missing ${gaps.join(', ')}).`, hint: FIX.setup });
  const claude = row('claude');
  if (claude && claude.status === 'fail') out.push({ what: claude.summary, hint: FIX.claude });
  const auth = row('auth');
  if (auth && auth.status === 'fail' && claude?.status === 'ok') out.push({ what: auth.summary, hint: `${FIX.auth} ${auth.hint || ''}`.trim() });
  const browser = row('browser');
  if (browser && browser.status === 'fail') out.push({ what: browser.summary, hint: FIX.browser });
  if (profile.prefs.sources.linkedin && !state.linkedinConfirmed) out.push({ what: 'LinkedIn sign-in has not been confirmed.', hint: FIX.linkedin });
  if (schedule.mode === 'live' && !schedule.liveAccepted && !options.test) out.push({ what: 'The schedule is set to Live without the acceptance box ticked.', hint: FIX.live });
  return out;
}

function lockState(store) {
  const holder = lockHolder(store);
  return holder ? { free: false, holder } : { free: true, holder: null };
}

/** What a run would do, without launching anything. Used by --dry-run and the "Run a test now" preview. */
export async function planScheduledRun({ store, test = false, deps: d = {} } = {}) {
  const deps = { ...defaultDeps(), ...d };
  const schedule = loadSchedule(store);
  const options = effectiveOptions(schedule, { test });
  const profile = loadProfile(store);
  const state = loadState(store);
  const pf = await deps.preflight(store);
  const blockers = findBlockers({ rows: pf.rows || [], profile, schedule, state, options });
  if (!schedule.savedAt && !test) blockers.unshift({ what: 'No daily schedule has been saved.', hint: FIX.noSchedule });
  const lock = lockState(store);
  if (!lock.free) blockers.push({ what: `${describeHolder(lock.holder)} is running right now.`, hint: 'The scheduled run skips itself while another run is active. Wait for it to finish.' });
  const plans = planAgents(profile, { agents: options.agents, limit: options.maxApps });
  const prompts = plans.map((p) => buildPrompt({ profile, mode: options.mode, plan: p, variant: 'fresh-only', freshHours: options.freshHours }));
  const lines = [
    `Scheduled run${test ? ' (test)' : ''}, dry run. Nothing is launched.`,
    `Schedule: ${describeDays(schedule.days)} at ${formatTime12(schedule.time)}${schedule.savedAt ? '' : ' (not saved yet, using defaults)'}.`,
    `Mode: ${options.mode === 'live' ? 'Live. Applications are submitted.' : 'Practice. Forms are filled but never submitted.'}${test && schedule.mode === 'live' ? ' (a test run is always Practice)' : ''}`,
    `Agents: ${options.agents}. Up to ${options.maxApps} applications. Only roles posted in the last ${options.freshHours} hours. Time cap ${options.maxMinutes} minutes.`,
    ...(pf.rows || []).filter((r) => ['claude', 'auth', 'browser'].includes(r.id)).map((r) => `${r.title}: ${r.status === 'ok' ? 'ok' : r.status}. ${r.summary}`),
    `LinkedIn sign-in confirmed: ${state.linkedinConfirmed ? 'yes' : 'no'}${profile.prefs.sources.linkedin ? '' : ' (LinkedIn is off)'}.`,
    `Another run active: ${lock.free ? 'no' : describeHolder(lock.holder)}.`,
    'It would: make sure Chrome is running (starting it if not), test the Claude extension connection, then start the agents with fresh-only prompts.',
    ...prompts.map((p, i) => `Agent ${i + 1} prompt: ${p.length.toLocaleString('en-US')} characters, sources ${plans[i].sources.join(', ') || 'none'}.`),
    blockers.length ? `It would NOT start right now: ${blockers.map((b) => b.what).join(' ')}` : 'Nothing blocks it. It would start.',
  ];
  return { ok: blockers.length === 0, options, schedule: { time: schedule.time, days: schedule.days, saved: !!schedule.savedAt }, blockers, lines, agents: plans.map((p, i) => ({ number: p.number, limit: p.limit, sources: p.sources, promptChars: prompts[i].length })) };
}

function countsAndItems(store, runId) {
  const rows = listApplications(store).filter((r) => r.run === runId);
  const counts = { submitted: 0, ready: 0, held: 0, skipped: 0 };
  for (const r of rows) counts[r.status] += 1;
  const items = rows.map((r) => ({ status: r.status, company: r.company, role: r.role, pay: r.pay, source: r.source, url: r.url, note: r.note }));
  const held = listHeld(store).filter((h) => h.run === runId).map((h) => ({ company: h.company, role: h.role, url: h.url, question: h.question }));
  return { counts, items, held };
}

/**
 * Do the run. Returns { exitCode, status, digest, digestName }.
 * @param {object} o
 * @param {object} o.store
 * @param {boolean} [o.test]   a Practice-only, small run started from the app
 * @param {object} [o.runner]  reuse an existing Runner (the app's own, so its live log works)
 * @param {function} [o.log]   receives plain progress lines
 */
export async function runScheduled({ store, test = false, runner = null, log = () => {}, deps: d = {} } = {}) {
  const deps = { ...defaultDeps(), ...d };
  const startedAt = deps.now().toISOString();
  const schedule = loadSchedule(store);
  const options = effectiveOptions(schedule, { test });
  const profile = loadProfile(store);
  const state = loadState(store);

  let lock = null;
  let runId = '';
  const finish = (status, extra = {}) => {
    const finishedAt = deps.now().toISOString();
    const { counts, items, held } = runId ? countsAndItems(store, runId) : { counts: {}, items: [], held: [] };
    const digest = buildDigest({
      startedAt, finishedAt, status, mode: options.mode, test, agents: options.agents, maxApps: options.maxApps, freshHours: options.freshHours,
      counts, items, held, runId, error: extra.error || '', hint: extra.hint || '',
    });
    const written = writeDigest(store, digest);
    const lastRun = {
      startedAt, finishedAt, status, test,
      submitted: digest.counts.submitted, ready: digest.counts.ready, held: digest.counts.held, skipped: digest.counts.skipped,
      error: extra.error || '', digest: written.name,
    };
    // A run that stepped aside because something else was running did not happen: it must not replace the real last result.
    saveSchedule(store, status === 'skipped' ? { lastSkipped: { at: finishedAt, error: extra.error || '' } } : { lastRun });
    lock?.release();
    log(status === 'failed' || status === 'skipped' ? `${status === 'failed' ? 'Did not run' : 'Skipped'}: ${extra.error}` : `Digest written: ${written.name}`);
    return { exitCode: status === 'failed' ? EXIT.failed : status === 'skipped' ? EXIT.skipped : EXIT.ok, status, digest, digestName: written.name };
  };
  const fail = (error, hint) => finish('failed', { error, hint });

  try {
    if (!schedule.savedAt && !test) return fail('No daily schedule has been saved.', FIX.noSchedule);

    // 1. Take the lock first, so nothing else starts while we check things.
    const got = acquireLock(store, test ? 'test' : 'scheduled');
    if (!got.ok) {
      return finish('skipped', { error: `${describeHolder(got.holder)} was already running.`, hint: 'Nothing to do. The next scheduled run will go ahead as normal.' });
    }
    lock = got;

    // 2. Cheap checks.
    log('Checking Claude Code, sign-in and your setup...');
    const pf = await deps.preflight(store);
    const blockers = findBlockers({ rows: pf.rows || [], profile, schedule, state, options });
    if (blockers.length) return fail(blockers.map((b) => b.what).join(' '), blockers.map((b) => b.hint).join(' '));

    // 3. Chrome and the extension.
    if (!(await deps.browserRunning())) {
      log('Chrome is not running. Starting it...');
      try { deps.startBrowser(); } catch (e) { return fail(`Could not start the browser: ${e.message}`, FIX.browser); }
      for (let i = 0; i < 20 && !(await deps.browserRunning()); i++) await deps.sleep(2000);
    }
    let conn = { ok: false, reason: 'no-answer' };
    for (let attempt = 1; attempt <= 3 && !conn.ok; attempt++) {
      log(`Testing the Claude in Chrome connection (attempt ${attempt} of 3)...`);
      conn = await deps.testConnection();
      if (!conn.ok && attempt < 3) await deps.sleep(20_000);
    }
    if (!conn.ok) return fail(`Chrome is open but the Claude extension did not answer. ${connectionMessage(conn.reason)}`, connectionHint(conn.reason));

    // 4. The agents.
    const theRunner = runner || new Runner({ store });
    const onLog = (e) => log(`[${e.agent ? 'agent ' + e.agent : 'run'}] ${e.text}`);
    theRunner.on('log', onLog);
    const ended = new Promise((resolve) => {
      const onRun = (s) => { if (s.status && s.status !== 'running') { theRunner.off('run', onRun); resolve(s); } };
      theRunner.on('run', onRun);
    });
    let snap;
    try {
      snap = theRunner.start({
        profile, mode: options.mode, agents: options.agents, limit: options.maxApps, task: 'search',
        maxMinutes: options.maxMinutes, variant: 'fresh-only', freshHours: options.freshHours, lock,
      });
    } catch (e) {
      theRunner.off('log', onLog);
      return fail(`The agents could not start: ${e.message}`, 'Open Jobs Express, go to Settings, Requirements, and check each row.');
    }
    runId = snap.id;
    log(`Run ${runId} started: ${options.mode} mode, ${options.agents} agent(s), up to ${options.maxApps}, fresh within ${options.freshHours}h, cap ${options.maxMinutes} min.`);
    const end = await ended;
    theRunner.off('log', onLog);
    if (end.status === 'failed') {
      const lastErr = theRunner.recent(50).reverse().find((l) => l.kind === 'error');
      return finish('failed', { error: lastErr ? lastErr.text : 'Every agent failed to start or exited with an error.', hint: 'Open the run log in the data folder (runs/' + runId + '/run.log), or press "Run a test now" in Settings, Daily schedule, to see it live.' });
    }
    return finish(end.status === 'stopped' ? 'stopped' : 'finished', { error: end.status === 'stopped' ? end.reason : '' });
  } catch (e) {
    return fail(`Unexpected error: ${e.message}`, 'Run "node server.mjs --scheduled-run --dry-run" in a terminal to see what is wrong.');
  }
}

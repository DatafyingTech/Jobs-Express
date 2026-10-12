// The daily schedule: validation, next-run arithmetic, and the digests a scheduled run leaves behind.
// Everything here is pure or file-only. Talking to the operating system lives in scheduler.mjs.
import fs from 'node:fs';

export const SCHEDULE_FILE = 'schedule.json';
export const DIGEST_DIR = 'digests';
export const TASK_NAME = 'JobsExpressDaily';

export const LIMITS = {
  agents: { min: 1, max: 3, def: 1 },
  maxApps: { min: 1, max: 25, def: 10 },
  freshHours: { min: 1, max: 168, def: 30 },
  maxMinutes: { min: 10, max: 240, def: 90 },
};

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DAYS = ['daily', 'weekdays'];
export const LIVE_ACCEPT_TEXT = 'I have reviewed Practice results and accept that applications will be submitted automatically';

export function defaultSchedule() {
  return {
    enabled: false,
    time: '04:10',
    days: 'daily',
    mode: 'practice',
    liveAccepted: false,
    agents: LIMITS.agents.def,
    maxApps: LIMITS.maxApps.def,
    freshHours: LIMITS.freshHours.def,
    maxMinutes: LIMITS.maxMinutes.def,
    lastRun: null,
    lastSkipped: null,
    savedAt: null,
  };
}

const intIn = (v, { min, max, def }) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

/** Strictly validate what the person typed. Returns { ok, value, errors }. Nothing is clamped silently. */
export function validateSchedule(input = {}) {
  const errors = [];
  const v = defaultSchedule();
  const time = String(input.time ?? '').trim();
  if (!TIME_RE.test(time)) errors.push('Pick a time of day, like 04:10.');
  else v.time = time;

  const days = String(input.days ?? 'daily');
  if (!DAYS.includes(days)) errors.push('Days must be every day or weekdays.');
  else v.days = days;

  const mode = String(input.mode ?? 'practice');
  if (mode !== 'practice' && mode !== 'live') errors.push('Mode must be Practice or Live.');
  else v.mode = mode;
  if (v.mode === 'live') {
    if (input.liveAccepted !== true) errors.push('Live mode needs the box ticked that says you have reviewed Practice results and accept automatic submissions.');
    else v.liveAccepted = true;
  }

  for (const [key, label] of [['agents', 'Agents'], ['maxApps', 'Applications per run'], ['freshHours', 'Freshness window'], ['maxMinutes', 'Time cap']]) {
    const spec = LIMITS[key];
    const raw = input[key];
    if (raw === undefined || raw === '' || raw === null) { v[key] = spec.def; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) errors.push(`${label} must be a whole number from ${spec.min} to ${spec.max}.`);
    else v[key] = n;
  }
  return { ok: errors.length === 0, value: v, errors };
}

export function loadSchedule(store) {
  const saved = store.readJson(SCHEDULE_FILE, null);
  const base = defaultSchedule();
  if (!saved || typeof saved !== 'object') return base;
  const out = {
    ...base,
    enabled: saved.enabled === true,
    time: TIME_RE.test(String(saved.time)) ? saved.time : base.time,
    days: DAYS.includes(saved.days) ? saved.days : base.days,
    mode: saved.mode === 'live' ? 'live' : 'practice',
    agents: intIn(saved.agents, LIMITS.agents),
    maxApps: intIn(saved.maxApps, LIMITS.maxApps),
    freshHours: intIn(saved.freshHours, LIMITS.freshHours),
    maxMinutes: intIn(saved.maxMinutes, LIMITS.maxMinutes),
    lastRun: saved.lastRun && typeof saved.lastRun === 'object' ? saved.lastRun : null,
    lastSkipped: saved.lastSkipped && typeof saved.lastSkipped === 'object' ? saved.lastSkipped : null,
    savedAt: typeof saved.savedAt === 'string' ? saved.savedAt : null,
  };
  // A Live schedule without a recorded acceptance is treated as Practice. Nothing submits by accident.
  out.liveAccepted = out.mode === 'live' && saved.liveAccepted === true;
  if (out.mode === 'live' && !out.liveAccepted) out.mode = 'practice';
  return out;
}

export function saveSchedule(store, patch) {
  const next = { ...loadSchedule(store), ...patch };
  store.writeJson(SCHEDULE_FILE, next);
  return next;
}

// --- when does it run next ----------------------------------------------------------------

/** The next local date-time strictly after `now` that matches the schedule. */
export function nextRunAt(schedule, now = new Date()) {
  const [hh, mm] = String(schedule.time).split(':').map(Number);
  for (let add = 0; add < 9; add++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, hh, mm, 0, 0);
    const dow = d.getDay();
    if (schedule.days === 'weekdays' && (dow === 0 || dow === 6)) continue;
    if (d.getTime() > now.getTime()) return d;
  }
  return null;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatTime12(time) {
  const [h, m] = String(time).split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "tomorrow 4:10 AM", "today 9:00 PM", "Monday 4:10 AM". */
export function describeNextRun(date, now = new Date()) {
  if (!date) return '';
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000);
  const word = days === 0 ? 'today' : days === 1 ? 'tomorrow' : WEEKDAY[date.getDay()];
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${word} ${formatTime12(hhmm)}`;
}

export function describeDays(days) {
  return days === 'weekdays' ? 'Monday to Friday' : 'every day';
}

/** One plain line for the dashboard. */
export function describeLastRun(lastRun) {
  if (!lastRun) return '';
  const bits = [];
  if (lastRun.submitted) bits.push(`${lastRun.submitted} submitted`);
  if (lastRun.ready) bits.push(`${lastRun.ready} ready to review`);
  if (lastRun.held) bits.push(`${lastRun.held} held`);
  if (lastRun.status === 'failed') return `Last run did not start: ${lastRun.error || 'see the digest'}`;
  if (lastRun.status === 'skipped') return `Last run was skipped: ${lastRun.error || 'another run was in progress'}`;
  if (!bits.length) return 'Last run: nothing new matched';
  return `Last run: ${bits.join(', ')}`;
}

/** What the dashboard and Settings show, computed in one place. */
export function scheduleSummary(schedule, now = new Date()) {
  const next = schedule.enabled ? nextRunAt(schedule, now) : null;
  return {
    enabled: schedule.enabled,
    time: schedule.time,
    days: schedule.days,
    mode: schedule.mode,
    nextRunAt: next ? next.toISOString() : null,
    nextRunText: next ? describeNextRun(next, now) : '',
    lastRun: schedule.lastRun,
    lastRunText: describeLastRun(schedule.lastRun),
  };
}

// --- digests ------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
export const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const DIGEST_NAME_RE = /^\d{4}-\d{2}-\d{2}(-\d{1,2})?$/;

export function buildDigest({ startedAt, finishedAt, status, mode, test = false, agents = 0, maxApps = 0, freshHours = 0, counts = {}, items = [], held = [], error = '', hint = '', runId = '' }) {
  const c = { submitted: 0, ready: 0, held: 0, skipped: 0, ...counts };
  return {
    version: 1,
    startedAt, finishedAt, status, mode, test, runId,
    agents, maxApps, freshHours,
    counts: c,
    items: items.slice(0, 200),
    held: held.slice(0, 100),
    error, hint,
  };
}

export function digestMarkdown(d) {
  const when = new Date(d.startedAt);
  const title = Number.isNaN(when.getTime()) ? 'Daily digest' : `Jobs Express daily digest, ${WEEKDAY[when.getDay()]} ${localDate(when)}`;
  const L = [`# ${title}`, ''];
  const label = { finished: 'Finished', stopped: 'Stopped early at a time or action cap', failed: 'Did not run', skipped: 'Skipped' }[d.status] || d.status;
  L.push(`**${label}.** ${d.test ? 'Test run. ' : ''}${d.mode === 'live' ? 'Live mode' : 'Practice mode'}, ${d.agents} agent${d.agents === 1 ? '' : 's'}, roles posted in the last ${d.freshHours} hours, up to ${d.maxApps} applications.`, '');
  if (d.status === 'failed' || d.status === 'skipped') {
    L.push(`What happened: ${d.error || 'unknown'}`, '');
    if (d.hint) L.push(`How to fix it: ${d.hint}`, '');
    return L.join('\n') + '\n';
  }
  const c = d.counts;
  L.push(`${c.submitted} submitted, ${c.ready} ready to review, ${c.held} held, ${c.skipped} skipped.`, '');
  const section = (heading, status) => {
    const rows = d.items.filter((i) => i.status === status);
    if (!rows.length) return;
    L.push(`## ${heading}`, '');
    for (const r of rows) {
      const bits = [r.role, r.pay && r.pay !== 'not listed' ? r.pay : '', r.source].filter(Boolean).join(' · ');
      L.push(`- **${r.company}**${bits ? `, ${bits}` : ''}${r.url ? ` (${r.url})` : ''}${r.note ? ` Note: ${r.note}` : ''}`);
    }
    L.push('');
  };
  section('Submitted', 'submitted');
  section('Ready to review', 'ready');
  if (d.held.length) {
    L.push('## Needs you', '');
    for (const h of d.held) {
      L.push(`- **${h.company}**${h.role ? `, ${h.role}` : ''}: ${h.question}${h.url ? ` (${h.url})` : ''}`);
    }
    L.push('');
  }
  section('Skipped', 'skipped');
  if (d.error) L.push(`Notes: ${d.error}`, '');
  return L.join('\n') + '\n';
}

/** Write data/digests/YYYY-MM-DD.md and .json. A second run on the same day gets -2, -3 and so on. */
export function writeDigest(store, digest) {
  const date = localDate(new Date(digest.startedAt));
  store.ensure();
  fs.mkdirSync(store.resolve(DIGEST_DIR), { recursive: true });
  let name = date;
  for (let n = 2; fs.existsSync(store.resolve(DIGEST_DIR, `${name}.json`)); n++) name = `${date}-${n}`;
  store.writeJson(`${DIGEST_DIR}/${name}.json`, digest);
  fs.writeFileSync(store.resolve(DIGEST_DIR, `${name}.md`), digestMarkdown(digest), 'utf8');
  return { name, json: store.resolve(DIGEST_DIR, `${name}.json`), markdown: store.resolve(DIGEST_DIR, `${name}.md`) };
}

export function listDigests(store, limit = 14) {
  let files = [];
  try {
    files = fs.readdirSync(store.resolve(DIGEST_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const names = files.map((f) => f.slice(0, -5)).filter((n) => DIGEST_NAME_RE.test(n)).sort().reverse().slice(0, limit);
  return names.map((name) => {
    const d = store.readJson(`${DIGEST_DIR}/${name}.json`, null);
    if (!d) return null;
    return { name, startedAt: d.startedAt, finishedAt: d.finishedAt, status: d.status, mode: d.mode, test: !!d.test, counts: d.counts, error: d.error || '' };
  }).filter(Boolean);
}

export function readDigest(store, name) {
  if (!DIGEST_NAME_RE.test(String(name))) return null;
  const json = store.readJson(`${DIGEST_DIR}/${name}.json`, null);
  if (!json) return null;
  let markdown = '';
  try {
    markdown = fs.readFileSync(store.resolve(DIGEST_DIR, `${name}.md`), 'utf8');
  } catch {
    markdown = digestMarkdown(json);
  }
  return { name, digest: json, markdown };
}

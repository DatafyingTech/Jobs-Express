// Builds the prompt each agent receives: shared rules + a template per source + the person's
// profile and preferences + a mode block (Practice stops before the final Submit).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.mjs';

const AGENTS_DIR = path.join(ROOT, 'agents');
export const LOG_CMD = 'node tools/log.mjs';

const SOURCE_TEMPLATES = {
  linkedin: 'linkedin-easy-apply',
  ats: 'ats-boards',
  aggregators: 'aggregators',
};
export const SOURCE_LABELS = {
  linkedin: 'LinkedIn Easy Apply',
  ats: 'Company job boards',
  aggregators: 'Job aggregators',
};

const cache = new Map();
export function loadTemplate(name, dir = AGENTS_DIR) {
  const key = dir + '|' + name;
  if (!cache.has(key)) cache.set(key, fs.readFileSync(path.join(dir, `${name}.md`), 'utf8').replace(/\r\n/g, '\n').trim());
  return cache.get(key);
}

/** Replace {{NAME}} placeholders in a single pass. Replacement text is never re-scanned. */
export function fill(template, vars) {
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
}

export function findUnfilled(text) {
  return [...String(text).matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
}

/** A mode file is a set of "## NAME" sections. */
export function parseSections(md) {
  const out = {};
  let key = null;
  for (const line of md.split('\n')) {
    const m = /^##\s+([A-Z0-9_]+)\s*$/.exec(line);
    if (m) {
      key = m[1];
      out[key] = [];
    } else if (key) out[key].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

export function modeSections(mode, dir) {
  return parseSections(loadTemplate(mode === 'live' ? 'mode-live' : 'mode-practice', dir));
}

// --- agent planning --------------------------------------------------------------------------

export function enabledSources(profile) {
  const s = profile.prefs?.sources || {};
  const list = Object.keys(SOURCE_TEMPLATES).filter((k) => s[k]);
  return list.length ? list : ['linkedin'];
}

export function allTitles(profile) {
  return [...(profile.prefs?.customTitles || []), ...(profile.prefs?.categories || [])];
}

export function splitLimit(total, count) {
  const n = Math.max(1, count);
  const base = Math.floor(total / n);
  const extra = total % n;
  return Array.from({ length: n }, (_, i) => Math.max(1, base + (i < extra ? 1 : 0)));
}

/** Decide what each agent works on. */
export function planAgents(profile, { agents = 1, limit, task = 'search', held = [] } = {}) {
  const count = Math.min(3, Math.max(1, Number(agents) || 1));
  if (task === 'held') {
    // Held items are shared out round-robin.
    const n = Math.min(count, Math.max(1, held.length));
    return Array.from({ length: n }, (_, i) => {
      const mine = held.filter((_item, j) => j % n === i);
      return { number: i + 1, count: n, task: 'held', sources: [], titles: [], limit: mine.length || 1, held: mine };
    });
  }
  const total = Math.max(1, Number(limit) || profile.prefs?.perRun || 10);
  const sources = enabledSources(profile);
  const titles = allTitles(profile);
  const limits = splitLimit(total, count);
  return limits.map((lim, i) => {
    let mySources = sources;
    let myTitles = titles;
    if (sources.length >= count) {
      mySources = sources.filter((_, j) => j % count === i);
    } else if (titles.length >= count) {
      myTitles = titles.filter((_, j) => j % count === i);
    }
    return { number: i + 1, count, task: 'search', sources: mySources, titles: myTitles, limit: lim, held: [] };
  });
}

// --- profile rendering -----------------------------------------------------------------------

const line = (label, value) => (value && String(value).trim() ? `- ${label}: ${String(value).trim()}` : null);
const block = (title, lines) => {
  const body = lines.filter(Boolean).join('\n');
  return body ? `### ${title}\n${body}` : '';
};

function money(n, period) {
  if (n === '' || n == null) return '';
  return `${Number(n).toLocaleString('en-US')} per ${period === 'hour' ? 'hour' : 'year'}`;
}

export function renderProfile(profile) {
  const a = profile.about || {};
  const e = profile.eeo || {};
  const h = profile.honest || {};
  const where = [a.city, a.state, a.country].filter(Boolean).join(', ');
  const parts = [
    block('Contact and form defaults', [
      line('Full name', a.fullName),
      line('Email', a.email),
      line('Phone', a.phone),
      line('Location', where),
      line('Work authorization', a.workAuth),
      line('Work authorization notes', a.workAuthNote),
      line('LinkedIn', a.linkedin),
      line('Other links', a.links),
      line('Resume file (upload exactly this path)', a.resumePath),
    ]),
    block('Demographic (EEO) defaults, only used when a form asks', [
      line('Gender', e.gender),
      line('Race / ethnicity', e.raceEthnicity),
      line('Veteran status', e.veteran),
      line('Disability status', e.disability),
    ]),
    block('Honest profile: the facts you may claim', [
      line('Years of experience', h.yearsExperience),
      line('Summary', h.summary),
      line('Job titles held', h.titles),
      line('Skills', h.skills),
      line('Tools and technologies', h.tools),
      line('Certifications held (and no others)', h.certifications),
      line('Education (exactly as stated; do not upgrade it)', h.education),
    ]),
    block('NEVER claim any of these', [h.neverClaim && h.neverClaim.trim() ? h.neverClaim.trim() : null]),
  ];
  return parts.filter(Boolean).join('\n\n');
}

export function renderQa(profile) {
  const qa = profile.qa || [];
  if (!qa.length) return '_No saved answers yet. Anything not covered by the profile above must be held._';
  return qa.map((x) => `- Q: ${x.q}\n  A: ${x.a}`).join('\n');
}

export function renderPreferences(profile, plan) {
  const p = profile.prefs || {};
  const titles = plan?.titles?.length ? plan.titles : allTitles(profile);
  return [
    line('Roles to look for', titles.join('; ') || 'any role that matches the honest profile'),
    line('Seniority', (p.seniority || []).join(', ')),
    line('Work mode', (p.workModes || []).join(', ')),
    line('Locations', p.locations),
    line('Pay floor (skip roles whose listed pay is clearly below this)', money(p.payFloor, p.payPeriod)),
    line('Ideal pay (prefer roles at or above this)', money(p.payIdeal, p.payPeriod)),
    line('Exclude these companies', p.excludeCompanies),
    line('Exclude postings mentioning', p.excludeKeywords),
  ]
    .filter(Boolean)
    .join('\n');
}

function renderHeld(items) {
  if (!items?.length) return '_Nothing is on hold._';
  return items
    .map((h, i) => `${i + 1}. ${h.company}${h.role ? ` - ${h.role}` : ''}\n   URL: ${h.url || '(none recorded)'}\n   Was held because: ${h.question}${h.answer ? `\n   The person answered: ${h.answer}` : ''}`)
    .join('\n');
}

// --- the builder -----------------------------------------------------------------------------

/**
 * Compose a complete prompt for one agent.
 * opts: { profile, mode: 'practice'|'live', plan (from planAgents) }
 */
export function buildPrompt({ profile, mode = 'practice', plan, dir } = {}) {
  if (!profile) throw new Error('profile is required');
  const p = plan || planAgents(profile, { agents: 1 })[0];
  const modeKey = mode === 'live' ? 'live' : 'practice';
  const sec = modeSections(modeKey, dir);

  const vars = {
    LOG_CMD,
    AGENT_NUMBER: p.number,
    AGENT_COUNT: p.count,
    LIMIT: p.limit,
    LIMIT_UNIT: modeKey === 'practice' ? 'practice applications (filled in but never submitted)' : 'submitted applications',
    MODE_FINISH_LINKEDIN: sec.FINISH_LINKEDIN,
    MODE_FINISH_ATS: sec.FINISH_ATS,
    HELD_LIST: renderHeld(p.held),
  };

  const templates = ['rules'];
  if (p.task === 'held') {
    templates.push('held');
  } else {
    const names = new Set();
    for (const s of p.sources) {
      names.add(SOURCE_TEMPLATES[s]);
      if (s === 'aggregators') names.add(SOURCE_TEMPLATES.ats);
    }
    templates.push(...names);
  }

  const templated = [sec.BANNER, ...templates.map((t) => loadTemplate(t, dir))].map((t) => fill(t, vars)).join('\n\n---\n\n');

  const shared =
    p.count > 1
      ? `${p.count} agents are working at the same time in the same Chrome. Stay in your own tabs, and use the duplicate check before every application, because the other agents are recording theirs as they go.`
      : 'You are the only agent running. Still use your own tabs and close them when you finish.';

  const assignment = [
    '# Your assignment',
    '',
    p.task === 'held'
      ? `Finish the held applications listed in the task section. Aim for up to ${p.limit}.`
      : `Sources for this run: ${p.sources.map((s) => SOURCE_LABELS[s]).join(', ')}.`,
    shared,
    modeKey === 'practice'
      ? 'Remember: this is a practice run. Do not press the final Submit on any application.'
      : 'This is a live run. Each submission is real.',
  ].join('\n');

  const person = [
    '# The person you are applying for',
    '',
    renderProfile(profile),
    '',
    '### Job preferences',
    renderPreferences(profile, p),
    '',
    '### Saved answers (use these verbatim when the same question appears)',
    renderQa(profile),
    '',
    'Anything a required question asks that is not covered above must be held, not guessed.',
  ].join('\n');

  const kickoff =
    p.task === 'held'
      ? 'Begin now with the first held application. When every item is done, give your final report.'
      : 'Begin now. Start with the duplicate check on any role you consider, work steadily, and give your final report when you reach your target or run out of good matches.';

  return [templated, assignment, person, kickoff].join('\n\n---\n\n') + '\n';
}

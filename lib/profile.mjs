// The profile is the single source of truth the agents may claim facts from.
// It is saved to data/profile.json on this machine and is never uploaded by this app.
import fs from 'node:fs';
import path from 'node:path';
import { FILES } from './store.mjs';

export const PROFILE_VERSION = 1;

export const CATEGORY_OPTIONS = [
  'IT support / helpdesk',
  'Systems & network admin',
  'Cybersecurity',
  'Software engineering',
  'Data & analytics',
  'DevOps / cloud',
  'Customer success / support',
  'Product / project management',
  'Sales / account management',
  'Marketing / content',
  'Design / UX',
  'Operations / admin',
  'Finance / accounting',
  'HR / recruiting',
  'Healthcare (non-clinical)',
  'Education / training',
];

export const SENIORITY_OPTIONS = ['Entry level', 'Mid level', 'Senior', 'Lead / staff', 'Manager', 'Director+'];
export const WORK_MODES = ['Remote', 'Hybrid', 'On-site'];
export const SOURCE_KEYS = ['linkedin', 'ats', 'aggregators'];
export const WORK_AUTH_OPTIONS = [
  'Authorized to work in my country; no sponsorship needed',
  'Authorized now; will need sponsorship later',
  'Not authorized without sponsorship',
];
export const EEO_DEFAULT = 'Prefer not to say';

export function defaultProfile() {
  return {
    version: PROFILE_VERSION,
    setupComplete: false,
    about: {
      fullName: '',
      email: '',
      phone: '',
      city: '',
      state: '',
      country: '',
      workAuth: WORK_AUTH_OPTIONS[0],
      workAuthNote: '',
      linkedin: '',
      links: '',
      resumePath: '',
      resumeName: '',
    },
    eeo: {
      gender: EEO_DEFAULT,
      raceEthnicity: EEO_DEFAULT,
      veteran: EEO_DEFAULT,
      disability: EEO_DEFAULT,
    },
    prefs: {
      categories: [],
      customTitles: [],
      seniority: [],
      workModes: ['Remote'],
      locations: '',
      payFloor: '',
      payIdeal: '',
      payPeriod: 'year',
      excludeCompanies: '',
      excludeKeywords: '',
      perRun: 10,
      sources: { linkedin: true, ats: true, aggregators: false },
    },
    honest: {
      yearsExperience: '',
      summary: '',
      titles: '',
      skills: '',
      tools: '',
      certifications: '',
      education: '',
      neverClaim: '',
    },
    qa: [],
    settings: {
      mode: 'practice',
      agents: 1,
      maxMinutes: 45,
      maxTurns: 200,
    },
  };
}

// --- tiny schema-driven sanitiser -----------------------------------------------------------

const S = (max = 300) => ({ t: 's', max });
const N = (min, max) => ({ t: 'n', min, max });
const A = (max = 60, item = 120) => ({ t: 'a', max, item });
const E = (...vals) => ({ t: 'e', vals });

const SCHEMA = {
  setupComplete: { t: 'b' },
  about: {
    fullName: S(120), email: S(200), phone: S(60), city: S(100), state: S(100), country: S(100),
    workAuth: S(200), workAuthNote: S(600), linkedin: S(300), links: S(1200),
    resumePath: S(1000), resumeName: S(300),
  },
  eeo: { gender: S(120), raceEthnicity: S(160), veteran: S(120), disability: S(120) },
  prefs: {
    categories: A(40, 80), customTitles: A(40, 120), seniority: A(10, 40), workModes: A(5, 20),
    locations: S(600), payFloor: N(0, 10_000_000), payIdeal: N(0, 10_000_000), payPeriod: E('year', 'hour'),
    excludeCompanies: S(2000), excludeKeywords: S(2000), perRun: N(1, 100),
    sources: { linkedin: { t: 'b' }, ats: { t: 'b' }, aggregators: { t: 'b' } },
  },
  honest: {
    yearsExperience: S(60), summary: S(3000), titles: S(4000), skills: S(4000), tools: S(4000),
    certifications: S(3000), education: S(1500), neverClaim: S(3000),
  },
  settings: { mode: E('practice', 'live'), agents: N(1, 3), maxMinutes: N(5, 240), maxTurns: N(20, 1000) },
};

function sanitizeValue(spec, value, fallback) {
  switch (spec.t) {
    case 's':
      if (value == null) return fallback;
      return String(value).replace(/\r\n/g, '\n').slice(0, spec.max).trim();
    case 'n': {
      if (value === '' || value == null) return typeof fallback === 'number' ? fallback : '';
      const n = Number(String(value).replace(/[, $]/g, ''));
      if (!Number.isFinite(n)) return fallback;
      return Math.min(spec.max, Math.max(spec.min, Math.round(n)));
    }
    case 'b':
      return typeof value === 'boolean' ? value : fallback;
    case 'e':
      return spec.vals.includes(value) ? value : fallback;
    case 'a': {
      if (!Array.isArray(value)) return fallback;
      const seen = new Set();
      const out = [];
      for (const v of value) {
        const s = String(v ?? '').trim().slice(0, spec.item);
        if (s && !seen.has(s.toLowerCase())) {
          seen.add(s.toLowerCase());
          out.push(s);
        }
        if (out.length >= spec.max) break;
      }
      return out;
    }
    default:
      return fallback;
  }
}

function sanitizeSection(schema, input, base) {
  const out = {};
  for (const [key, spec] of Object.entries(schema)) {
    const provided = input && typeof input === 'object' ? input[key] : undefined;
    if (spec.t) {
      out[key] = provided === undefined ? base[key] : sanitizeValue(spec, provided, base[key]);
    } else {
      out[key] = sanitizeSection(spec, provided, base[key] ?? {});
    }
  }
  return out;
}

export function sanitizeQa(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const q = String(item?.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const a = String(item?.a ?? '').trim().slice(0, 2000);
    if (!q || !a) continue;
    out.push({ q, a, at: typeof item.at === 'string' ? item.at.slice(0, 40) : new Date().toISOString() });
    if (out.length >= 300) break;
  }
  return out;
}

/**
 * Merge a (possibly partial) profile from the UI over a base profile and return a clean copy.
 * Unknown keys are dropped. Sections not mentioned keep their previous values.
 */
export function normalizeProfile(input, base = defaultProfile()) {
  const out = { version: PROFILE_VERSION };
  const merged = sanitizeSection(SCHEMA, input || {}, base);
  Object.assign(out, merged);
  out.qa = input && Array.isArray(input.qa) ? sanitizeQa(input.qa) : sanitizeQa(base.qa);
  return out;
}

export function loadProfile(store) {
  const saved = store.readJson(FILES.profile, null);
  if (!saved) return defaultProfile();
  return normalizeProfile(saved, defaultProfile());
}

export function saveProfile(store, patch) {
  const current = loadProfile(store);
  const next = normalizeProfile(patch, current);
  // The resume path is only ever set by the upload endpoint, never by free-form input.
  next.about.resumePath = current.about.resumePath;
  next.about.resumeName = current.about.resumeName;
  store.writeJson(FILES.profile, next);
  return next;
}

export function addQa(store, question, answer) {
  const current = loadProfile(store);
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  const a = String(answer || '').trim();
  if (!q || !a) throw new Error('Both a question and an answer are needed.');
  const key = q.toLowerCase();
  const rest = current.qa.filter((x) => x.q.toLowerCase() !== key);
  rest.push({ q: q.slice(0, 500), a: a.slice(0, 2000), at: new Date().toISOString() });
  current.qa = rest;
  store.writeJson(FILES.profile, current);
  return current;
}

const ALLOWED_RESUME = new Set(['.pdf', '.docx', '.doc']);
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** Copy an uploaded resume into data/resume and remember where it went. */
export function saveResume(store, originalName, buffer) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (!ALLOWED_RESUME.has(ext)) throw new Error('Please choose a PDF or Word (.docx) file.');
  if (!buffer || !buffer.length) throw new Error('That file is empty.');
  if (buffer.length > MAX_RESUME_BYTES) throw new Error('That file is larger than 10 MB.');
  const stem = path
    .basename(String(originalName), ext)
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'resume';
  store.ensure();
  const dir = store.resolve(FILES.resume);
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  const target = store.resolve(FILES.resume, stem + ext);
  fs.writeFileSync(target, buffer);
  const current = loadProfile(store);
  current.about.resumePath = target;
  current.about.resumeName = stem + ext;
  store.writeJson(FILES.profile, current);
  return current;
}

/** What is still missing before a run makes sense. */
export function profileGaps(profile) {
  const gaps = [];
  if (!profile.about.fullName) gaps.push('your name');
  if (!profile.about.email) gaps.push('your email');
  if (!profile.about.phone) gaps.push('your phone number');
  if (!profile.about.resumePath) gaps.push('a resume file');
  if (!profile.prefs.categories.length && !profile.prefs.customTitles.length) gaps.push('at least one job category or title');
  if (!profile.honest.skills && !profile.honest.titles && !profile.honest.summary) gaps.push('some facts in your honest profile');
  return gaps;
}

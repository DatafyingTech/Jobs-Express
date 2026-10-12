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
      workHistory: '',
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
const S1 = (max = 300) => ({ t: 's', max, one: true }); // one line: newlines collapse to spaces
const N = (min, max, dec = 0) => ({ t: 'n', min, max, dec });
const A = (max = 60, item = 120) => ({ t: 'a', max, item });
const E = (...vals) => ({ t: 'e', vals });

const SCHEMA = {
  setupComplete: { t: 'b' },
  about: {
    fullName: S1(120), email: S1(200), phone: S1(60), city: S1(100), state: S1(100), country: S1(100),
    workAuth: S1(200), workAuthNote: S(600), linkedin: S1(300), links: S(1200),
    resumePath: S1(1000), resumeName: S1(300),
  },
  eeo: { gender: S1(120), raceEthnicity: S1(160), veteran: S1(120), disability: S1(120) },
  prefs: {
    categories: A(40, 80), customTitles: A(40, 120), seniority: A(10, 40), workModes: A(5, 20),
    locations: S(600), payFloor: N(0, 10_000_000, 2), payIdeal: N(0, 10_000_000, 2), payPeriod: E('year', 'hour'),
    excludeCompanies: S(2000), excludeKeywords: S(2000), perRun: N(1, 100),
    sources: { linkedin: { t: 'b' }, ats: { t: 'b' }, aggregators: { t: 'b' } },
  },
  honest: {
    yearsExperience: S1(60), summary: S(3000), workHistory: S(6000), titles: S(4000), skills: S(4000), tools: S(4000),
    certifications: S(3000), education: S(1500), neverClaim: S(3000),
  },
  settings: { mode: E('practice', 'live'), agents: N(1, 3), maxMinutes: N(5, 240), maxTurns: N(20, 1000) },
};

function sanitizeValue(spec, value, fallback) {
  switch (spec.t) {
    case 's': {
      if (value == null) return fallback;
      // Only text goes into a text field. An object or array would otherwise be saved as "[object Object]".
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return fallback;
      // eslint-disable-next-line no-control-regex
      const s = String(value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085]/g, '');
      return (spec.one ? s.replace(/[\s\u2028\u2029]+/g, ' ') : s).slice(0, spec.max).trim();
    }
    case 'n': {
      if (value === '' || value == null) return typeof fallback === 'number' ? fallback : '';
      const n = Number(String(value).replace(/[, $]/g, ''));
      if (!Number.isFinite(n)) return fallback;
      const f = 10 ** (spec.dec || 0);
      return Math.min(spec.max, Math.max(spec.min, Math.round(n * f) / f));
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

export const MAX_QA = 300;

export function sanitizeQa(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const q = String(item?.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    // eslint-disable-next-line no-control-regex
    const a = String(item?.a ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085]/g, '').trim().slice(0, 2000);
    if (!q || !a) continue;
    out.push({ q, a, at: typeof item.at === 'string' ? item.at.slice(0, 40) : new Date().toISOString() });
  }
  // Keep the newest. When the list is full the oldest answers are the ones to go.
  return out.slice(-MAX_QA);
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
  // A profile that cannot be parsed is set aside (profile.json.corrupt-...) instead of being silently replaced.
  const saved = store.readJson(FILES.profile, null, { quarantine: true });
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaultProfile();
  const p = normalizeProfile(saved, defaultProfile());
  // The resume is remembered by name and found inside this data folder, so copying the folder to a new place keeps working.
  const name = p.about.resumeName;
  const found = name ? safeResumePath(store, name) : '';
  p.about.resumePath = found;
  if (name && !found) p.about.resumeName = '';
  return p;
}

function safeResumePath(store, name) {
  try {
    const target = store.resolve(FILES.resume, path.basename(name));
    return fs.lstatSync(target).isFile() ? target : '';
  } catch {
    return '';
  }
}

/** Plain-language problems with the saved data that the person should know about. Never blocks anything. */
export function profileWarnings(store, profile) {
  const out = [];
  for (const n of store.notes || []) out.push(n);
  for (const r of store.recovered) out.push({ id: 'recovered', text: `${r.file} could not be read, so setup started over. The old file was kept as ${r.savedAs} in your data folder.` });
  const raw = store.readJson(FILES.profile, null);
  if (raw?.about?.resumeName && !profile.about.resumePath) out.push({ id: 'resume', text: `Your resume file ${raw.about.resumeName} is not in the data folder any more (was the folder copied without its resume subfolder?). Upload it again in About you.` });
  const a = profile.about;
  if (a.email && !EMAIL_RE.test(a.email)) out.push({ id: 'email', text: 'Your email address does not look right.' });
  if (a.phone && !PHONE_RE.test(a.phone)) out.push({ id: 'phone', text: 'Your phone number does not look right.' });
  return out;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PHONE_RE = /^(?=(?:\D*\d){7,15}\D*$)[+()\d\s.\-x#/]+$/i;

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
  current.qa = rest.slice(-MAX_QA); // the oldest answer makes room for the newest
  store.writeJson(FILES.profile, current);
  return current;
}

/** Remove one saved answer by its question text. */
export function removeQa(store, question) {
  const current = loadProfile(store);
  const key = String(question || '').replace(/\s+/g, ' ').trim().toLowerCase();
  current.qa = current.qa.filter((x) => x.q.toLowerCase() !== key);
  store.writeJson(FILES.profile, current);
  return current;
}

const ALLOWED_RESUME = new Set(['.pdf', '.docx', '.doc']);
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** Does the start of the file look like what its extension says? Stops an .exe renamed to .pdf. */
export function looksLikeResume(ext, buf) {
  if (ext === '.pdf') return buf.subarray(0, 1024).includes('%PDF-');
  if (ext === '.docx') return buf[0] === 0x50 && buf[1] === 0x4b; // a zip container
  // .doc: the old Office container, or a Word file saved as rich text
  return (buf[0] === 0xd0 && buf[1] === 0xcf) || buf.subarray(0, 5).toString('latin1') === '{\\rtf';
}

/** Copy an uploaded resume into data/resume and remember where it went. */
export function saveResume(store, originalName, buffer) {
  const raw = String(originalName || '');
  const ext = path.extname(raw).toLowerCase();
  if (!ALLOWED_RESUME.has(ext)) throw new Error('Please choose a PDF or Word (.docx) file.');
  if (!buffer || !buffer.length) throw new Error('That file is empty.');
  if (buffer.length > MAX_RESUME_BYTES) throw new Error('That file is larger than 10 MB.');
  if (!looksLikeResume(ext, buffer)) {
    throw new Error(`That file does not look like a real ${ext.slice(1).toUpperCase()}. Please choose your resume again.`);
  }
  const stem = path
    .basename(raw)
    .replace(/\.[^.]*$/, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._\- ]+/gu, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80) || 'resume';
  store.ensure();
  const dir = store.resolve(FILES.resume);
  // Never follow a link out of the data folder: if resume/ was swapped for a shortcut, refuse rather than delete elsewhere.
  if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) throw new Error('The resume folder inside your data folder is a link, so nothing was saved. Delete that link and try again.');
  const target = store.resolve(FILES.resume, stem + ext);
  const current = loadProfile(store);
  const previous = current.about.resumeName;
  // Write the new file first; only then remove the old one.
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer, { mode: 0o600 });
  fs.renameSync(tmp, target);
  if (previous && previous !== stem + ext) {
    try {
      const old = safeResumePath(store, previous);
      if (old) fs.rmSync(old, { force: true });
    } catch { /* an old copy left behind is harmless */ }
  }
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

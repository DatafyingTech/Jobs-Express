// Shared client state and a tiny event bus. Views subscribe with on() and are cleaned up on navigation.
import { GET, POST, PUT } from './api.js';

export const S = {
  info: null,          // /api/state
  draft: null,         // editable copy of the profile (wizard + settings)
  dirty: false,
  preflight: null,
  preflightLoading: false,
  testing: false,
  apps: [],
  appCounts: { all: 0, submitted: 0, ready: 0, held: 0, skipped: 0 },
  held: [],
  retryable: 0,
  run: { status: 'idle' },
  log: [],
  connected: true,
  loaded: false,
};

const target = new EventTarget();
let subs = [];

export function emit(name, detail) {
  target.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Subscribe for the lifetime of the current view. */
export function on(name, fn) {
  const wrapped = (e) => fn(e.detail);
  target.addEventListener(name, wrapped);
  subs.push(() => target.removeEventListener(name, wrapped));
}

export function clearSubs() {
  subs.forEach((off) => off());
  subs = [];
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

export function resetDraft() {
  S.draft = clone(S.info.profile);
  S.dirty = false;
}

export async function loadInfo() {
  S.info = await GET('/api/state');
  S.run = S.info.run;
  S.appCounts = S.info.counts;
  S.retryable = S.info.retryable;
  if (!S.draft || !S.dirty) resetDraft();
  emit('info');
}

export async function loadApps() {
  const r = await GET('/api/applications');
  S.apps = r.rows;
  S.appCounts = r.counts;
  emit('apps');
}

export async function loadHeld() {
  const r = await GET('/api/held');
  S.held = r.items;
  S.retryable = r.retryable;
  emit('held');
}

export async function loadPreflight() {
  S.preflightLoading = true;
  emit('preflight');
  try {
    S.preflight = await GET('/api/preflight');
  } finally {
    S.preflightLoading = false;
    emit('preflight');
  }
}

export async function testConnection() {
  S.testing = true;
  emit('preflight');
  try {
    const r = await POST('/api/preflight/test-connection');
    S.preflight = r.preflight;
    return r.result;
  } finally {
    S.testing = false;
    emit('preflight');
  }
}

export async function confirmLinkedin(confirmed) {
  S.preflight = await POST('/api/preflight/linkedin', { confirmed });
  emit('preflight');
}

export async function saveDraft({ complete } = {}) {
  const payload = clone(S.draft);
  if (complete) payload.setupComplete = true;
  const saved = await PUT('/api/profile', payload);
  S.info.profile = saved;
  S.draft = clone(saved);
  S.dirty = false;
  await loadInfo();
  emit('saved');
  return saved;
}

export function markDirty() {
  if (!S.dirty) {
    S.dirty = true;
    emit('dirty');
  }
}

/** Reasons the Start button should not be pressed yet. Each item: { text, href? } */
export function blockers() {
  if (!S.info || S.info.demo) return [];
  const out = [];
  const gaps = S.info.gaps;
  if (gaps.length) out.push({ text: `Finish setup: still missing ${gaps.join(', ')}.`, href: '#/setup/2', link: 'Open setup' });
  const rows = S.preflight?.rows || [];
  for (const r of rows) {
    if (r.status === 'fail') out.push({ text: `${r.title}: ${r.summary}`, href: '#/settings/requirements', link: 'See how to fix' });
  }
  const ext = rows.find((r) => r.id === 'extension');
  if (ext && ext.status === 'pending') out.push({ text: 'Test the Claude in Chrome connection once.', href: '#/settings/requirements', link: 'Test it' });
  const li = rows.find((r) => r.id === 'linkedin');
  if (S.info.profile.prefs.sources.linkedin && li && li.status !== 'ok') {
    out.push({ text: 'Confirm you are signed in to LinkedIn.', href: '#/settings/requirements', link: 'Confirm' });
  }
  return out;
}

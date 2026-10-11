// Pure helpers (no browser APIs), so they can be tested in Node.
// Only the fields that were edited in this tab are sent when saving, so another tab (or an answer saved in the
// meantime) is never overwritten with this tab's stale copy of the profile.
export const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const SKIP = new Set(['qa', 'about.resumePath', 'about.resumeName']);

export function diffProfile(base, next, prefix = '') {
  const out = {};
  for (const key of Object.keys(next || {})) {
    const path = prefix + key;
    if (SKIP.has(path)) continue;
    const a = base?.[key];
    const b = next[key];
    if (isPlain(b)) {
      const inner = diffProfile(isPlain(a) ? a : {}, b, path + '.');
      if (Object.keys(inner).length) out[key] = inner;
    } else if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = b;
  }
  return out;
}

export function applyChanges(target, changes) {
  for (const [k, v] of Object.entries(changes || {})) {
    if (isPlain(v)) applyChanges((target[k] = isPlain(target[k]) ? target[k] : {}), v);
    else target[k] = v;
  }
}

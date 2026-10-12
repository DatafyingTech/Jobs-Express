// One run at a time. A small lock file in the data folder keeps a scheduled run, a manual run
// and a second scheduled run from driving the same Chrome at once, even across separate processes.
//
// The lock file is created complete (the content is written to a private temp file first and then hard-linked into
// place), so a competing process never sees a half-written lock. Taking over an abandoned lock goes through a
// short-lived guard file, so that exactly one process wins when several notice the same dead lock at once.
import fs from 'node:fs';
import crypto from 'node:crypto';

export const LOCK_FILE = 'run.lock';
export const GUARD_FILE = 'run.lock.takeover';
/** A lock older than this is treated as abandoned even if its PID is still alive (PIDs get reused). */
export const MAX_LOCK_AGE_MS = 12 * 60 * 60 * 1000;
/** An empty or unreadable lock younger than this is somebody in the middle of taking it, so it counts as held. */
export const UNREADABLE_GRACE_MS = 2000;
const GUARD_STALE_MS = 5000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** What is on disk right now: { exists, lock (parsed or null), ageMs }. */
export function inspectLock(store) {
  const file = store.resolve(LOCK_FILE);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { exists: false, lock: null, ageMs: 0 };
  }
  let lock = null;
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8'));
    lock = l && typeof l === 'object' ? l : null;
  } catch {
    lock = null;
  }
  return { exists: true, lock, ageMs: Math.max(0, Date.now() - st.mtimeMs) };
}

export function readLock(store) {
  return inspectLock(store).lock;
}

/** Is this lock abandoned? `info` is the result of inspectLock. */
export function lockIsStale(info, { now = Date.now(), alive = pidAlive } = {}) {
  if (!info || !info.exists) return true;
  if (!info.lock) return info.ageMs > UNREADABLE_GRACE_MS;
  const started = Date.parse(info.lock.startedAt);
  if (Number.isFinite(started) && now - started > MAX_LOCK_AGE_MS) return true;
  return !alive(info.lock.pid);
}

/** Is a live run holding the lock right now? */
export function lockHolder(store, opts) {
  const info = inspectLock(store);
  if (lockIsStale(info, opts)) return null;
  return info.lock || { pid: 0, kind: 'manual' };
}

function tryLink(tmp, file) {
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (['EPERM', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP', 'ENOTSUP'].includes(e.code)) {
      // A file system without hard links (FAT, some network shares): fall back to an exclusive create.
      try {
        fs.copyFileSync(tmp, file, fs.constants.COPYFILE_EXCL);
        return true;
      } catch (e2) {
        if (e2.code === 'EEXIST') return false;
        throw e2;
      }
    }
    throw e;
  }
}

/**
 * Try to take the lock. Returns { ok: true, release() } or { ok: false, holder }.
 * kind: 'manual' | 'scheduled' | 'test'
 */
export function acquireLock(store, kind = 'manual', { pid = process.pid, alive } = {}) {
  store.ensure();
  const file = store.resolve(LOCK_FILE);
  const guard = store.resolve(GUARD_FILE);
  const tmp = `${file}.${pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, kind, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const won = () => ({
    ok: true,
    release() {
      const now = readLock(store);
      if (now && now.pid === pid) fs.rmSync(file, { force: true });
    },
  });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (tryLink(tmp, file)) return won();
      const info = inspectLock(store);
      if (!lockIsStale(info, { alive })) return { ok: false, holder: info.lock || { pid: 0, kind: 'manual' } };
      // The lock looks abandoned. Only the process holding the takeover guard may remove it.
      let have = false;
      try {
        fs.writeFileSync(guard, String(pid), { flag: 'wx', mode: 0o600 });
        have = true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.rmSync(guard, { force: true });
        } catch { /* it just went away */ }
        // Somebody else is already sorting this out. Treat the lock as taken.
        return { ok: false, holder: info.lock || { pid: 0, kind: 'manual' } };
      }
      try {
        // Look again under the guard: the lock may have been replaced by a live one since we looked.
        if (lockIsStale(inspectLock(store), { alive })) fs.rmSync(file, { force: true });
        if (tryLink(tmp, file)) return won();
      } finally {
        if (have) fs.rmSync(guard, { force: true });
      }
    }
    return { ok: false, holder: readLock(store) };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function describeHolder(holder) {
  if (!holder) return 'another run';
  return holder.kind === 'scheduled' ? 'the scheduled daily run' : holder.kind === 'test' ? 'a schedule test run' : 'a run started from the app';
}

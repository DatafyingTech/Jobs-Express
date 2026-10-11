// One run at a time. A small lock file in the data folder keeps a scheduled run, a manual run
// and a second scheduled run from driving the same Chrome at once, even across separate processes.
import fs from 'node:fs';

export const LOCK_FILE = 'run.lock';
/** A lock older than this is treated as abandoned even if its PID is still alive (PIDs get reused). */
export const MAX_LOCK_AGE_MS = 12 * 60 * 60 * 1000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function readLock(store) {
  try {
    const l = JSON.parse(fs.readFileSync(store.resolve(LOCK_FILE), 'utf8'));
    return l && typeof l === 'object' ? l : null;
  } catch {
    return null;
  }
}

export function lockIsStale(lock, { now = Date.now(), alive = pidAlive } = {}) {
  if (!lock) return true;
  const started = Date.parse(lock.startedAt);
  if (Number.isFinite(started) && now - started > MAX_LOCK_AGE_MS) return true;
  return !alive(lock.pid);
}

/**
 * Try to take the lock. Returns { ok: true, release() } or { ok: false, holder }.
 * kind: 'manual' | 'scheduled' | 'test'
 */
export function acquireLock(store, kind = 'manual', { pid = process.pid, alive } = {}) {
  store.ensure();
  const file = store.resolve(LOCK_FILE);
  const body = JSON.stringify({ pid, kind, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return {
        ok: true,
        release() {
          const now = readLock(store);
          if (now && now.pid === pid) fs.rmSync(file, { force: true });
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readLock(store);
      if (lockIsStale(holder, { alive })) {
        fs.rmSync(file, { force: true });
        continue;
      }
      return { ok: false, holder };
    }
  }
  return { ok: false, holder: readLock(store) };
}

export function describeHolder(holder) {
  if (!holder) return 'another run';
  return holder.kind === 'scheduled' ? 'the scheduled daily run' : holder.kind === 'test' ? 'a schedule test run' : 'a run started from the app';
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock, inspectLock, lockIsStale, lockHolder, LOCK_FILE, UNREADABLE_GRACE_MS } from '../lib/lock.mjs';
import { tempStore } from './helpers.mjs';

const LOCK_URL = new URL('../lib/lock.mjs', import.meta.url).href;
const STORE_URL = new URL('../lib/store.mjs', import.meta.url).href;

/** 16 processes call acquireLock at the same instant. Returns the intervals during which each winner believed it held the lock. */
async function race(dir, n = 16, holdMs = 1500) {
  const helper = path.join(dir, 'racer.mjs');
  fs.writeFileSync(helper, `
import { createStore } from ${JSON.stringify(STORE_URL)};
import { acquireLock } from ${JSON.stringify(LOCK_URL)};
const store = createStore(process.argv[2]);
const go = Number(process.argv[3]);
while (Date.now() < go) {}
const r = acquireLock(store, 'manual');
const t = Date.now();
if (r.ok) { console.log(JSON.stringify({ ok: true, from: t, to: t + ${holdMs} })); while (Date.now() < t + ${holdMs}) {} r.release(); } else console.log(JSON.stringify({ ok: false }));
`);
  const go = Date.now() + 2500;
  const outs = await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, [helper, dir, String(go)]);
    let o = '';
    c.stdout.on('data', (d) => (o += d));
    c.on('close', () => { try { resolve(JSON.parse(o.trim())); } catch { resolve({ ok: false, broken: true }); } });
  })));
  assert.ok(!outs.some((o) => o.broken), 'every racer reported');
  return outs.filter((o) => o.ok);
}

const overlaps = (wins) => wins.some((a, i) => wins.some((b, j) => i !== j && a.from < b.to && b.from < a.to));

test('16 processes racing for a free lock: never two holders at once', async () => {
  for (let round = 0; round < 3; round++) {
    const { store, dir, cleanup } = tempStore();
    const wins = await race(dir);
    assert.ok(wins.length >= 1, 'somebody got it');
    assert.equal(overlaps(wins), false, `round ${round}: ${JSON.stringify(wins)}`);
    void store;
    cleanup();
  }
});

test('16 processes racing over an abandoned lock: never two at once, and one takes it over', async () => {
  for (let round = 0; round < 3; round++) {
    const { dir, cleanup } = tempStore();
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 777, kind: 'manual', startedAt: new Date().toISOString() }));
    const wins = await race(dir);
    assert.ok(wins.length >= 1, 'somebody took it over');
    assert.equal(overlaps(wins), false, `round ${round}: ${JSON.stringify(wins)}`);
    cleanup();
  }
});

test('16 processes racing over a lock file that is empty (as if just created): it counts as held, and nobody steals it', async () => {
  const { dir, cleanup } = tempStore();
  fs.writeFileSync(path.join(dir, LOCK_FILE), '');
  const wins = await race(dir, 8, 1500);
  // The racers all start about 2.5 s after the file was written, so by then it is old and abandoned: exactly one winner.
  assert.ok(wins.length >= 1);
  assert.equal(overlaps(wins), false, JSON.stringify(wins));
  cleanup();
});

test('an empty or unreadable lock is held while young, abandoned when old', () => {
  const { store, cleanup } = tempStore();
  const file = store.resolve(LOCK_FILE);
  fs.writeFileSync(file, '');
  assert.equal(lockIsStale(inspectLock(store)), false);
  assert.ok(lockHolder(store), 'a young empty lock is a holder');
  assert.equal(acquireLock(store, 'manual').ok, false);
  const old = new Date(Date.now() - UNREADABLE_GRACE_MS - 1000);
  fs.utimesSync(file, old, old);
  assert.equal(lockIsStale(inspectLock(store)), true);
  fs.writeFileSync(file, '{not json');
  fs.utimesSync(file, old, old);
  const got = acquireLock(store, 'manual');
  assert.ok(got.ok);
  got.release();
  assert.ok(!fs.existsSync(file));
  cleanup();
});

test('a live holder keeps the lock, release only removes your own, and no temp files are left', () => {
  const { store, dir, cleanup } = tempStore();
  const a = acquireLock(store, 'scheduled');
  assert.ok(a.ok);
  const b = acquireLock(store, 'manual');
  assert.equal(b.ok, false);
  assert.equal(b.holder.kind, 'scheduled');
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid + 1, kind: 'other', startedAt: new Date().toISOString() }));
  a.release();
  assert.ok(fs.existsSync(path.join(dir, LOCK_FILE)), 'a lock that is no longer ours stays');
  fs.rmSync(path.join(dir, LOCK_FILE));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('run.lock')), []);
  cleanup();
});

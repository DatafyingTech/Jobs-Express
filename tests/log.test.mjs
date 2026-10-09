import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { run, parseArgs } from '../tools/log.mjs';
import { listApplications, listHeld, listRetryable, resolveHeld, FILES, toCsv } from '../lib/store.mjs';
import { tempStore } from './helpers.mjs';
import { ROOT } from '../lib/store.mjs';

test('applied appends one valid JSON line', () => {
  const { store, cleanup } = tempStore();
  const r = run(['applied', '--company', 'Brightwell Systems', '--role', 'Support Engineer', '--pay', '$90k', '--url', 'https://example.com/j/1', '--note', 'ok'], store, {});
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).ok, true);
  const lines = fs.readFileSync(store.resolve(FILES.applications), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.status, 'submitted');
  assert.equal(rec.company, 'Brightwell Systems');
  assert.match(rec.ts, /^\d{4}-\d\d-\d\dT/);
  cleanup();
});

test('ready, skipped and held map to the right statuses', () => {
  const { store, cleanup } = tempStore();
  run(['ready', '--company', 'A Co', '--role', 'R'], store, {});
  run(['skipped', '--company', 'B Co', '--note', 'pay below floor'], store, {});
  const h = run(['held', '--company', 'C Co', '--role', 'R', '--question', "Do you have a driver's license?"], store, {});
  assert.equal(h.code, 0);
  const rows = Object.fromEntries(listApplications(store).map((r) => [r.company, r.status]));
  assert.deepEqual(rows, { 'A Co': 'ready', 'B Co': 'skipped', 'C Co': 'held' });
  const held = listHeld(store);
  assert.equal(held.length, 1);
  assert.equal(held[0].open, true);
  assert.match(held[0].question, /driver/);
  cleanup();
});

test('malformed calls are rejected and nothing is written', () => {
  const { store, cleanup } = tempStore();
  const bad = [
    [],
    ['applied'],
    ['applied', '--role', 'No company'],
    ['applied', '--company'],
    ['applied', '--company', 'X', '--bogus', 'y'],
    ['applied', 'stray'],
    ['applied', '--company', 'X', '--url', 'javascript:alert(1)'],
    ['held', '--company', 'X'],
    ['frobnicate', '--company', 'X'],
  ];
  for (const argv of bad) {
    const r = run(argv, store, {});
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(JSON.parse(r.out).ok, false);
  }
  assert.equal(fs.existsSync(store.resolve(FILES.applications)), false);
  cleanup();
});

test('control characters and huge values are cleaned up', () => {
  const { store, cleanup } = tempStore();
  run(['applied', '--company', 'Evil\u0007\nCo', '--note', 'x'.repeat(5000)], store, {});
  const [rec] = listApplications(store);
  assert.equal(rec.company, 'Evil Co');
  assert.ok(rec.note.length <= 1000);
  cleanup();
});

test('check finds duplicates by company and by url', () => {
  const { store, cleanup } = tempStore();
  run(['applied', '--company', 'Acme, Inc.', '--role', 'Support', '--url', 'https://example.com/j/9?src=a'], store, {});
  assert.equal(JSON.parse(run(['check', '--company', 'ACME'], store, {}).out).duplicate, true);
  assert.equal(JSON.parse(run(['check', '--company', 'Other Co', '--url', 'https://example.com/j/9?src=b'], store, {}).out).duplicate, true);
  assert.equal(JSON.parse(run(['check', '--company', 'Other Co'], store, {}).out).duplicate, false);
  run(['skipped', '--company', 'Skipped Co'], store, {});
  assert.equal(JSON.parse(run(['check', '--company', 'Skipped Co'], store, {}).out).duplicate, false, 'only submitted or ready count');
  cleanup();
});

test('the latest entry for a posting wins, and held postings become retryable once answered', () => {
  const { store, cleanup } = tempStore();
  const url = 'https://example.com/j/5';
  run(['held', '--company', 'Marlow', '--role', 'Tech', '--url', url, '--question', 'Driver license?'], store, {});
  assert.equal(listRetryable(store).length, 0, 'not retryable until answered');
  const id = listHeld(store)[0].id;
  resolveHeld(store, id, { answer: 'Yes' });
  assert.equal(listHeld(store)[0].open, false);
  assert.equal(listRetryable(store).length, 1);
  run(['applied', '--company', 'Marlow', '--role', 'Tech', '--url', url], store, {});
  assert.equal(listApplications(store).length, 1);
  assert.equal(listApplications(store)[0].status, 'submitted');
  assert.equal(listRetryable(store).length, 0, 'finished postings are not retried');
  cleanup();
});

test('parseArgs reports a missing value', () => {
  assert.throws(() => parseArgs(['applied', '--company', '--role', 'x']), /needs a value/);
});

test('the CLI entry point works end to end with CJA_DATA_DIR', () => {
  const { store, dir, cleanup } = tempStore();
  const res = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'log.mjs'), 'ready', '--company', 'CLI Co', '--role', 'Tester'], { env: { ...process.env, CJA_DATA_DIR: dir, CJA_AGENT: 'agent-2' }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).status, 'ready');
  assert.equal(listApplications(store)[0].agent, 'agent-2');
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'log.mjs'), 'applied'], { env: { ...process.env, CJA_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  cleanup();
});

test('CSV export neutralises formulas and quotes commas', () => {
  const csv = toCsv([{ ts: 't', company: '=HYPERLINK("x")', role: 'A, B', pay: '', source: '', status: 'ready', url: '', note: '' }]);
  assert.match(csv, /'=HYPERLINK\(""x""\)/);
  assert.match(csv, /"A, B"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FILES, createStore, normalizeCompany, urlKey, appKey, checkDuplicate, claimPosting, recordApplication, recordHeld, resolveHeld,
  listApplications, listHeld, listRetryable, StoreReadError, withRetry, CLAIM_MINUTES,
} from '../lib/store.mjs';
import { run as logRun } from '../tools/log.mjs';
import { tempStore } from './helpers.mjs';

test('posting keys keep the query that identifies the job and drop tracking noise', () => {
  assert.notEqual(urlKey('https://careers.example.com/jobs?id=111'), urlKey('https://careers.example.com/jobs?id=222'));
  assert.equal(urlKey('https://careers.example.com/jobs?id=111&utm_source=x&trk=abc'), urlKey('https://CAREERS.example.com/jobs/?id=111'));
  assert.equal(urlKey('https://boards.greenhouse.io/acme/jobs/1?gh_jid=1&gh_src=a'), 'boards.greenhouse.io/acme/jobs/1?gh_jid=1&gh_src=a');
  assert.equal(urlKey('http://www.example.com/jobs/1/'), urlKey('https://example.com/jobs/1'), 'http, https and www are the same posting');
  assert.equal(urlKey('https://www.linkedin.com/jobs/view/123/?trackingId=abc&refId=x&lipi=y'), 'linkedin.com/jobs/view/123');
  assert.notEqual(urlKey('https://app.example.com/#/jobs/1'), urlKey('https://app.example.com/#/jobs/2'), 'single-page-app routes in the fragment count');
  assert.equal(urlKey('https://example.com/jobs/1#apply'), urlKey('https://example.com/jobs/1'), 'ordinary anchors do not');
  assert.equal(urlKey('?id=2&a=1'.length ? 'https://x.io/p?b=2&a=1' : ''), urlKey('https://x.io/p?a=1&b=2'), 'parameter order does not matter');
});

test('different postings that differ only by query are not collapsed into one row', () => {
  const { store, cleanup } = tempStore();
  logRun(['applied', '--company', 'QueryCo', '--role', 'Role A', '--url', 'https://careers.queryco.com/jobs?id=111'], store, {});
  logRun(['ready', '--company', 'QueryCo2', '--role', 'Role B', '--url', 'https://careers.queryco.com/jobs?id=222'], store, {});
  assert.equal(listApplications(store).length, 2);
  assert.equal(JSON.parse(logRun(['check', '--company', 'Other', '--url', 'https://careers.queryco.com/jobs?id=333'], store, {}).out).duplicate, false);
  cleanup();
});

test('company names in any alphabet are told apart, and accents are folded', () => {
  assert.notEqual(normalizeCompany('日本電気'), normalizeCompany('富士通'));
  assert.notEqual(normalizeCompany('Co'), normalizeCompany('Corp'));
  assert.notEqual(normalizeCompany('!!!'), normalizeCompany('???'));
  assert.equal(normalizeCompany('Café Müller GmbH'), normalizeCompany('CAFE MULLER'));
  assert.equal(normalizeCompany('Acme, Inc.'), normalizeCompany('ACME LLC'));
  assert.equal(normalizeCompany('Harbor & Pine'), normalizeCompany('harbor and pine'));
  assert.notEqual(normalizeCompany('Café Co'), normalizeCompany('Caf'));
  for (const n of ['Inc', '日本', 'Ünited']) assert.ok(normalizeCompany(n).length > 0, n);
  const { store, cleanup } = tempStore();
  logRun(['applied', '--company', '日本電気', '--role', 'Engineer', '--url', 'https://nec.example/1'], store, {});
  assert.equal(JSON.parse(logRun(['check', '--company', '富士通'], store, {}).out).duplicate, false);
  assert.equal(JSON.parse(logRun(['check', '--company', '日本電気'], store, {}).out).duplicate, true);
  cleanup();
});

test('a Practice row is a duplicate in Practice but not in Live, where it is the one to submit', () => {
  const { store, cleanup } = tempStore();
  logRun(['ready', '--company', 'Beta', '--role', 'Role A', '--url', 'https://beta.example/jobs/1'], store, {});
  const practice = JSON.parse(logRun(['check', '--company', 'beta', '--role', 'ROLE A'], store, { CJA_MODE: 'practice' }).out);
  assert.equal(practice.duplicate, true);
  const live = JSON.parse(logRun(['check', '--company', 'beta', '--role', 'ROLE A'], store, { CJA_MODE: 'live' }).out);
  assert.equal(live.duplicate, false);
  assert.equal(live.status, 'ready');
  assert.match(live.note, /Practice/);
  assert.equal(JSON.parse(logRun(['check', '--company', 'x', '--url', 'https://beta.example/jobs/1'], store, { CJA_MODE: 'live' }).out).duplicate, false);
  // After the real submission the row is submitted and blocks everything.
  logRun(['applied', '--company', 'Beta', '--role', 'Role A', '--url', 'https://beta.example/jobs/1'], store, {});
  assert.equal(JSON.parse(logRun(['check', '--company', 'beta'], store, { CJA_MODE: 'live' }).out).duplicate, true);
  assert.equal(listApplications(store).length, 1, 'the submitted row replaced the ready row');
  cleanup();
});

test('applied twice for the same posting is recorded once', () => {
  const { store, cleanup } = tempStore();
  const first = JSON.parse(logRun(['applied', '--company', 'Gamma', '--role', 'R', '--url', 'https://gamma.example/j/1'], store, {}).out);
  const second = JSON.parse(logRun(['applied', '--company', 'Gamma', '--role', 'R', '--url', 'https://gamma.example/j/1?utm_source=x'], store, {}).out);
  assert.equal(first.status, 'submitted');
  assert.equal(second.duplicate, true);
  assert.equal(second.status, undefined, 'the run counter must not count it again');
  assert.equal(store.readJsonl(FILES.applications).length, 1);
  cleanup();
});

test('check --claim is atomic: the second agent is told the posting is taken', () => {
  const { store, cleanup } = tempStore();
  const a = JSON.parse(logRun(['check', '--claim', '--company', 'RaceCo', '--role', 'Dev', '--url', 'https://race.example/1'], store, { CJA_AGENT: 'agent-1', CJA_RUN: 'r1' }).out);
  assert.equal(a.duplicate, false);
  assert.equal(a.claimed, true);
  const b = JSON.parse(logRun(['check', '--claim', '--company', 'RaceCo', '--role', 'Dev', '--url', 'https://race.example/1'], store, { CJA_AGENT: 'agent-2', CJA_RUN: 'r1' }).out);
  assert.equal(b.duplicate, true);
  assert.match(b.reason, /another agent/);
  const sameRoleOtherUrl = JSON.parse(logRun(['check', '--claim', '--company', 'raceco inc', '--role', 'dev', '--url', 'https://other.example/9'], store, { CJA_AGENT: 'agent-3', CJA_RUN: 'r1' }).out);
  assert.equal(sameRoleOtherUrl.duplicate, true, 'same company and role counts too');
  const again = JSON.parse(logRun(['check', '--claim', '--company', 'RaceCo', '--role', 'Dev', '--url', 'https://race.example/1'], store, { CJA_AGENT: 'agent-1', CJA_RUN: 'r1' }).out);
  assert.equal(again.duplicate, false, 'the same agent may check again right before it submits');
  const different = JSON.parse(logRun(['check', '--claim', '--company', 'RaceCo', '--role', 'Designer', '--url', 'https://race.example/2'], store, { CJA_AGENT: 'agent-2', CJA_RUN: 'r1' }).out);
  assert.equal(different.duplicate, false);
  cleanup();
});

test('claims expire, and 20 concurrent claimers produce exactly one winner', async () => {
  const { store, cleanup } = tempStore();
  claimPosting(store, { company: 'Old', role: 'R', url: 'https://old.example/1' }, { agent: 'agent-1', run: 'r' });
  const rows = store.readJsonl(FILES.claims).map((c) => ({ ...c, expires: Date.now() - 1000 }));
  fs.writeFileSync(store.resolve(FILES.claims), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(claimPosting(store, { company: 'Old', role: 'R', url: 'https://old.example/1' }, { agent: 'agent-2', run: 'r' }).claimed, true, 'an expired claim is free');
  assert.equal(CLAIM_MINUTES, 45);
  const helper = path.join(store.dataDir, 'claim.mjs');
  fs.writeFileSync(helper, `import { createStore, claimPosting } from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
const s = createStore(process.env.CJA_DATA_DIR);
const r = claimPosting(s, { company: 'Contested', role: 'R', url: 'https://c.example/1' }, { agent: process.env.WHO, run: 'r' });
console.log(r.claimed ? 'WON' : 'LOST');`);
  const { spawn } = await import('node:child_process');
  const outputs = await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise((resolve) => {
    const c = spawn(process.execPath, [helper], { env: { ...process.env, CJA_DATA_DIR: store.dataDir, WHO: `agent-${i}` } });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', () => resolve(out.trim()));
  })));
  assert.equal(outputs.filter((o) => o === 'WON').length, 1, outputs.join(','));
  cleanup();
});

test('log.mjs accepts values that start with dashes and the --flag=value form', () => {
  const { store, cleanup } = tempStore();
  const r = JSON.parse(logRun(['skipped', '--company', 'Dash', '--note', '--- pay below floor', '--pay=--'], store, {}).out);
  assert.equal(r.ok, true);
  const row = listApplications(store)[0];
  assert.equal(row.note, '--- pay below floor');
  assert.equal(row.pay, '--');
  assert.equal(JSON.parse(logRun(['skipped', '--company', 'X', '--note'], store, {}).out).ok, false, 'a flag with no value at all is still an error');
  assert.equal(JSON.parse(logRun(['skipped', '--company', 'X', '--note', '--role', 'R'], store, {}).out).ok, false, 'another known flag is not a value');
  cleanup();
});

test('long LinkedIn style URLs are kept whole', () => {
  const { store, cleanup } = tempStore();
  const url = 'https://www.linkedin.com/jobs/view/123/?' + 'trackingId=' + 'x'.repeat(1200);
  logRun(['skipped', '--company', 'Long', '--url', url], store, {});
  assert.equal(listApplications(store)[0].url.length, url.length);
  cleanup();
});

test('a torn last line does not swallow the next record', () => {
  const { store, cleanup } = tempStore();
  fs.writeFileSync(store.resolve(FILES.applications), '{"id":"a_1","ts":"2026-01-01T00:00:00Z","status":"submitted","company":"Before","role":"x"}\n{"id":"a_2","ts":"2026-01-01","status":"submitted","comp');
  logRun(['applied', '--company', 'AfterTornLine', '--role', 'X'], store, {});
  const names = listApplications(store).map((r) => r.company).sort();
  assert.deepEqual(names, ['AfterTornLine', 'Before']);
  cleanup();
});

test('a UTF-8 byte order mark does not hide the first record', () => {
  const { store, cleanup } = tempStore();
  fs.writeFileSync(store.resolve(FILES.applications), '﻿' + JSON.stringify({ id: 'a_1', ts: 't', status: 'ready', company: 'Bom Co', role: 'r' }) + '\n');
  assert.equal(listApplications(store).length, 1);
  fs.writeFileSync(store.resolve(FILES.state), '﻿{"a":1}');
  assert.deepEqual(store.readJson(FILES.state), { a: 1 });
  cleanup();
});

test('a file that exists but cannot be read is an error, never "no data"', () => {
  const { store, cleanup } = tempStore();
  fs.mkdirSync(store.resolve(FILES.applications)); // reading a directory fails with EISDIR
  assert.throws(() => listApplications(store), StoreReadError);
  const out = JSON.parse(logRun(['check', '--company', 'Anyone'], store, {}).out);
  assert.equal(out.ok, false, 'check fails closed instead of saying "not a duplicate"');
  assert.match(out.error, /Could not read applications\.jsonl/);
  assert.equal(store.readJsonl('does-not-exist.jsonl').length, 0, 'a missing file really is empty');
  cleanup();
});

test('withRetry waits out a short lock and gives up on anything else', () => {
  let n = 0;
  assert.equal(withRetry(() => { if (++n < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return 'ok'; }, { tries: 5, base: 1 }), 'ok');
  assert.equal(n, 3);
  let m = 0;
  assert.throws(() => withRetry(() => { m++; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }, { tries: 5, base: 1 }), /nope/);
  assert.equal(m, 1, 'a missing file is not retried');
});

test('a corrupt profile.json is set aside, never silently overwritten', async () => {
  const { store, dir, cleanup } = tempStore();
  const { loadProfile, saveProfile, profileWarnings } = await import('../lib/profile.mjs');
  fs.writeFileSync(store.resolve(FILES.profile), '{"about":{"fullName":"Pat Lee","email":"pat@exa');
  const p = loadProfile(store);
  assert.equal(p.about.fullName, '');
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith('profile.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.match(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), /Pat Lee/);
  assert.match(profileWarnings(store, p)[0].text, /profile\.json could not be read.*profile\.json\.corrupt-/);
  saveProfile(store, { prefs: { perRun: 7 } });
  assert.match(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), /Pat Lee/, 'the copy survives the next save');
  cleanup();
});

test('held questions are de-duplicated, and a dismissed question keeps its posting out of the retry list', () => {
  const { store, cleanup } = tempStore();
  const a = recordHeld(store, { company: 'Marlow', role: 'Tech', url: 'https://m.example/1', question: "Driver's license?" });
  const b = recordHeld(store, { company: 'Marlow', role: 'Tech', url: 'https://m.example/1?utm_source=a', question: "driver's license?" });
  assert.equal(a.id, b.id);
  const c = recordHeld(store, { company: 'Marlow', role: 'Tech', url: 'https://m.example/1', question: 'Drug test?' });
  assert.equal(listHeld(store).length, 2);
  recordApplication(store, { status: 'held', company: 'Marlow', role: 'Tech', url: 'https://m.example/1' });
  resolveHeld(store, a.id, { answer: 'Yes' });
  assert.equal(listRetryable(store).length, 0, 'one question is still open');
  resolveHeld(store, c.id, { dismissed: true });
  assert.equal(listRetryable(store).length, 0, 'the person said not applying to one of them');
  cleanup();
});

test('the same question after it was answered is a new question', () => {
  const { store, cleanup } = tempStore();
  const a = recordHeld(store, { company: 'Z', role: 'R', url: 'https://z.example/1', question: 'Q?' });
  resolveHeld(store, a.id, { answer: 'A' });
  const b = recordHeld(store, { company: 'Z', role: 'R', url: 'https://z.example/1', question: 'Q?' });
  assert.notEqual(a.id, b.id);
  cleanup();
});

test('data files are created private to the owner (POSIX)', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'cja-perm-'));
  const store = createStore(path.join(dir, 'data'));
  store.ensure();
  store.writeJson(FILES.profile, { a: 1 });
  store.appendJsonl(FILES.applications, { a: 1 });
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(store.dataDir), 0o700);
  assert.equal(mode(store.resolve(FILES.profile)), 0o600);
  assert.equal(mode(store.resolve(FILES.applications)), 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appKey falls back to company and role when there is no URL', () => {
  assert.equal(appKey({ company: 'Acme Inc', role: 'Dev' }), appKey({ company: 'ACME', role: 'dev' }));
  assert.notEqual(appKey({ company: 'Acme', role: 'Dev' }), appKey({ company: 'Acme', role: 'Ops' }));
});

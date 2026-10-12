import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, FILES } from '../lib/store.mjs';
import { defaultProfile, loadProfile, saveProfile, saveResume, addQa, normalizeProfile, profileGaps } from '../lib/profile.mjs';
import { tempStore } from './helpers.mjs';

test('a fresh store returns the default profile and saving round-trips', () => {
  const { store, cleanup } = tempStore();
  assert.equal(loadProfile(store).setupComplete, false);
  const saved = saveProfile(store, { about: { fullName: '  Alex Rivera ', email: 'a@example.com' }, prefs: { perRun: '25', payFloor: '$85,000' } });
  assert.equal(saved.about.fullName, 'Alex Rivera');
  assert.equal(saved.prefs.perRun, 25);
  assert.equal(saved.prefs.payFloor, 85000);
  assert.deepEqual(loadProfile(store), saved);
  assert.ok(fs.existsSync(path.join(store.dataDir, 'profile.json')));
  cleanup();
});

test('normalizeProfile drops unknown keys, clamps numbers, and dedupes lists', () => {
  const p = normalizeProfile({ evil: 1, about: { fullName: 'x', nonsense: 'y' }, prefs: { perRun: 9999, categories: ['A', 'a', 'B', ''], payPeriod: 'week' }, settings: { agents: 9, mode: 'yolo' } });
  assert.equal(p.evil, undefined);
  assert.equal(p.about.nonsense, undefined);
  assert.equal(p.prefs.perRun, 100);
  assert.deepEqual(p.prefs.categories, ['A', 'B']);
  assert.equal(p.prefs.payPeriod, 'year');
  assert.equal(p.settings.agents, 3);
  assert.equal(p.settings.mode, 'practice');
});

test('the resume path can only be set by the upload endpoint, never by a profile save', () => {
  const { store, cleanup } = tempStore();
  saveProfile(store, { about: { resumePath: '/etc/passwd', resumeName: 'passwd' } });
  assert.equal(loadProfile(store).about.resumePath, '');
  saveResume(store, 'My Resume (final).pdf', Buffer.from('%PDF-1.4 sample'));
  const p = loadProfile(store);
  assert.ok(p.about.resumePath.startsWith(store.resolve(FILES.resume)));
  assert.match(p.about.resumeName, /^My_Resume_final_?\.pdf$/);
  assert.equal(fs.readFileSync(p.about.resumePath, 'utf8'), '%PDF-1.4 sample');
  cleanup();
});

test('uploads reject the wrong type, empty files and traversal names', () => {
  const { store, dir, cleanup } = tempStore();
  assert.throws(() => saveResume(store, 'run.exe', Buffer.from('x')), /PDF or Word/);
  assert.throws(() => saveResume(store, 'a.pdf', Buffer.alloc(0)), /empty/);
  saveResume(store, '../../../evil.pdf', Buffer.from('%PDF-1.4 x'));
  const written = fs.readdirSync(path.join(dir, 'resume'));
  assert.deepEqual(written, ['evil.pdf']);
  assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'evil.pdf')));
  cleanup();
});

test('the store never writes outside the data directory', () => {
  const { store, dir, cleanup } = tempStore();
  assert.throws(() => store.writeJson('../escape.json', {}), /outside the data folder/);
  assert.throws(() => store.appendJsonl('../../escape.jsonl', {}), /outside the data folder/);
  assert.throws(() => store.resolve('..', 'x'), /outside/);
  assert.throws(() => store.resolve(path.join(os.tmpdir(), 'abs.json')), /outside/);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'escape.json')));
  cleanup();
});

test('saved answers are remembered and replaced, not duplicated', () => {
  const { store, cleanup } = tempStore();
  addQa(store, "Do you have a driver's license?", 'Yes');
  addQa(store, "do you have a driver's license?", 'Yes, valid in Texas');
  const qa = loadProfile(store).qa;
  assert.equal(qa.length, 1);
  assert.equal(qa[0].a, 'Yes, valid in Texas');
  assert.throws(() => addQa(store, 'q', ''), /needed/);
  cleanup();
});

test('profileGaps lists what is missing', () => {
  const gaps = profileGaps(defaultProfile());
  assert.ok(gaps.includes('your name'));
  assert.ok(gaps.includes('a resume file'));
  const p = defaultProfile();
  Object.assign(p.about, { fullName: 'A', email: 'a@b.c', phone: '1', resumePath: '/x' });
  p.prefs.customTitles = ['Tester'];
  p.honest.skills = 'x';
  assert.deepEqual(profileGaps(p), []);
});

test('the data folder is CJA_DATA_DIR, or a folder in your user area outside the app folder', async () => {
  const { resolveDataDir, defaultDataDir, ROOT } = await import('../lib/store.mjs');
  assert.equal(resolveDataDir({ CJA_DATA_DIR: os.tmpdir() }), path.resolve(os.tmpdir()));
  assert.equal(defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\pat\\AppData\\Local' }, { home: 'C:\\Users\\pat', platform: 'win32' }), path.join('C:\\Users\\pat\\AppData\\Local', 'JobsExpress'));
  assert.equal(defaultDataDir({}, { home: '/home/pat', platform: 'linux' }), path.join('/home/pat', '.jobs-express'));
  assert.equal(defaultDataDir({}, { home: '/Users/pat', platform: 'darwin' }), path.join('/Users/pat', '.jobs-express'));
  const dflt = resolveDataDir({});
  assert.ok(!dflt.startsWith(ROOT + path.sep) && dflt !== ROOT, 'not inside the app folder');
  assert.ok(createStore(os.tmpdir()).dataDir);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateSchedule, loadSchedule, saveSchedule, defaultSchedule, nextRunAt, describeNextRun, formatTime12, describeLastRun, scheduleSummary,
  buildDigest, digestMarkdown, writeDigest, listDigests, readDigest, localDate, LIMITS, LIVE_ACCEPT_TEXT, SCHEDULE_FILE,
} from '../lib/schedule.mjs';
import { tempStore } from './helpers.mjs';

test('defaults match the product: Practice, 1 agent, 10 per run, 30 hour window, 90 minute cap', () => {
  const d = defaultSchedule();
  assert.equal(d.mode, 'practice');
  assert.equal(d.maxApps, 10);
  assert.equal(d.freshHours, 30);
  assert.equal(d.maxMinutes, 90);
  assert.equal(d.agents, 1);
  assert.equal(d.enabled, false);
  assert.equal(LIMITS.maxApps.max, 25, 'hard maximum of 25 per run');
  assert.equal(LIMITS.agents.max, 3);
});

test('validateSchedule: strict about time, days, mode and every number', () => {
  const ok = validateSchedule({ time: '04:10', days: 'weekdays', mode: 'practice', agents: 2, maxApps: 25, freshHours: 48, maxMinutes: 60 });
  assert.ok(ok.ok, ok.errors.join(' '));
  assert.deepEqual([ok.value.days, ok.value.agents, ok.value.maxApps, ok.value.freshHours, ok.value.maxMinutes], ['weekdays', 2, 25, 48, 60]);
  for (const time of ['4:10', '24:00', '12:60', '', undefined, '12:00:00', 'noon']) assert.equal(validateSchedule({ time }).ok, false, String(time));
  assert.equal(validateSchedule({ time: '04:10', days: 'sometimes' }).ok, false);
  assert.equal(validateSchedule({ time: '04:10', mode: 'yolo' }).ok, false);
  for (const [k, v] of [['agents', 0], ['agents', 4], ['maxApps', 26], ['maxApps', 0], ['freshHours', 0], ['freshHours', 169], ['maxMinutes', 9], ['maxMinutes', 241], ['maxApps', 2.5], ['maxApps', 'ten']]) {
    const r = validateSchedule({ time: '04:10', [k]: v });
    assert.equal(r.ok, false, `${k}=${v}`);
  }
  const empty = validateSchedule({ time: '09:00' });
  assert.ok(empty.ok);
  assert.equal(empty.value.maxApps, 10);
});

test('Live needs the explicit acceptance, and the text is the agreed wording', () => {
  assert.equal(validateSchedule({ time: '04:10', mode: 'live' }).ok, false);
  assert.equal(validateSchedule({ time: '04:10', mode: 'live', liveAccepted: 'true' }).ok, false, 'a string is not consent');
  assert.equal(validateSchedule({ time: '04:10', mode: 'live', liveAccepted: 1 }).ok, false);
  const ok = validateSchedule({ time: '04:10', mode: 'live', liveAccepted: true });
  assert.ok(ok.ok);
  assert.equal(ok.value.liveAccepted, true);
  assert.equal(validateSchedule({ time: '04:10', mode: 'practice', liveAccepted: true }).value.liveAccepted, false, 'acceptance does not carry over to Practice');
  assert.equal(LIVE_ACCEPT_TEXT, 'I have reviewed Practice results and accept that applications will be submitted automatically');
});

test('a saved Live schedule without a recorded acceptance loads as Practice', () => {
  const { store, cleanup } = tempStore();
  store.writeJson(SCHEDULE_FILE, { enabled: true, time: '05:00', mode: 'live', liveAccepted: false });
  assert.equal(loadSchedule(store).mode, 'practice');
  store.writeJson(SCHEDULE_FILE, { enabled: true, time: '05:00', mode: 'live', liveAccepted: true });
  assert.equal(loadSchedule(store).mode, 'live');
  store.writeJson(SCHEDULE_FILE, { enabled: true, time: 'garbage', days: 'x', agents: 99, maxApps: 999, freshHours: -4 });
  const s = loadSchedule(store);
  assert.equal(s.time, '04:10');
  assert.equal(s.agents, 3);
  assert.equal(s.maxApps, 25);
  assert.equal(s.freshHours, 1);
  cleanup();
});

test('nextRunAt, daily and weekdays, including the rollover cases', () => {
  const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0);
  const daily = { time: '04:10', days: 'daily' };
  assert.deepEqual(nextRunAt(daily, at(2026, 10, 11, 3, 0)), at(2026, 10, 11, 4, 10));
  assert.deepEqual(nextRunAt(daily, at(2026, 10, 11, 4, 10)), at(2026, 10, 12, 4, 10), 'strictly after now');
  assert.deepEqual(nextRunAt(daily, at(2026, 10, 11, 22, 0)), at(2026, 10, 12, 4, 10));
  assert.deepEqual(nextRunAt(daily, at(2026, 12, 31, 23, 0)), at(2027, 1, 1, 4, 10));
  const wk = { time: '04:10', days: 'weekdays' };
  // 2026-10-09 is a Friday, 10 is Saturday, 11 Sunday, 12 Monday.
  assert.deepEqual(nextRunAt(wk, at(2026, 10, 9, 5, 0)), at(2026, 10, 12, 4, 10));
  assert.deepEqual(nextRunAt(wk, at(2026, 10, 10, 1, 0)), at(2026, 10, 12, 4, 10));
  assert.deepEqual(nextRunAt(wk, at(2026, 10, 12, 3, 0)), at(2026, 10, 12, 4, 10));
});

test('human text: "tomorrow 4:10 AM", "today 9:00 PM", weekday names', () => {
  const now = new Date(2026, 9, 11, 12, 0);
  assert.equal(formatTime12('04:10'), '4:10 AM');
  assert.equal(formatTime12('00:05'), '12:05 AM');
  assert.equal(formatTime12('12:00'), '12:00 PM');
  assert.equal(formatTime12('21:00'), '9:00 PM');
  assert.equal(describeNextRun(new Date(2026, 9, 12, 4, 10), now), 'tomorrow 4:10 AM');
  assert.equal(describeNextRun(new Date(2026, 9, 11, 21, 0), now), 'today 9:00 PM');
  assert.equal(describeNextRun(new Date(2026, 9, 13, 4, 10), now), 'Tuesday 4:10 AM');
  assert.equal(describeLastRun({ status: 'finished', submitted: 6, held: 2, ready: 0 }), 'Last run: 6 submitted, 2 held');
  assert.equal(describeLastRun({ status: 'finished', ready: 4, held: 0 }), 'Last run: 4 ready to review');
  assert.equal(describeLastRun({ status: 'finished' }), 'Last run: nothing new matched');
  assert.match(describeLastRun({ status: 'failed', error: 'Chrome did not answer' }), /did not start: Chrome did not answer/);
  assert.equal(describeLastRun(null), '');
  const sum = scheduleSummary({ ...defaultSchedule(), enabled: true, lastRun: { status: 'finished', submitted: 1 } }, now);
  assert.equal(sum.nextRunText, 'tomorrow 4:10 AM');
  assert.equal(scheduleSummary(defaultSchedule(), now).nextRunText, '');
});

test('digests: written as .md and .json by date, listed newest first, read back safely', () => {
  const { store, dir, cleanup } = tempStore();
  const start = new Date(2026, 9, 11, 4, 10);
  const d = buildDigest({
    startedAt: start.toISOString(), finishedAt: new Date(start.getTime() + 60000).toISOString(), status: 'finished', mode: 'practice',
    agents: 1, maxApps: 10, freshHours: 30, counts: { ready: 2, held: 1 },
    items: [{ status: 'ready', company: 'Acme', role: 'Support', pay: '$90k', source: 'lever', url: 'https://example.com/1', note: 'read my answer' }],
    held: [{ company: 'Beta', role: 'Tech', url: 'https://example.com/2', question: 'Needs the emailed verification code' }],
  });
  const w = writeDigest(store, d);
  assert.equal(w.name, localDate(start));
  assert.ok(fs.existsSync(w.json) && fs.existsSync(w.markdown));
  assert.match(fs.readFileSync(w.markdown, 'utf8'), /Ready to review[\s\S]*Acme/);
  assert.match(fs.readFileSync(w.markdown, 'utf8'), /Needs you[\s\S]*Beta/);
  const w2 = writeDigest(store, { ...d, status: 'failed', error: 'Chrome did not answer', hint: 'Open Chrome' });
  assert.equal(w2.name, `${localDate(start)}-2`, 'a second run the same day does not overwrite the first');
  const list = listDigests(store);
  assert.deepEqual(list.map((x) => x.name), [`${localDate(start)}-2`, localDate(start)]);
  assert.equal(list[0].status, 'failed');
  assert.equal(readDigest(store, localDate(start)).digest.counts.ready, 2);
  assert.match(readDigest(store, `${localDate(start)}-2`).markdown, /How to fix it: Open Chrome/);
  for (const bad of ['../profile', '..\\profile', '2026-10-11/../../x', 'profile', '2026-10-11.json', '', null]) assert.equal(readDigest(store, bad), null, String(bad));
  fs.writeFileSync(`${dir}/digests/junk.json`, '{}');
  assert.equal(listDigests(store).length, 2, 'files that are not digests are ignored');
  assert.match(digestMarkdown({ ...d, status: 'stopped', error: 'Time limit reached (90 minutes).' }), /Stopped early/);
  cleanup();
});

test('saveSchedule merges and keeps what it was not told about', () => {
  const { store, cleanup } = tempStore();
  saveSchedule(store, { enabled: true, time: '07:00', savedAt: 'x' });
  saveSchedule(store, { lastRun: { status: 'finished', submitted: 3 } });
  const s = loadSchedule(store);
  assert.equal(s.time, '07:00');
  assert.equal(s.enabled, true);
  assert.equal(s.lastRun.submitted, 3);
  cleanup();
});

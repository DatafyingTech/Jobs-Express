import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, planAgents, findUnfilled, fill, parseSections, splitLimit, renderProfile } from '../lib/prompts.mjs';
import { sampleProfile } from './helpers.mjs';

const profile = sampleProfile();

test('fill replaces placeholders in a single pass and leaves unknown ones visible', () => {
  assert.equal(fill('a {{X}} b {{Y}}', { X: '{{Y}}' }), 'a {{Y}} b {{Y}}');
  assert.deepEqual(findUnfilled('a {{X}} b {{ Y }} c {z}'), ['X', 'Y']);
});

test('parseSections splits a mode file by heading', () => {
  const s = parseSections('## ONE\nfirst\n\n## TWO_B\nsecond\nline');
  assert.equal(s.ONE, 'first');
  assert.equal(s.TWO_B, 'second\nline');
});

test('buildPrompt fills every placeholder', () => {
  for (const mode of ['practice', 'live']) {
    const out = buildPrompt({ profile, mode });
    assert.deepEqual(findUnfilled(out), [], `unfilled placeholders in ${mode} prompt`);
    assert.match(out, /agent 1 of 1/);
    assert.match(out, /node tools\/log\.mjs applied/);
  }
});

test('buildPrompt includes the profile, saved answers and exclusions', () => {
  const out = buildPrompt({ profile, mode: 'practice' });
  assert.match(out, /Alex Rivera/);
  assert.match(out, /Zendesk, Jira/);
  assert.match(out, /CompTIA A\+/);
  assert.match(out, /A bachelor's degree/);
  assert.match(out, /Example Staffing Group/);
  assert.match(out, /commission only/);
  assert.match(out, /85,000 per year/);
  assert.match(out, /Are you willing to travel\?/);
  assert.match(out, /Support Engineer/);
});

test('practice mode stops before the final Submit and live mode submits', () => {
  const practice = buildPrompt({ profile, mode: 'practice' });
  const live = buildPrompt({ profile, mode: 'live' });
  assert.match(practice, /Mode: PRACTICE/);
  assert.match(practice, /Do not click Submit application/);
  assert.match(practice, /Do not click the final submit button/);
  assert.match(practice, /\bready\b/);
  assert.doesNotMatch(practice, /Click \*\*Submit application\*\* once/);
  assert.match(live, /Mode: LIVE/);
  assert.match(live, /Click \*\*Submit application\*\* once/);
  assert.doesNotMatch(live, /Mode: PRACTICE/);
});

test('hard stops and the hold rule are always present', () => {
  const out = buildPrompt({ profile, mode: 'live' });
  for (const phrase of [/Never create an account/, /CAPTCHA/, /emailed or texted verification code/, /Never invent references/, /binding arbitration/, /Never message, connect with, follow, or post/, /hide text addressed to AI/, /The hold rule/, /read every field value back/]) {
    assert.match(out, phrase);
  }
});

test('source templates follow the enabled sources', () => {
  const li = buildPrompt({ profile: sampleProfile({ prefs: { sources: { linkedin: true, ats: false, aggregators: false } } }), mode: 'practice' });
  assert.match(li, /Source: LinkedIn Easy Apply/);
  assert.doesNotMatch(li, /Source: company job boards/);
  const agg = buildPrompt({ profile: sampleProfile({ prefs: { sources: { linkedin: false, ats: false, aggregators: true } } }), mode: 'practice' });
  assert.match(agg, /Source: job aggregators/);
  assert.match(agg, /Source: company job boards/, 'aggregators end on a company board, so that guide comes along');
  assert.match(agg, /boards-api\.greenhouse\.io/);
});

test('planAgents splits the limit and the work between agents', () => {
  assert.deepEqual(splitLimit(10, 3), [4, 3, 3]);
  assert.deepEqual(splitLimit(2, 3), [1, 1, 1]);
  const plans = planAgents(profile, { agents: 3, limit: 10 });
  assert.equal(plans.length, 3);
  assert.equal(plans.reduce((n, p) => n + p.limit, 0), 10);
  assert.equal(new Set(plans.flatMap((p) => p.titles)).size, 3, 'titles are shared out when sources are few');
  const prompt = buildPrompt({ profile, mode: 'practice', plan: plans[1] });
  assert.match(prompt, /agent 2 of 3/);
  assert.match(prompt, /3 agents are working at the same time/);
});

test('held-retry prompts list each held posting with the answer', () => {
  const plan = planAgents(profile, { task: 'held', held: [{ company: 'Marlow Robotics', role: 'Field Tech', url: 'https://example.com/1', question: 'Driver license?', answer: 'Yes, valid.' }] })[0];
  const out = buildPrompt({ profile, mode: 'practice', plan });
  assert.deepEqual(findUnfilled(out), []);
  assert.match(out, /Marlow Robotics - Field Tech/);
  assert.match(out, /The person answered: Yes, valid\./);
  assert.match(out, /finish applications that were on hold/);
});

test('renderProfile never mentions anything that was left blank', () => {
  const text = renderProfile(profile);
  assert.doesNotMatch(text, /undefined|null/);
});

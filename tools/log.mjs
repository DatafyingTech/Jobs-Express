#!/usr/bin/env node
// The only way agents record what they did. Appends one JSON line to the data folder:
//   node tools/log.mjs applied|ready|held|skipped --company ... --role ... --pay ... --url ... --note ...
//   node tools/log.mjs check --company ... [--role ...] [--url ...] [--claim]
// Output is a single line of JSON. Exit code 0 on success, 1 on a rejected or malformed call.
//
// `check --claim` is the atomic form: if nobody else has the posting it also marks it as being worked on by this
// agent, so two agents never fill in the same application at once.
// CJA_MODE=live|practice (set by the app) decides whether a posting that was only filled in during Practice counts
// as a duplicate. In a Live run it does not: that is the one the person wants submitted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStore, recordApplication, recordHeld, checkDuplicate, claimPosting, listApplications, appKey,
} from '../lib/store.mjs';

const VERBS = { applied: 'submitted', ready: 'ready', held: 'held', skipped: 'skipped' };
const KNOWN = new Set(['company', 'role', 'pay', 'url', 'note', 'source', 'question', 'agent', 'run']);
const SWITCHES = new Set(['claim']);

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}". Flags look like --company "Name".`);
    let key = a.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq > 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (SWITCHES.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!KNOWN.has(key)) throw new Error(`Unknown flag --${key}. Allowed: ${[...KNOWN, ...SWITCHES].map((k) => '--' + k).join(', ')}`);
    if (value === undefined) {
      value = rest[i + 1];
      // A value may start with dashes ("--- pay below floor"). Only another known flag ends it.
      const next = typeof value === 'string' ? /^--([a-z]+)(=|$)/.exec(value) : null;
      if (value === undefined || (next && (KNOWN.has(next[1]) || SWITCHES.has(next[1])))) throw new Error(`Flag --${key} needs a value.`);
      i++;
    }
    flags[key] = value;
  }
  return { verb, flags };
}

/** Run the helper against a store. Returns { code, out } so tests can call it directly. */
export function run(argv, store = createStore(), env = process.env) {
  try {
    const { verb, flags } = parseArgs(argv);
    if (!verb) throw new Error('Usage: node tools/log.mjs applied|ready|held|skipped|check --company "..." [--role ...] [--pay ...] [--url ...] [--note ...]');
    const extra = { agent: flags.agent ?? env.CJA_AGENT, run: flags.run ?? env.CJA_RUN };
    const mode = env.CJA_MODE === 'live' ? 'live' : 'practice';
    if (verb === 'check') {
      if (!flags.company) throw new Error('--company is required');
      const dup = checkDuplicate(store, flags, { mode });
      if (flags.claim && !dup.duplicate) {
        const c = claimPosting(store, flags, extra);
        if (c.duplicate) return { code: 0, out: JSON.stringify({ ok: true, duplicate: true, reason: c.reason }) };
        return { code: 0, out: JSON.stringify({ ok: true, ...dup, claimed: c.claimed }) };
      }
      return { code: 0, out: JSON.stringify({ ok: true, ...dup }) };
    }
    if (verb === 'held') {
      const h = recordHeld(store, flags, extra);
      // A held posting also shows up in the applications table.
      const app = recordApplication(store, { ...flags, status: 'held', note: flags.note || flags.question }, extra);
      return { code: 0, out: JSON.stringify({ ok: true, status: 'held', id: h.id, appId: app.id }) };
    }
    if (VERBS[verb]) {
      if (verb === 'applied' && flags.url) {
        // One confirmation page is one application. A second "applied" for the same posting is not counted again.
        const key = appKey({ url: flags.url });
        const done = listApplications(store).find((r) => r.url && appKey(r) === key && r.status === 'submitted');
        if (done) return { code: 0, out: JSON.stringify({ ok: true, duplicate: true, already: 'submitted', id: done.id }) };
      }
      const rec = recordApplication(store, { ...flags, status: VERBS[verb] }, extra);
      return { code: 0, out: JSON.stringify({ ok: true, status: rec.status, id: rec.id }) };
    }
    throw new Error(`Unknown action "${verb}". Use applied, ready, held, skipped or check.`);
  } catch (e) {
    return { code: 1, out: JSON.stringify({ ok: false, error: e.message }) };
  }
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (isMain) {
  const store = createStore();
  store.ensure();
  const { code, out } = run(process.argv.slice(2), store);
  process.stdout.write(out + '\n');
  process.exit(code);
}

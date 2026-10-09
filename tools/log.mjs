#!/usr/bin/env node
// The only way agents record what they did. Appends one JSON line to the data folder:
//   node tools/log.mjs applied|ready|held|skipped --company ... --role ... --pay ... --url ... --note ...
//   node tools/log.mjs check --company ... [--role ...] [--url ...]
// Output is a single line of JSON. Exit code 0 on success, 1 on a rejected or malformed call.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, recordApplication, recordHeld, checkDuplicate } from '../lib/store.mjs';

const VERBS = { applied: 'submitted', ready: 'ready', held: 'held', skipped: 'skipped' };
const KNOWN = new Set(['company', 'role', 'pay', 'url', 'note', 'source', 'question', 'agent', 'run']);

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}". Flags look like --company "Name".`);
    const key = a.slice(2);
    if (!KNOWN.has(key)) throw new Error(`Unknown flag --${key}. Allowed: ${[...KNOWN].map((k) => '--' + k).join(', ')}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Flag --${key} needs a value.`);
    flags[key] = value;
    i++;
  }
  return { verb, flags };
}

/** Run the helper against a store. Returns { code, out } so tests can call it directly. */
export function run(argv, store = createStore(), env = process.env) {
  try {
    const { verb, flags } = parseArgs(argv);
    if (!verb) throw new Error('Usage: node tools/log.mjs applied|ready|held|skipped|check --company "..." [--role ...] [--pay ...] [--url ...] [--note ...]');
    const extra = { agent: flags.agent ?? env.CJA_AGENT, run: flags.run ?? env.CJA_RUN };
    if (verb === 'check') {
      if (!flags.company) throw new Error('--company is required');
      return { code: 0, out: JSON.stringify({ ok: true, ...checkDuplicate(store, flags) }) };
    }
    if (verb === 'held') {
      const h = recordHeld(store, flags, extra);
      // A held posting also shows up in the applications table.
      const app = recordApplication(store, { ...flags, status: 'held', note: flags.note || flags.question }, extra);
      return { code: 0, out: JSON.stringify({ ok: true, status: 'held', id: h.id, appId: app.id }) };
    }
    if (VERBS[verb]) {
      const rec = recordApplication(store, { ...flags, status: VERBS[verb] }, extra);
      return { code: 0, out: JSON.stringify({ ok: true, status: rec.status, id: rec.id }) };
    }
    throw new Error(`Unknown action "${verb}". Use applied, ready, held, skipped or check.`);
  } catch (e) {
    return { code: 1, out: JSON.stringify({ ok: false, error: e.message }) };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const store = createStore();
  store.ensure();
  const { code, out } = run(process.argv.slice(2), store);
  process.stdout.write(out + '\n');
  process.exit(code);
}

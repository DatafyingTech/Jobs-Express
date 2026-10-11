// A stand-in for the Claude CLI used by the runner tests. It reads the prompt from stdin,
// prints a few stream-json lines, and (in "hang" mode) keeps running until it is killed.
import { appendFileSync } from 'node:fs';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  if (process.env.CJA_FAKE_ARGS_FILE) appendFileSync(process.env.CJA_FAKE_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), promptLength: prompt.length, agent: process.env.CJA_AGENT, run: process.env.CJA_RUN, dataDir: process.env.CJA_DATA_DIR, mode: process.env.CJA_MODE, envKeys: Object.keys(process.env) }) + '\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read', 'mcp__claude-in-chrome__navigate'] });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the first posting.' }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://example.com/jobs/1' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true,"status":"ready","id":"a_x"}' }] } });
  if (process.env.CJA_FAKE_MODE === 'tools') {
    for (let i = 0; i < 12; i++) out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' + i, name: 'mcp__claude-in-chrome__read_page', input: {} }] } });
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.CJA_FAKE_MODE === 'silent') {
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.CJA_FAKE_MODE === 'hang') {
    setInterval(() => out({ type: 'assistant', message: { content: [{ type: 'text', text: 'still working' }] } }), 200);
    return;
  }
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 1200, result: 'All done.' });
});

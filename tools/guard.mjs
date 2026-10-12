#!/usr/bin/env node
// A tiny supervisor that sits between Jobs Express and one `claude` agent.
//
//   node tools/guard.mjs <parent-pid>        the command to run is in the CJA_GUARD_SPEC environment variable
//
// If the app that started the agent disappears (its window was closed, it crashed, it was killed), the guard notices
// within a couple of seconds and kills the agent and everything the agent started. Without it, an agent could keep
// browsing and submitting with no window and no Stop button.
//
// stdin, stdout and stderr pass straight through to the agent, so the app talks to it exactly as before.
import { spawn, spawnSync } from 'node:child_process';

const parentPid = Number(process.argv[2]);
let spec;
try {
  spec = JSON.parse(process.env.CJA_GUARD_SPEC || '');
} catch {
  console.error('guard: no command to run');
  process.exit(2);
}
if (!Number.isInteger(parentPid) || parentPid <= 0 || typeof spec.command !== 'string' || !Array.isArray(spec.args)) {
  console.error('guard: bad arguments');
  process.exit(2);
}
const env = { ...process.env };
delete env.CJA_GUARD_SPEC;

const isWin = process.platform === 'win32';
const child = spawn(spec.command, spec.args, { stdio: 'inherit', env, shell: !!spec.shell, windowsVerbatimArguments: !!spec.verbatim, windowsHide: true });

function killChild() {
  if (child.pid == null || child.exitCode !== null) return;
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* already gone */ }
}

function parentAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const watch = setInterval(() => {
  if (!parentAlive()) {
    killChild();
    process.exit(143);
  }
}, 2000);

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => { killChild(); process.exit(143); });
  } catch { /* not every signal exists on every platform */ }
}
child.on('error', (e) => { console.error(`guard: could not start the agent: ${e.message}`); clearInterval(watch); process.exit(127); });
child.on('close', (code, signal) => { clearInterval(watch); process.exit(code ?? (signal ? 143 : 1)); });

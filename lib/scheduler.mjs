// Talks to the operating system's own scheduler so the daily run happens even when this app is closed.
//
//   Windows  Task Scheduler (Register-ScheduledTask), run only while you are signed in
//   macOS    a launchd agent in ~/Library/LaunchAgents
//   Linux    a systemd user timer (Persistent=true), or a crontab line when systemd --user is unavailable
//
// Two halves, kept apart on purpose:
//   * "generate" functions are pure: they turn a validated spec into script text, XML, plist or unit text.
//   * "apply" functions run those through an injectable command runner and file API, so tests never touch a real OS.
//
// Safety rule: no free-form text is ever spliced into a command. The Windows PowerShell is a constant;
// values reach it through environment variables, after strict validation. Everything else is generated
// from validated fields with the escaping each format needs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TASK_NAME, TIME_RE } from './schedule.mjs';

export class SchedulerError extends Error {}

export const NAME_RE = /^JobsExpressDaily(-TEST-[A-Za-z0-9]{3,16})?$/;
export const SCHEDULED_ARG = '--scheduled-run';
const WEEKDAY_NUMBERS = [1, 2, 3, 4, 5];

export function taskNameFromEnv(env = process.env) {
  const n = env.CJA_SCHEDULE_TASK_NAME;
  return n && NAME_RE.test(n) ? n : TASK_NAME;
}

export function schedulerKind(platform = process.platform) {
  return platform === 'win32' ? 'task-scheduler' : platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : 'unsupported';
}

export const KIND_LABEL = {
  'task-scheduler': 'Windows Task Scheduler',
  launchd: 'macOS launchd',
  systemd: 'systemd user timer',
  cron: 'crontab',
  unsupported: 'not supported on this system',
};

// --- validation ----------------------------------------------------------------------------

function checkPath(label, p, { absolute = true } = {}) {
  const s = String(p ?? '');
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 1000 || /[\u0000-\u001f"\u007f]/.test(s)) throw new SchedulerError(`${label} contains characters that cannot be used in a scheduled task.`);
  if (absolute && !path.isAbsolute(s) && !path.win32.isAbsolute(s)) throw new SchedulerError(`${label} must be a full path.`);
  return s;
}

/** Validate and normalise everything that reaches an OS command. Throws SchedulerError. */
export function validateSpec(spec = {}) {
  const name = String(spec.name ?? TASK_NAME);
  if (!NAME_RE.test(name)) throw new SchedulerError('That task name is not allowed.');
  const time = String(spec.time ?? '');
  if (!TIME_RE.test(time)) throw new SchedulerError('The time must look like 04:10 (24-hour).');
  const days = String(spec.days ?? 'daily');
  if (days !== 'daily' && days !== 'weekdays') throw new SchedulerError('Days must be daily or weekdays.');
  const limit = Number(spec.limitMinutes ?? 120);
  if (!Number.isInteger(limit) || limit < 10 || limit > 600) throw new SchedulerError('The time limit is out of range.');
  const out = {
    name, time, days,
    nodePath: checkPath('The Node.js path', spec.nodePath),
    scriptPath: checkPath('The app path', spec.scriptPath),
    workDir: checkPath('The app folder', spec.workDir),
    dataDir: spec.dataDir ? checkPath('The data folder', spec.dataDir) : '',
    limitMinutes: limit,
    display: typeof spec.display === 'string' && /^[\w.:/-]{1,64}$/.test(spec.display) ? spec.display : '',
  };
  return out;
}

const hm = (time) => time.split(':').map(Number);

/** Everything after the script path on the command line. */
export function scheduledArgs(spec) {
  return spec.dataDir ? [SCHEDULED_ARG, '--data-dir', spec.dataDir] : [SCHEDULED_ARG];
}

// --- Windows -------------------------------------------------------------------------------

export const PS_REGISTER = `
$ErrorActionPreference = 'Stop'
$at = [datetime]::ParseExact($env:JE_TIME, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$arg = '"' + $env:JE_SCRIPT + '" --scheduled-run'
if ($env:JE_DATADIR) { $arg = $arg + ' --data-dir "' + $env:JE_DATADIR + '"' }
$action = New-ScheduledTaskAction -Execute $env:JE_NODE -Argument $arg -WorkingDirectory $env:JE_WORKDIR
if ($env:JE_DAYS -eq 'weekdays') {
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $at
} else {
  $trigger = New-ScheduledTaskTrigger -Daily -At $at
}
$limit = New-TimeSpan -Minutes ([int]$env:JE_LIMIT_MIN)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit $limit
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $env:JE_NAME -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Jobs Express: daily job-application run' -Force | Out-Null
Write-Output 'OK'
`.trim();

export const PS_QUERY = `
$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName $env:JE_NAME -ErrorAction SilentlyContinue
if (-not $t) { Write-Output '{"exists":false}'; exit 0 }
$i = Get-ScheduledTaskInfo -TaskName $env:JE_NAME
function Iso($d) { if ($d -and $d.Year -gt 2000) { $d.ToString('o') } else { $null } }
$trig = $t.Triggers | Select-Object -First 1
$act = $t.Actions | Select-Object -First 1
$days = $null
if ($trig -and $trig.PSObject.Properties['DaysOfWeek']) { $days = [int]$trig.DaysOfWeek }
[pscustomobject]@{
  exists = $true
  state = [string]$t.State
  nextRun = (Iso $i.NextRunTime)
  lastRun = (Iso $i.LastRunTime)
  lastResult = [int64]$i.LastTaskResult
  start = [string]$trig.StartBoundary
  daysOfWeek = $days
  startWhenAvailable = [bool]$t.Settings.StartWhenAvailable
  wakeToRun = [bool]$t.Settings.WakeToRun
  execute = [string]$act.Execute
  arguments = [string]$act.Arguments
} | ConvertTo-Json -Compress
`.trim();

export const PS_REMOVE = `
$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName $env:JE_NAME -ErrorAction SilentlyContinue
if ($t) { Unregister-ScheduledTask -TaskName $env:JE_NAME -Confirm:$false; Write-Output 'REMOVED' } else { Write-Output 'ABSENT' }
`.trim();

/** Pure: the environment the constant PowerShell reads. */
export function windowsEnv(specIn) {
  const spec = validateSpec(specIn);
  return {
    JE_NAME: spec.name,
    JE_TIME: spec.time,
    JE_DAYS: spec.days,
    JE_NODE: spec.nodePath,
    JE_SCRIPT: spec.scriptPath,
    JE_WORKDIR: spec.workDir,
    JE_DATADIR: spec.dataDir,
    JE_LIMIT_MIN: String(spec.limitMinutes),
  };
}

export function powershellArgs(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

// --- macOS ---------------------------------------------------------------------------------

export const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const launchdLabel = (name) => `com.jobsexpress.${name}`;

export function launchdPlist(specIn) {
  const spec = validateSpec(specIn);
  const [hour, minute] = hm(spec.time);
  const dict = (weekday) => `<dict>${weekday ? `<key>Weekday</key><integer>${weekday}</integer>` : ''}<key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
  const calendar = spec.days === 'weekdays' ? `<array>${WEEKDAY_NUMBERS.map(dict).join('')}</array>` : dict(0);
  const args = [spec.nodePath, spec.scriptPath, ...scheduledArgs(spec)].map((a) => `<string>${xmlEscape(a)}</string>`).join('');
  const log = path.posix.join((spec.dataDir || path.posix.join(spec.workDir, 'data')).replace(/\\/g, '/'), 'scheduled-run.stdout.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(launchdLabel(spec.name))}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>WorkingDirectory</key><string>${xmlEscape(spec.workDir)}</string>
  <key>StartCalendarInterval</key>${calendar}
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

// --- Linux ---------------------------------------------------------------------------------

export const unitBase = (name) => name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

/** systemd command-line quoting: wrap in double quotes, escape backslash, quote, % and $. */
export const systemdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;

export function systemdUnits(specIn) {
  const spec = validateSpec(specIn);
  const [hour, minute] = hm(spec.time);
  const when = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  const calendar = spec.days === 'weekdays' ? `Mon..Fri *-*-* ${when}` : `*-*-* ${when}`;
  const exec = [spec.nodePath, spec.scriptPath, ...scheduledArgs(spec)].map(systemdQuote).join(' ');
  const base = unitBase(spec.name);
  return {
    base,
    service: `[Unit]
Description=Jobs Express daily run

[Service]
Type=oneshot
WorkingDirectory=${spec.workDir.replace(/%/g, '%%')}
ExecStart=${exec}
TimeoutStartSec=${(spec.limitMinutes + 30) * 60}
${spec.display ? `Environment=DISPLAY=${spec.display}\n` : ''}`,
    timer: `[Unit]
Description=Jobs Express daily timer

[Timer]
OnCalendar=${calendar}
Persistent=true
Unit=${base}.service

[Install]
WantedBy=timers.target
`,
  };
}

/** POSIX single-quote a value for a crontab line. */
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const cronMarker = (name) => `# JobsExpress:${name}`;

export function cronLine(specIn) {
  const spec = validateSpec(specIn);
  const [hour, minute] = hm(spec.time);
  const dow = spec.days === 'weekdays' ? '1-5' : '*';
  const env = spec.display ? `DISPLAY=${spec.display} ` : '';
  const cmd = [spec.nodePath, spec.scriptPath, ...scheduledArgs(spec)].map(shQuote).join(' ');
  return `${minute} ${hour} * * ${dow} cd ${shQuote(spec.workDir)} && ${env}${cmd} >/dev/null 2>&1 ${cronMarker(spec.name)}`;
}

/** Remove our line (by marker) from existing crontab text and optionally add a new one. */
export function updateCrontab(existing, name, line = null) {
  const marker = cronMarker(name);
  const kept = String(existing || '').split(/\r?\n/).filter((l) => l.trim() && !l.trimEnd().endsWith(marker));
  if (line) kept.push(line);
  return kept.length ? kept.join('\n') + '\n' : '';
}

// --- apply: default helpers --------------------------------------------------------------

export function defaultExec(file, args = [], { env, input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(file, args, { env: { ...process.env, ...(env || {}) }, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || (err && typeof err.code !== 'number' ? err.message : '') || '' });
      });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: e.message });
      return;
    }
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

export const defaultFs = {
  writeFile: (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8'); },
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  rm: (p) => fs.rmSync(p, { force: true }),
  exists: (p) => fs.existsSync(p),
};

function makeCtx(ctxIn) {
  const ctx = ctxIn || {};
  const platform = ctx.platform || process.platform;
  return {
    platform,
    exec: ctx.exec || defaultExec,
    fs: ctx.fs || defaultFs,
    home: ctx.home || os.homedir(),
    uid: ctx.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0),
    kind: schedulerKind(platform),
  };
}

const failure = (what, r) => new SchedulerError(`${what} ${String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ') || `(exit code ${r.code})`}`.trim());

const launchdPath = (c, name) => path.posix.join(c.home.replace(/\\/g, '/'), 'Library', 'LaunchAgents', `${launchdLabel(name)}.plist`);
const unitDir = (c) => path.posix.join(c.home.replace(/\\/g, '/'), '.config', 'systemd', 'user');

// --- apply: install / query / remove -----------------------------------------------------

/** Create or replace the scheduled job. Returns { kind, label }. Throws SchedulerError with a plain message. */
export async function installSchedule(specIn, ctxIn = {}) {
  const spec = validateSpec(specIn);
  const c = makeCtx(ctxIn);
  switch (c.kind) {
    case 'task-scheduler': {
      const r = await c.exec('powershell.exe', powershellArgs(PS_REGISTER), { env: windowsEnv(spec) });
      if (r.code !== 0 || !/\bOK\b/.test(r.stdout)) throw failure('Windows Task Scheduler refused the task:', r);
      return { kind: 'task-scheduler', label: KIND_LABEL['task-scheduler'] };
    }
    case 'launchd': {
      const file = launchdPath(c, spec.name);
      const target = `gui/${c.uid}`;
      await c.exec('launchctl', ['bootout', `${target}/${launchdLabel(spec.name)}`]); // not loaded yet is fine
      c.fs.writeFile(file, launchdPlist(spec));
      const r = await c.exec('launchctl', ['bootstrap', target, file]);
      if (r.code !== 0) throw failure('launchd refused the job:', r);
      return { kind: 'launchd', label: KIND_LABEL.launchd };
    }
    case 'systemd': {
      const units = systemdUnits(spec);
      const dir = unitDir(c);
      const reload = await c.exec('systemctl', ['--user', 'daemon-reload']);
      if (reload.code === 0) {
        c.fs.writeFile(path.posix.join(dir, `${units.base}.service`), units.service);
        c.fs.writeFile(path.posix.join(dir, `${units.base}.timer`), units.timer);
        await c.exec('systemctl', ['--user', 'import-environment', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']);
        const r1 = await c.exec('systemctl', ['--user', 'daemon-reload']);
        const r2 = r1.code === 0 ? await c.exec('systemctl', ['--user', 'enable', '--now', `${units.base}.timer`]) : r1;
        if (r2.code === 0) return { kind: 'systemd', label: KIND_LABEL.systemd };
        c.fs.rm(path.posix.join(dir, `${units.base}.service`));
        c.fs.rm(path.posix.join(dir, `${units.base}.timer`));
      }
      // No user systemd here (minimal desktops, containers): fall back to cron, which has no catch-up for missed runs.
      const cur = await c.exec('crontab', ['-l']);
      const next = updateCrontab(cur.code === 0 ? cur.stdout : '', spec.name, cronLine(spec));
      const w = await c.exec('crontab', ['-'], { input: next });
      if (w.code !== 0) throw failure('Neither systemd nor crontab would accept the job:', w);
      return { kind: 'cron', label: KIND_LABEL.cron };
    }
    default:
      throw new SchedulerError('Scheduling is not supported on this operating system. Start Jobs Express by hand instead.');
  }
}

export function daysFromMask(mask) {
  if (mask == null) return 'daily';
  return Number(mask) === 62 ? 'weekdays' : 'daily';
}

/** Is the job installed, and when does it next run? Never throws. */
export async function querySchedule(nameIn = TASK_NAME, ctxIn = {}) {
  const name = NAME_RE.test(nameIn) ? nameIn : TASK_NAME;
  const c = makeCtx(ctxIn);
  const base = { installed: false, kind: c.kind, label: KIND_LABEL[c.kind] };
  try {
    switch (c.kind) {
      case 'task-scheduler': {
        const r = await c.exec('powershell.exe', powershellArgs(PS_QUERY), { env: { JE_NAME: name } });
        if (r.code !== 0) return { ...base, error: String(r.stderr || r.stdout).trim().slice(0, 300) };
        let j;
        try { j = JSON.parse(r.stdout.trim()); } catch { return { ...base, error: 'Could not read the scheduler answer.' }; }
        if (!j.exists) return base;
        const startTime = /T(\d\d:\d\d)/.exec(j.start || '');
        return {
          ...base, installed: true, state: j.state, nextRun: j.nextRun, lastRun: j.lastRun, lastResult: j.lastResult,
          time: startTime ? startTime[1] : null, days: daysFromMask(j.daysOfWeek),
          startWhenAvailable: !!j.startWhenAvailable, wakeToRun: !!j.wakeToRun, command: `${j.execute} ${j.arguments}`.trim(),
        };
      }
      case 'launchd': {
        const file = launchdPath(c, name);
        const r = await c.exec('launchctl', ['print', `gui/${c.uid}/${launchdLabel(name)}`]);
        if (r.code !== 0 || !c.fs.exists(file)) return base;
        let text = '';
        try { text = c.fs.readFile(file); } catch { /* the plist may have been removed by hand */ }
        const h = /<key>Hour<\/key><integer>(\d+)/.exec(text);
        const m = /<key>Minute<\/key><integer>(\d+)/.exec(text);
        return { ...base, installed: true, time: h && m ? `${String(h[1]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')}` : null, days: /Weekday/.test(text) ? 'weekdays' : 'daily' };
      }
      case 'systemd': {
        const b = unitBase(name);
        const t = await c.exec('systemctl', ['--user', 'is-enabled', `${b}.timer`]);
        if (t.code === 0) {
          const timerFile = path.posix.join(unitDir(c), `${b}.timer`);
          let text = '';
          try { text = c.fs.readFile(timerFile); } catch { /* ignore */ }
          const m = /OnCalendar=(?:Mon\.\.Fri )?\*-\*-\* (\d\d:\d\d)/.exec(text);
          return { ...base, installed: true, time: m ? m[1] : null, days: /Mon\.\.Fri/.test(text) ? 'weekdays' : 'daily' };
        }
        const cur = await c.exec('crontab', ['-l']);
        const line = cur.code === 0 ? cur.stdout.split(/\r?\n/).find((l) => l.trimEnd().endsWith(cronMarker(name))) : null;
        if (line) {
          const m = /^(\d+) (\d+) \* \* (\S+)/.exec(line);
          return { ...base, installed: true, kind: 'cron', label: KIND_LABEL.cron, time: m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : null, days: m && m[3] === '1-5' ? 'weekdays' : 'daily' };
        }
        return base;
      }
      default:
        return { ...base, error: 'Scheduling is not supported on this operating system.' };
    }
  } catch (e) {
    return { ...base, error: e.message };
  }
}

/** Delete the scheduled job. Returns { removed }. Safe to call when nothing is installed. */
export async function removeSchedule(nameIn = TASK_NAME, ctxIn = {}) {
  if (!NAME_RE.test(nameIn)) throw new SchedulerError('That task name is not allowed.');
  const name = nameIn;
  const c = makeCtx(ctxIn);
  switch (c.kind) {
    case 'task-scheduler': {
      const r = await c.exec('powershell.exe', powershellArgs(PS_REMOVE), { env: { JE_NAME: name } });
      if (r.code !== 0) throw failure('Windows Task Scheduler could not remove the task:', r);
      return { removed: /REMOVED/.test(r.stdout) };
    }
    case 'launchd': {
      const file = launchdPath(c, name);
      const existed = c.fs.exists(file);
      await c.exec('launchctl', ['bootout', `gui/${c.uid}/${launchdLabel(name)}`]);
      c.fs.rm(file);
      return { removed: existed };
    }
    case 'systemd': {
      const b = unitBase(name);
      const dir = unitDir(c);
      const had = c.fs.exists(path.posix.join(dir, `${b}.timer`));
      await c.exec('systemctl', ['--user', 'disable', '--now', `${b}.timer`]);
      c.fs.rm(path.posix.join(dir, `${b}.timer`));
      c.fs.rm(path.posix.join(dir, `${b}.service`));
      await c.exec('systemctl', ['--user', 'daemon-reload']);
      const cur = await c.exec('crontab', ['-l']);
      let cronHad = false;
      if (cur.code === 0 && cur.stdout.split(/\r?\n/).some((l) => l.trimEnd().endsWith(cronMarker(name)))) {
        cronHad = true;
        const w = await c.exec('crontab', ['-'], { input: updateCrontab(cur.stdout, name) });
        if (w.code !== 0) throw failure('crontab would not remove the job:', w);
      }
      return { removed: had || cronHad };
    }
    default:
      return { removed: false };
  }
}

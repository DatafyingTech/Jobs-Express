import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSpec, SchedulerError, windowsEnv, powershellArgs, PS_REGISTER, PS_QUERY, PS_REMOVE, launchdPlist, xmlEscape, launchdLabel,
  systemdUnits, systemdQuote, cronLine, shQuote, updateCrontab, cronMarker, unitBase, installSchedule, querySchedule, removeSchedule,
  daysFromMask, NAME_RE, taskNameFromEnv, schedulerKind,
} from '../lib/scheduler.mjs';

const spec = (over = {}) => ({
  name: 'JobsExpressDaily', time: '04:10', days: 'daily',
  nodePath: '/usr/bin/node', scriptPath: '/home/a b/Jobs Express/server.mjs', workDir: '/home/a b/Jobs Express', dataDir: '', limitMinutes: 120,
  ...over,
});
const winSpec = (over = {}) => spec({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\Users\\Pat Lee\\Jobs Express\\server.mjs', workDir: 'C:\\Users\\Pat Lee\\Jobs Express', ...over });

test('validateSpec accepts good input and rejects everything that could reach a command', () => {
  assert.equal(validateSpec(spec()).time, '04:10');
  for (const time of ['4:10', '24:00', '04:60', '04:10 ', '04:10;calc', '04:1', '', '04:10\n', '0410']) {
    assert.throws(() => validateSpec(spec({ time })), SchedulerError, `time ${JSON.stringify(time)}`);
  }
  for (const days of ['everyday', 'Mon', '', 'weekdays; x', 'daily\n']) assert.throws(() => validateSpec(spec({ days })), SchedulerError, days);
  for (const name of ['Other', 'JobsExpressDaily; calc', 'JobsExpressDaily-TEST-', 'JobsExpressDaily-TEST-a b', '*', 'JobsExpressDaily*', 'jobsexpressdaily', '..\\x']) {
    assert.throws(() => validateSpec(spec({ name })), SchedulerError, name);
  }
  for (const bad of ['relative/node', '/path/with"quote', '/path/with\nnewline', '', '/x\u0000y']) {
    assert.throws(() => validateSpec(spec({ nodePath: bad })), SchedulerError, JSON.stringify(bad));
    assert.throws(() => validateSpec(spec({ scriptPath: bad })), SchedulerError);
    assert.throws(() => validateSpec(spec({ workDir: bad })), SchedulerError);
  }
  for (const n of [0, 9, 601, 1.5, 'x']) assert.throws(() => validateSpec(spec({ limitMinutes: n })), SchedulerError, String(n));
  assert.ok(NAME_RE.test('JobsExpressDaily-TEST-ab12cd'));
  assert.equal(taskNameFromEnv({ CJA_SCHEDULE_TASK_NAME: 'JobsExpressDaily-TEST-abc123' }), 'JobsExpressDaily-TEST-abc123');
  assert.equal(taskNameFromEnv({ CJA_SCHEDULE_TASK_NAME: 'Evil' }), 'JobsExpressDaily');
  assert.equal(schedulerKind('win32'), 'task-scheduler');
  assert.equal(schedulerKind('darwin'), 'launchd');
  assert.equal(schedulerKind('linux'), 'systemd');
  assert.equal(schedulerKind('freebsd'), 'unsupported');
});

test('Windows: the PowerShell is a constant and every value travels in the environment', () => {
  const env = windowsEnv(winSpec({ time: '23:05', days: 'weekdays', dataDir: 'D:\\My Data' }));
  assert.deepEqual(Object.keys(env).sort(), ['JE_DATADIR', 'JE_DAYS', 'JE_LIMIT_MIN', 'JE_NAME', 'JE_NODE', 'JE_SCRIPT', 'JE_TIME', 'JE_WORKDIR']);
  assert.equal(env.JE_TIME, '23:05');
  assert.equal(env.JE_NODE, 'C:\\Program Files\\nodejs\\node.exe');
  for (const k of ['JE_NODE', 'JE_SCRIPT', 'JE_WORKDIR', 'JE_DATADIR', 'JE_NAME', 'JE_TIME']) {
    assert.ok(!PS_REGISTER.includes(env[k]), `value leaked into the script: ${env[k]}`);
  }
  // The settings the task needs, spelled out.
  for (const needle of ['-StartWhenAvailable', '-WakeToRun', '-ExecutionTimeLimit', '-LogonType Interactive', '-RunLevel Limited', 'Register-ScheduledTask', '--scheduled-run', '-MultipleInstances IgnoreNew', '-Force']) {
    assert.ok(PS_REGISTER.includes(needle), needle);
  }
  assert.ok(PS_REMOVE.includes('Unregister-ScheduledTask -TaskName $env:JE_NAME'));
  assert.ok(PS_QUERY.includes('Get-ScheduledTask -TaskName $env:JE_NAME'));
  // Encoded form round-trips, so no quoting problems on the command line.
  const args = powershellArgs(PS_REGISTER);
  assert.equal(args[args.length - 2], '-EncodedCommand');
  assert.equal(Buffer.from(args[args.length - 1], 'base64').toString('utf16le'), PS_REGISTER);
  assert.ok(args.includes('-NonInteractive') && args.includes('-NoProfile'));
});

test('Windows install, query and remove call PowerShell with the right environment (fake runner)', async () => {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, env: opts?.env });
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
    if (script === PS_REGISTER) return { code: 0, stdout: 'OK\r\n', stderr: '' };
    if (script === PS_QUERY) return { code: 0, stderr: '', stdout: JSON.stringify({ exists: true, state: 'Ready', nextRun: '2026-10-12T04:10:00.0000000+00:00', lastRun: null, lastResult: 267011, start: '2026-10-11T23:05:00', daysOfWeek: 62, startWhenAvailable: true, wakeToRun: true, execute: 'C:\\n\\node.exe', arguments: '"C:\\s\\server.mjs" --scheduled-run' }) };
    if (script === PS_REMOVE) return { code: 0, stdout: 'REMOVED', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected script' };
  };
  const ctx = { platform: 'win32', exec };
  const installed = await installSchedule(winSpec({ name: 'JobsExpressDaily-TEST-abc123', time: '23:05' }), ctx);
  assert.equal(installed.kind, 'task-scheduler');
  assert.equal(calls[0].file, 'powershell.exe');
  assert.equal(calls[0].env.JE_NAME, 'JobsExpressDaily-TEST-abc123');
  const q = await querySchedule('JobsExpressDaily-TEST-abc123', ctx);
  assert.equal(q.installed, true);
  assert.equal(q.time, '23:05');
  assert.equal(q.days, 'weekdays');
  assert.equal(q.startWhenAvailable, true);
  assert.equal(calls[1].env.JE_NAME, 'JobsExpressDaily-TEST-abc123');
  assert.deepEqual(await removeSchedule('JobsExpressDaily-TEST-abc123', ctx), { removed: true });
  // A refused task becomes a SchedulerError with a plain sentence.
  const failing = { platform: 'win32', exec: async () => ({ code: 1, stdout: '', stderr: 'Access is denied' }) };
  await assert.rejects(() => installSchedule(winSpec(), failing), /Access is denied/);
  assert.equal((await querySchedule('JobsExpressDaily', { platform: 'win32', exec: async () => ({ code: 0, stdout: '{"exists":false}', stderr: '' }) })).installed, false);
  assert.equal(daysFromMask(null), 'daily');
  await assert.rejects(() => removeSchedule('Evil', ctx), SchedulerError);
});

test('macOS plist: calendar interval, argument array, XML escaping', () => {
  const plist = launchdPlist(spec({ nodePath: '/opt/Node & Co/node', scriptPath: '/Users/a<b>/Jobs Express/server.mjs', workDir: '/Users/a<b>/Jobs Express', time: '07:05' }));
  assert.match(plist, /<key>Label<\/key><string>com\.jobsexpress\.JobsExpressDaily<\/string>/);
  assert.match(plist, /<string>\/opt\/Node &amp; Co\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/a&lt;b&gt;\/Jobs Express\/server\.mjs<\/string>/);
  assert.match(plist, /<string>--scheduled-run<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>7<\/integer><key>Minute<\/key><integer>5<\/integer>/);
  assert.ok(!/Weekday/.test(plist));
  assert.ok(!plist.includes('Node & Co'), 'raw ampersand must be escaped');
  const wk = launchdPlist(spec({ days: 'weekdays' }));
  assert.equal((wk.match(/<key>Weekday<\/key>/g) || []).length, 5);
  assert.match(wk, /<key>Weekday<\/key><integer>1<\/integer>/);
  assert.match(wk, /<key>Weekday<\/key><integer>5<\/integer>/);
  assert.equal(xmlEscape(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
  assert.match(launchdPlist(spec({ dataDir: '/data dir' })), /<string>--data-dir<\/string><string>\/data dir<\/string>/);
});

test('macOS apply: writes the plist, bootstraps into the user domain, and boots out on remove', async () => {
  const files = new Map();
  const calls = [];
  const ctx = {
    platform: 'darwin', home: '/Users/pat', uid: 501,
    exec: async (file, args) => { calls.push([file, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    fs: { writeFile: (p, t) => files.set(p, t), readFile: (p) => files.get(p), rm: (p) => files.delete(p), exists: (p) => files.has(p) },
  };
  await installSchedule(spec(), ctx);
  const plistPath = '/Users/pat/Library/LaunchAgents/com.jobsexpress.JobsExpressDaily.plist';
  assert.ok(files.has(plistPath));
  assert.deepEqual(calls.at(-1), ['launchctl', 'bootstrap', 'gui/501', plistPath]);
  assert.deepEqual(calls[0], ['launchctl', 'bootout', 'gui/501/com.jobsexpress.JobsExpressDaily']);
  const q = await querySchedule('JobsExpressDaily', ctx);
  assert.equal(q.installed, true);
  assert.equal(q.time, '04:10');
  assert.deepEqual(await removeSchedule('JobsExpressDaily', ctx), { removed: true });
  assert.ok(!files.has(plistPath));
  assert.equal(launchdLabel('JobsExpressDaily-TEST-x1y2z3'), 'com.jobsexpress.JobsExpressDaily-TEST-x1y2z3');
});

test('systemd units: Persistent timer, quoting of spaces, percent and dollar signs', () => {
  const u = systemdUnits(spec({ scriptPath: '/home/a b/100%/$x/server.mjs', workDir: '/home/a b/100%', time: '06:30', days: 'weekdays' }));
  assert.equal(u.base, 'jobs-express-daily');
  assert.match(u.timer, /OnCalendar=Mon\.\.Fri \*-\*-\* 06:30:00/);
  assert.match(u.timer, /Persistent=true/);
  assert.match(u.timer, /WantedBy=timers\.target/);
  assert.match(u.service, /Type=oneshot/);
  assert.match(u.service, /ExecStart="\/usr\/bin\/node" "\/home\/a b\/100%%\/\$\$x\/server\.mjs" "--scheduled-run"/);
  assert.match(u.service, /WorkingDirectory=\/home\/a b\/100%%/);
  assert.match(systemdUnits(spec()).timer, /OnCalendar=\*-\*-\* 04:10:00/);
  assert.equal(systemdQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(unitBase('JobsExpressDaily-TEST-abc123'), 'jobs-express-daily-test-abc123');
});

test('cron fallback: single-quoted paths, marker comment, and in-place replacement', () => {
  const line = cronLine(spec({ scriptPath: "/home/o'neil/Jobs Express/server.mjs", workDir: "/home/o'neil/Jobs Express", days: 'weekdays', time: '05:07' }));
  assert.match(line, /^7 5 \* \* 1-5 cd '\/home\/o'\\''neil\/Jobs Express' && '\/usr\/bin\/node' '\/home\/o'\\''neil\/Jobs Express\/server\.mjs' '--scheduled-run'/);
  assert.ok(line.endsWith(cronMarker('JobsExpressDaily')));
  assert.equal(shQuote("it's"), "'it'\\''s'");
  const existing = '0 1 * * * backup.sh\n3 3 * * * old ' + cronMarker('JobsExpressDaily') + '\n';
  const next = updateCrontab(existing, 'JobsExpressDaily', line);
  assert.equal(next.split('\n').filter(Boolean).length, 2);
  assert.ok(next.includes('backup.sh'));
  assert.ok(!next.includes('old '));
  assert.equal(updateCrontab(existing, 'JobsExpressDaily'), '0 1 * * * backup.sh\n');
  assert.equal(updateCrontab('', 'JobsExpressDaily'), '');
});

test('Linux apply: systemd when available, cron when systemctl --user is not', async () => {
  const files = new Map();
  const calls = [];
  const mk = (systemd) => ({
    platform: 'linux', home: '/home/pat',
    exec: async (file, args, opts) => {
      calls.push([file, ...args]);
      if (file === 'systemctl' && !systemd) return { code: 1, stdout: '', stderr: 'Failed to connect to bus' };
      if (file === 'crontab' && args[0] === '-l') return { code: 0, stdout: '0 1 * * * keep.sh\n', stderr: '' };
      if (file === 'crontab' && args[0] === '-') { files.set('crontab', opts.input); return { code: 0, stdout: '', stderr: '' }; }
      if (file === 'systemctl' && args.includes('is-enabled')) return { code: files.has('/home/pat/.config/systemd/user/jobs-express-daily.timer') ? 0 : 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    fs: { writeFile: (p, t) => files.set(p, t), readFile: (p) => files.get(p), rm: (p) => files.delete(p), exists: (p) => files.has(p) },
  });
  const sys = await installSchedule(spec(), mk(true));
  assert.equal(sys.kind, 'systemd');
  assert.ok(files.has('/home/pat/.config/systemd/user/jobs-express-daily.timer'));
  assert.ok(calls.some((c) => c.join(' ') === 'systemctl --user enable --now jobs-express-daily.timer'));
  const q = await querySchedule('JobsExpressDaily', mk(true));
  assert.equal(q.installed, true);
  assert.equal(q.time, '04:10');
  assert.deepEqual(await removeSchedule('JobsExpressDaily', mk(true)), { removed: true });
  assert.ok(!files.has('/home/pat/.config/systemd/user/jobs-express-daily.timer'));

  files.clear();
  const cron = await installSchedule(spec(), mk(false));
  assert.equal(cron.kind, 'cron');
  assert.match(files.get('crontab'), /keep\.sh/);
  assert.match(files.get('crontab'), /# JobsExpress:JobsExpressDaily/);
  assert.ok(![...files.keys()].some((k) => k.endsWith('.timer')), 'failed systemd files are cleaned up');
});

test('an unsupported platform refuses politely', async () => {
  await assert.rejects(() => installSchedule(spec(), { platform: 'freebsd' }), /not supported/);
  assert.equal((await querySchedule('JobsExpressDaily', { platform: 'freebsd' })).installed, false);
  assert.deepEqual(await removeSchedule('JobsExpressDaily', { platform: 'freebsd' }), { removed: false });
});

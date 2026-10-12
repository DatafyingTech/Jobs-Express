// Settings, Daily schedule: set it up once and it runs itself once a day.
import { h, mount, relTime } from './dom.js';
import { icon } from './icons.js';
import { S, on, loadScheduleInfo } from './state.js';
import { GET, POST, PUT, DELETE } from './api.js';
import { button, guard, toast, field, segmented, confirmDialog, emptyState } from './components.js';

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${WEEKDAY[d.getDay()].slice(0, 3)} ${MONTH[d.getMonth()]} ${d.getDate()}`;
}

const STATUS_CLASS = { finished: 'submitted', stopped: 'held', failed: 'failed', skipped: 'skipped' };
const STATUS_TEXT = { finished: 'Finished', stopped: 'Stopped early', failed: 'Did not run', skipped: 'Skipped' };

function countsText(c = {}) {
  const bits = [];
  if (c.submitted) bits.push(`${c.submitted} submitted`);
  if (c.ready) bits.push(`${c.ready} ready to review`);
  if (c.held) bits.push(`${c.held} held`);
  if (c.skipped) bits.push(`${c.skipped} skipped`);
  return bits.length ? bits.join(' · ') : 'Nothing new matched';
}

export function digestChip(status) {
  return h('span', { class: `status ${STATUS_CLASS[status] || 'skipped'}` }, STATUS_TEXT[status] || status);
}

/** The whole Daily schedule tab: form, status, caveats and the digest list. */
export function schedulePanels() {
  const formHost = h('section', { class: 'panel', 'aria-label': 'Daily schedule' });
  const statusHost = h('section', { class: 'panel', 'aria-label': 'Schedule status' });
  const digestHost = h('section', { class: 'panel', 'aria-label': 'Daily digests' });
  const f = { time: '04:10', days: 'daily', mode: 'practice', liveAccepted: false, agents: 1, maxApps: 10, freshHours: 30, maxMinutes: 90 };
  let formReady = false;
  const open = new Set(); // digests the person expanded

  // ---------- the form ----------
  function drawForm() {
    const p = S.schedule;
    if (!p) {
      mount(formHost, h('div', { class: 'panel-head' }, h('h2', {}, 'Daily schedule')), h('div', { class: 'fieldset' }, h('div', { class: 'skeleton', style: { height: '180px' } })));
      return;
    }
    if (!formReady) { Object.assign(f, p.schedule); formReady = true; }
    const L = p.limits;
    const unsupported = !p.os.supported;

    const timeEl = h('input', { class: 'input', type: 'time', value: f.time, step: '60', required: true, 'aria-label': 'Time of day' });
    timeEl.addEventListener('input', () => { f.time = timeEl.value; });

    const num = (key, hint, { min, max }) => {
      const el = h('input', { class: 'input', type: 'text', inputmode: 'numeric', value: String(f[key]) });
      el.addEventListener('input', () => { const d = el.value.replace(/[^\d]/g, ''); f[key] = d === '' ? '' : Number(d); });
      el.addEventListener('blur', () => { el.value = String(f[key]); });
      return { el, hint: `${hint} ${min} to ${max}.` };
    };
    const apps = num('maxApps', 'The most applications in one run. It is a ceiling, never a target.', L.maxApps);
    const fresh = num('freshHours', 'Only roles posted in the last N hours. No quota: it applies to every honest fit and never pads the run.', L.freshHours);
    const cap = num('maxMinutes', 'The run is stopped at this point and what finished is kept.', L.maxMinutes);

    const liveInput = h('input', { type: 'checkbox', checked: f.liveAccepted, onChange: (e) => { f.liveAccepted = e.target.checked; } });
    const liveBox = h('label', { class: 'check live-accept' },
      liveInput,
      h('span', {}, h('b', {}, p.liveText), h('span', { class: 'hint', style: { display: 'block', marginTop: '4px' } }, 'Real applications go to real employers while you are away, with nobody reading them first. You cannot take a submitted application back.')));
    const liveWrap = h('div', { class: 'span-2', hidden: f.mode !== 'live' }, liveBox);
    const modeDesc = h('p', { class: 'hint' }, f.mode === 'live' ? 'Live submits each application it is sure about.' : 'Practice fills in the forms and stops before Submit. Check the digest, then decide.');
    const modeSeg = segmented([{ value: 'practice', label: 'Practice' }, { value: 'live', label: 'Live' }], f.mode, (v) => {
      f.mode = v;
      // Going back to Practice forgets the acceptance, on screen as well as in the form.
      if (v !== 'live') { f.liveAccepted = false; liveInput.checked = false; }
      liveWrap.hidden = v !== 'live';
      modeDesc.textContent = v === 'live' ? 'Live submits each application it is sure about.' : 'Practice fills in the forms and stops before Submit. Check the digest, then decide.';
    }, { label: 'Mode' });
    const daysSeg = segmented([{ value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }], f.days, (v) => { f.days = v; }, { label: 'Days' });
    const agentSeg = segmented([1, 2, 3].map((n) => ({ value: n, label: String(n) })), f.agents, (v) => { f.agents = v; }, { label: 'Number of agents' });

    const enabled = p.schedule.enabled;
    mount(formHost,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Daily schedule'), h('span', { class: `status ${enabled ? 'submitted' : 'skipped'}` }, enabled ? 'On' : 'Off')),
      h('div', { class: 'fieldset' },
        h('p', { class: 'lede' }, 'Set it up once and it runs itself. Each day the app starts Chrome if it is closed, looks only at roles posted recently, applies to every honest fit, and leaves a digest of what it did. Anything it cannot answer honestly lands in Needs your input.'),
        unsupported ? h('div', { class: 'inline-alert bad', style: { marginBottom: '16px' } }, icon('alert', 18), h('div', {}, 'Scheduling is not supported on this operating system. You can still start runs from the Dashboard.')) : null,
        h('div', { class: 'grid two' },
          field('Time of day', timeEl, { hint: 'Any time you like, in this computer\'s clock. Early morning catches roles posted overnight.' }),
          field('Days', daysSeg),
          field('Mode', h('div', {}, modeSeg, modeDesc), { span: true }),
          liveWrap,
          field('Agents', h('div', {}, agentSeg, h('p', { class: 'hint', style: { marginTop: '8px' } }, 'Start with 1. More agents share one Chrome window and make LinkedIn more likely to notice.')), { span: true }),
          field('Applications per run', apps.el, { hint: apps.hint }),
          field('Freshness window (hours)', fresh.el, { hint: fresh.hint }),
          field('Time cap (minutes)', cap.el, { hint: cap.hint }))),
      h('div', { class: 'fieldset sched-actions' },
        h('div', { class: 'page-actions' },
          button({ label: 'Save schedule', icon: 'check', kind: 'primary', disabled: unsupported, onClick: () => guard(save) }),
          button({ label: 'Run a test now', icon: 'play', onClick: () => guard(testNow) }),
          enabled ? button({ label: 'Remove schedule', icon: 'trash', kind: 'danger', onClick: () => guard(removeIt) }) : null),
        h('p', { class: 'hint', style: { marginTop: '12px' } }, `A test run is always Practice, up to ${p.testLimits.maxApps} applications, stopped after ${p.testLimits.maxMinutes} minutes. It uses the same steps as the daily run.`)));
  }

  async function save() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(f.time))) throw new Error('Pick a time of day first.');
    const r = await PUT('/api/schedule', { ...f });
    S.schedule = r;
    formReady = false;
    await refreshInfo();
    toast(`Schedule saved. ${r.summary.nextRunText ? 'Next run ' + r.summary.nextRunText + '.' : ''}`);
    drawAll();
  }

  async function removeIt() {
    const ok = await confirmDialog({
      title: 'Remove the daily schedule?',
      body: [h('p', { class: 'muted' }, 'The scheduled job is deleted from your computer. Your settings, digests and applications stay. You can set it up again any time.')],
      confirmLabel: 'Remove schedule', confirmIcon: 'trash', kind: 'danger',
    });
    if (!ok) return;
    S.schedule = await DELETE('/api/schedule');
    formReady = false;
    await refreshInfo();
    toast('Schedule removed.');
    drawAll();
  }

  // ---------- test run dialog ----------
  async function testNow() {
    S.scheduleLines = [];
    const body = h('div', { class: 'd-body' });
    const foot = h('div', { class: 'd-foot' });
    const dlg = h('dialog', { 'aria-labelledby': 'test-h', class: 'wide' }, body, foot);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    const close = button({ label: 'Close', onClick: () => dlg.close() });
    const term = (lines) => h('div', { class: 'term' }, h('div', { class: 'term-body', role: 'log', 'aria-live': 'polite', tabindex: '0' }, ...lines.map((l) => h('div', {}, l))));

    mount(body, h('h2', { id: 'test-h' }, 'Run a test now'), h('div', { class: 'row-center' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'muted' }, 'Checking what would happen...')));
    mount(foot, close);
    dlg.showModal();

    let plan;
    try {
      plan = (await POST('/api/schedule/preview', { test: true })).plan;
    } catch (e) {
      mount(body, h('h2', { id: 'test-h' }, 'Run a test now'), h('div', { class: 'inline-alert bad' }, icon('alert', 18), h('div', {}, e.message)));
      return;
    }

    const showPreview = () => {
      mount(body,
        h('h2', { id: 'test-h' }, 'Run a test now'),
        h('p', { class: 'muted' }, 'This is what a run would do right now. It is always Practice, so nothing is submitted.'),
        term(plan.lines),
        plan.blockers.length
          ? h('div', { class: 'inline-alert bad' }, icon('alert', 18), h('div', {}, h('b', {}, 'It cannot start yet'), h('ul', { class: 'plain' }, ...plan.blockers.map((b) => h('li', {}, h('span', {}, b.what), ' ', h('span', { class: 'muted' }, b.hint))))))
          : h('p', { class: 'hint' }, 'It will start Chrome if it is closed and use your signed-in sessions. Leave that Chrome window alone until it finishes. You can watch it on the Dashboard.'));
      mount(foot, close, button({ label: 'Start the test run', icon: 'play', kind: 'primary', disabled: !plan.ok, onClick: () => guard(start) }));
    };

    async function start() {
      S.scheduleLines = [];
      await POST('/api/schedule/test', { confirm: true });
      const live = h('div', {});
      const draw = () => mount(live, term(S.scheduleLines.length ? S.scheduleLines : ['Starting...']));
      mount(body, h('h2', { id: 'test-h' }, 'Test run in progress'), h('p', { class: 'muted' }, 'You can close this window. The run keeps going, and the Dashboard shows the agents live.'), live);
      mount(foot, button({ label: 'Go to the Dashboard', onClick: () => { dlg.close(); location.hash = '#/'; } }), close);
      draw();
      const tick = () => { draw(); const t = live.querySelector('.term-body'); if (t) t.scrollTop = t.scrollHeight; };
      on('schedule-line', tick);
      on('schedule-done', (e) => {
        tick();
        const ok = e.status === 'finished' || e.status === 'stopped';
        mount(live, term(S.scheduleLines), h('div', { class: `inline-alert ${ok ? '' : 'bad'}`, style: { marginTop: '12px' } }, icon(ok ? 'check' : 'alert', 18),
          h('div', {}, ok ? 'The test run finished. Open the digest below to see what it did.' : `The test run did not complete. ${e.error || ''} ${e.hint || ''}`.trim())));
        refreshInfo().then(drawAll);
      });
    }
    showPreview();
  }

  // ---------- status ----------
  function drawStatus() {
    const p = S.schedule;
    if (!p) { mount(statusHost); statusHost.hidden = true; return; }
    statusHost.hidden = false;
    const sys = p.system;
    const rows = [];
    rows.push(['Scheduler', p.os.label]);
    if (sys) rows.push(['Registered', sys.installed ? 'Yes' : 'No']);
    rows.push(['Next run', p.summary.nextRunText || (p.schedule.enabled ? '' : 'Not scheduled')]);
    if (sys?.installed && sys.nextRun && p.os.kind === 'task-scheduler') rows.push(['Windows says', new Date(sys.nextRun).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })]);
    const last = p.summary.lastRun;
    const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
    rows.push(['Last run', last ? `${cap(p.summary.lastRunText.replace(/^Last run:? ?/, '')) || STATUS_TEXT[last.status]} (${relTime(last.finishedAt || last.startedAt)})` : 'No runs yet']);
    const warn = [];
    if (sys && p.schedule.enabled && !sys.installed) warn.push('The schedule is saved but the job is missing from the operating system. Press Save schedule to put it back.');
    if (sys?.stale) warn.push('The scheduled job points at a different copy of Node.js or of this folder. Press Save schedule to update it.');
    if (sys?.error) warn.push(`Could not read the scheduler: ${sys.error}`);
    mount(statusHost,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Status'), button({ label: 'Refresh', icon: 'refresh', size: 'sm', onClick: () => guard(async () => { await refreshInfo(); drawAll(); }) })),
      h('div', { class: 'fieldset' },
        ...warn.map((w) => h('div', { class: 'inline-alert', style: { marginBottom: '12px' } }, icon('alert', 18), h('div', {}, w))),
        h('dl', { class: 'kv', style: { margin: 0 } }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))));
  }

  const caveats = () => {
    const kind = S.schedule?.os.kind;
    const wake = kind === 'task-scheduler' ? 'If the computer was off or asleep at that time, the run starts when it wakes (Windows "run as soon as possible after a missed start" is switched on).'
      : kind === 'launchd' ? 'If the Mac was asleep at that time, launchd runs the job when it wakes. A Mac that is shut down does not catch up.'
        : kind === 'systemd' ? 'If the computer was off at that time, the timer runs the job at the next start (Persistent=true). If systemd user timers are unavailable it falls back to cron, which does not catch up.'
          : 'If the computer was off at that time, the run is skipped until the next scheduled time.';
    const item = (ic, strong, text) => h('li', {}, icon(ic, 18), h('span', {}, h('b', {}, strong), ' ', text));
    return h('section', { class: 'notice calm', 'aria-labelledby': 'sched-req' },
      h('div', {},
        h('h2', { id: 'sched-req' }, icon('info', 18), 'What has to be true for it to run'),
        h('ul', {},
          item('monitor', 'The computer is on and you are signed in to it.', 'A locked screen is fine. Signed out, shut down, or no one logged in is not: the browser needs your desktop session.'),
          item('user', 'Chrome has the Claude extension signed in, and LinkedIn is signed in.', 'If either is missing, the run stops before it starts and the digest tells you what to fix. It never signs in for you.'),
          item('clock', 'A missed run starts when the computer wakes.', wake),
          item('alert', 'It runs without you watching.', 'Start with Practice, read a few digests, and only then switch to Live. Anything it is unsure about is held, not guessed.'),
          item('folder', 'If you move this folder or update Node.js, press Save schedule again.', 'The job remembers where they were. The Status box above warns you when it is out of date.'))));
  };

  // ---------- digests ----------
  function drawDigests() {
    const items = S.schedule?.digests || [];
    mount(digestHost,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Daily digests'), h('span', { class: 'faint' }, items.length ? `latest ${items.length}` : '')),
      items.length
        ? items.map(digestRow)
        : emptyState({ iconName: 'inbox', title: 'No digests yet', body: 'After each scheduled run, a short summary lands here: what was submitted, what is ready for you to review, and what is waiting on an answer. Press "Run a test now" to see one.' }));
  }

  function digestRow(d) {
    const host = h('div', { class: 'digest' });
    const draw = async () => {
      const isOpen = open.has(d.name);
      const head = h('div', { class: 'digest-head' },
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'co' }, dayLabel(d.startedAt) || d.name, d.test ? h('span', { class: 'tag', style: { marginLeft: '8px' } }, 'Test') : null),
          h('div', { class: 'ro' }, d.status === 'failed' || d.status === 'skipped' ? (d.error || 'See the details') : `${countsText(d.counts)} · ${d.mode === 'live' ? 'Live' : 'Practice'}`)),
        h('div', { class: 'digest-end' }, digestChip(d.status),
          button({ label: isOpen ? 'Hide' : 'View', size: 'sm', kind: 'ghost', icon: isOpen ? 'chevronU' : 'chevronD', onClick: async () => { if (isOpen) open.delete(d.name); else open.add(d.name); await draw(); } })));
      let detail = null;
      if (isOpen) {
        detail = h('div', { class: 'digest-detail' }, h('span', { class: 'faint' }, 'Loading...'));
        mount(host, head, detail);
        try {
          detail = digestDetail(await GET(`/api/digest?name=${encodeURIComponent(d.name)}`));
        } catch (e) {
          detail = h('div', { class: 'digest-detail' }, h('div', { class: 'inline-alert bad' }, icon('alert', 18), h('div', {}, e.message)));
        }
      }
      mount(host, head, detail);
    };
    draw();
    return host;
  }

  function digestDetail({ digest: d }) {
    const sect = (title, rows, render) => rows.length ? h('div', { class: 'digest-sect' }, h('h3', {}, title), h('ul', {}, ...rows.map(render))) : null;
    const line = (r) => h('li', {}, h('b', {}, r.company), r.role ? `, ${r.role}` : '', r.pay && r.pay !== 'not listed' ? ` · ${r.pay}` : '', r.url ? [' ', h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open')] : null, r.note ? h('div', { class: 'hint' }, r.note) : null);
    return h('div', { class: 'digest-detail' },
      d.status === 'failed' || d.status === 'skipped'
        ? h('div', { class: 'inline-alert bad' }, icon('alert', 18), h('div', {}, h('div', {}, d.error), d.hint ? h('div', { class: 'muted', style: { marginTop: '4px' } }, 'How to fix it: ' + d.hint) : null))
        : h('p', { class: 'muted' }, `${d.test ? 'Test run. ' : ''}${d.agents} agent${d.agents === 1 ? '' : 's'}, roles from the last ${d.freshHours} hours, up to ${d.maxApps} applications. ${d.status === 'stopped' ? `Stopped early: ${d.error}` : ''}`),
      sect('Submitted', d.items.filter((i) => i.status === 'submitted'), line),
      sect('Ready to review', d.items.filter((i) => i.status === 'ready'), line),
      sect('Waiting on you', d.held, (r) => h('li', {}, h('b', {}, r.company), r.role ? `, ${r.role}` : '', ': ', r.question, r.url ? [' ', h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open')] : null)),
      sect('Skipped', d.items.filter((i) => i.status === 'skipped'), line),
      !d.items.length && !d.held.length && d.status === 'finished' ? h('p', { class: 'muted' }, 'Nothing new matched in that window, so nothing was applied to. That is a normal result.') : null);
  }

  async function refreshInfo() {
    await loadScheduleInfo({ system: true });
  }
  function drawAll() { drawForm(); drawStatus(); drawDigests(); }

  on('schedule', () => { if (!formReady) drawForm(); drawStatus(); drawDigests(); });
  drawAll();
  loadScheduleInfo({ system: true }).catch((e) => toast(e.message, 'bad'));

  return h('div', { class: 'stack' }, formHost, statusHost, caveats(), digestHost);
}

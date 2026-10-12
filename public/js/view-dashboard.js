import { h, mount, relTime, clock, formatDuration } from './dom.js';
import { icon } from './icons.js';
import { S, on, blockers, loadApps, loadHeld, loadPreflight, loadInfo } from './state.js';
import { POST } from './api.js';
import { button, guard, toast, statusChip, emptyState, segmented, dataWarnings } from './components.js';
import { go } from './router.js';

const MODE_DESC = {
  practice: 'Agents fill in every form and stop before the final Submit. Each one lands in your table as Ready to review. Nothing is sent to an employer.',
  live: 'Agents submit each application once every field has been read back and checked. These go to real employers, in your name.',
};

let chosen = null; // { mode, agents } survives re-renders within the session

export function dashboardView() {
  const settings = S.info.profile.settings;
  // Every visit starts in Practice. Live is always a deliberate choice, never a leftover from last time.
  chosen ??= { mode: 'practice', agents: settings.agents || 1 };
  let timer = null;

  // --- run panel -------------------------------------------------------------------------
  const runHost = h('section', { class: 'panel run-panel', 'aria-label': 'Run controls' });

  const confirmLive = () => new Promise((resolve) => {
    const dlg = h('dialog', { 'aria-labelledby': 'live-h' },
      h('div', { class: 'd-body' },
        h('h2', { id: 'live-h' }, 'Start a live run?'),
        h('p', { class: 'muted' }, `Up to ${S.info.profile.prefs.perRun} real application${S.info.profile.prefs.perRun === 1 ? '' : 's'} will be sent from your accounts, using ${chosen.agents} agent${chosen.agents > 1 ? 's' : ''}. You cannot take a submitted application back.`),
        h('p', { class: 'muted' }, 'Have you run Practice mode first and looked over what it filled in?'),
      ),
      h('div', { class: 'd-foot' },
        button({ label: 'Cancel', onClick: () => dlg.close('no') }),
        button({ label: 'Start live run', icon: 'alert', kind: 'primary', onClick: () => dlg.close('yes') }),
      ),
    );
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); dlg.remove(); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('no'); });
    document.body.append(dlg);
    dlg.showModal();
  });

  async function start(task = 'search') {
    if (chosen.mode === 'live' && !(await confirmLive())) return;
    await guard(async () => {
      const r = await POST('/api/run/start', { mode: chosen.mode, agents: chosen.agents, task, confirmLive: chosen.mode === 'live', demoFast: new URLSearchParams(location.search).get('fast') === '1' });
      S.run = r.run;
      toast(chosen.mode === 'live' ? 'Live run started.' : 'Practice run started.');
      drawRun();
      logApi.reset();
    });
  }

  const stop = () => guard(async () => { const r = await POST('/api/run/stop'); S.run = r.run; drawRun(); });

  function drawRun() {
    const run = S.run;
    const running = run.status === 'running';
    const blk = blockers();
    const perRun = S.info.profile.prefs.perRun;
    runHost.classList.toggle('live', !running && chosen.mode === 'live');

    let controls;
    if (running) {
      const started = new Date(run.startedAt).getTime();
      controls = h('div', { class: 'run-controls' },
        h('div', { class: 'run-state' },
          h('span', { class: 'live-dot on' }),
          h('h2', {}, run.mode === 'live' ? 'Live run in progress' : 'Practice run in progress'),
          h('span', { class: 'faint num', id: 'elapsed' }, formatDuration(Date.now() - started)),
        ),
        h('div', { class: 'run-state' }, ...run.agents.map((a) => h('span', { class: 'agent-pill' }, `Agent ${a.number}`, h('span', { class: 'faint num' }, `${a.turns} actions`)))),
        h('div', { class: 'muted' }, countLine(run.counts)),
        h('p', { class: 'hint' }, 'Keep the Chrome window open and leave that profile alone until this finishes.'),
      );
    } else {
      const modeSeg = segmented([{ value: 'practice', label: 'Practice' }, { value: 'live', label: 'Live' }], chosen.mode, (v) => { chosen.mode = v; modeDesc.textContent = MODE_DESC[v]; runHost.classList.toggle('live', v === 'live'); drawCta(); }, { label: 'Mode' });
      const modeDesc = h('p', { class: 'desc' }, MODE_DESC[chosen.mode]);
      const agentSeg = segmented([1, 2, 3].map((n) => ({ value: n, label: String(n) })), chosen.agents, (v) => { chosen.agents = v; agentDesc.textContent = agentText(v); drawCta(); }, { label: 'Number of agents' });
      const agentDesc = h('p', { class: 'desc' }, agentText(chosen.agents));
      controls = h('div', { class: 'run-controls' },
        h('div', { class: 'run-state reserve' }, h('span', { class: 'live-dot off' }), h('span', { class: 'muted' }, run.status !== 'idle' ? lastRunText(run) : 'No runs yet. Start with Practice.')),
        h('div', { class: 'control-row' }, h('div', { class: 'label' }, 'Mode'), h('div', {}, modeSeg, modeDesc)),
        h('div', { class: 'control-row' }, h('div', { class: 'label' }, 'Agents'), h('div', {}, agentSeg, agentDesc)),
        blk.length ? h('div', { class: 'blockers', role: 'status' }, h('b', {}, 'Before you can start'), h('ul', {}, ...blk.map((b) => h('li', {}, h('span', {}, b.text), h('a', { href: b.href }, b.link))))) : null,
      );
    }

    const cta = h('div', { class: 'run-cta' });
    function drawCta() {
      if (running) {
        mount(cta, button({ label: 'Stop', icon: 'stop', kind: 'danger', size: 'lg', onClick: stop }), h('small', {}, 'Stops every agent now. Anything already submitted stays submitted.'));
        return;
      }
      const startBtn = button({ label: 'Start applying', icon: 'play', kind: 'primary', size: 'lg', disabled: blk.length > 0, onClick: () => start('search') });
      mount(cta,
        chosen.mode === 'live' ? h('div', { class: 'live-flag' }, icon('alert', 16), 'Live mode: real applications') : null,
        startBtn,
        h('small', {}, blk.length ? 'Finish the items on the left to start.' : chosen.mode === 'live' ? `Live · ${chosen.agents} agent${chosen.agents > 1 ? 's' : ''} · up to ${perRun}` : `Practice · ${chosen.agents} agent${chosen.agents > 1 ? 's' : ''} · up to ${perRun} applications`),
        S.retryable > 0 ? button({ label: `Re-run ${S.retryable} answered held`, icon: 'refresh', size: 'sm', disabled: blk.length > 0, onClick: () => start('held') }) : null,
      );
    }
    drawCta();
    mount(runHost, controls, cta);
  }

  function countLine(c) {
    return `${c.submitted} submitted · ${c.ready} ready to review · ${c.held} held · ${c.skipped} skipped so far`;
  }
  function lastRunText(run) {
    const verb = run.status === 'finished' ? 'finished' : run.status === 'stopped' ? 'was stopped' : 'ended with errors';
    return `Last run ${verb} ${relTime(run.endedAt || run.startedAt)}. ${countLine(run.counts)}.`;
  }
  const agentText = (n) => (n === 1
    ? 'The safe place to start. One agent works through your sources at a pace LinkedIn tolerates.'
    : `${n} agents finish sooner, but they share one Chrome window, LinkedIn notices unusual speed, and clicks can collide. Try 1 first.`);

  // --- live log --------------------------------------------------------------------------
  const logApi = (() => {
    let collapsed = false;
    let raw = false;
    let pinned = true;
    const body = h('div', { class: 'log', role: 'log', tabindex: '0', 'aria-label': 'Live activity from the agents' });
    const jump = h('div', { class: 'jump', hidden: true }, button({ label: 'Jump to latest', icon: 'chevronD', size: 'sm', onClick: () => { pinned = true; body.scrollTop = body.scrollHeight; jump.hidden = true; } }));
    body.addEventListener('scroll', () => {
      pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 28;
      jump.hidden = pinned;
    });
    const rawBtn = h('label', { class: 'check', style: { alignItems: 'center', fontSize: '13px', color: 'var(--text-2)' } },
      h('input', { type: 'checkbox', onChange: (e) => { raw = e.target.checked; renderAll(); } }), 'Show technical steps');
    const collapseBtn = button({ icon: 'chevronU', size: 'sm', kind: 'ghost', title: 'Collapse activity', onClick: () => {
      collapsed = !collapsed;
      body.classList.toggle('collapsed', collapsed);
      jump.hidden = collapsed || pinned;
      mount(collapseBtn, icon(collapsed ? 'chevronD' : 'chevronU', 16));
      collapseBtn.title = collapsed ? 'Expand activity' : 'Collapse activity';
      collapseBtn.setAttribute('aria-label', collapseBtn.title);
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    } });
    collapseBtn.setAttribute('aria-expanded', 'true');
    collapseBtn.setAttribute('aria-label', 'Collapse activity');

    const line = (e) => (!raw && e.kind === 'tool') ? null : h('div', { class: `log-line ${e.kind}` },
      h('span', { class: 't' }, clock(e.ts)),
      h('span', { class: 'a' }, e.agent ? `A${e.agent}` : ''),
      h('span', { class: 'm' }, e.text));

    const empty = () => h('div', { class: 'log-empty' }, h('b', { style: { color: 'var(--text-2)' } }, 'Nothing is running'), h('span', {}, 'What the agents are doing shows up here as soon as you start.'));

    function renderAll() {
      if (!S.log.length) { mount(body, empty()); el.classList.add('idle'); return; }
      mount(body, ...S.log.map(line));
      if (pinned) body.scrollTop = body.scrollHeight;
      el.classList.toggle('idle', !S.log.length);
    }
    function add(e) {
      if (body.querySelector('.log-empty')) { mount(body); }
      el.classList.remove('idle');
      const node = line(e);
      if (node) body.append(node);
      while (body.childElementCount > 600) body.firstChild.remove();
      if (pinned) body.scrollTop = body.scrollHeight;
    }
    function reset() { renderAll(); }
    function setStatus() {}
    const el = h('section', { class: 'panel log-wrap', 'aria-label': 'Live activity' },
      h('div', { class: 'panel-head' },
        h('h2', {}, h('span', { class: `live-dot ${S.run.status === 'running' ? 'on' : 'off'}`, id: 'log-dot' }), 'Live activity'),
        h('div', { class: 'page-actions' }, rawBtn, collapseBtn)),
      body, jump);
    renderAll();
    setStatus();
    return { el, add, reset, setStatus };
  })();

  // --- daily schedule status line ----------------------------------------------------------
  const schedHost = h('div', { class: 'sched-line', role: 'status', 'aria-label': 'Daily schedule' });
  function drawSched() {
    const sc = S.info.schedule;
    if (!sc) { mount(schedHost); schedHost.hidden = true; return; }
    schedHost.hidden = false;
    if (!sc.enabled) {
      mount(schedHost, icon('clock', 16),
        h('span', { class: 'muted' }, sc.lastRunText ? `Daily schedule is off. ${sc.lastRunText}.` : 'Want it to run by itself every day?'),
        h('a', { href: '#/settings/schedule' }, sc.lastRunText ? 'Turn it back on' : 'Set up a daily run'));
      return;
    }
    mount(schedHost, icon('clock', 16),
      h('span', { class: 'when-next' }, h('b', {}, `Next run ${sc.nextRunText}`), h('span', { class: 'faint' }, sc.mode === 'live' ? ' · Live' : ' · Practice')),
      sc.lastRunText ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), h('span', { class: 'muted' }, sc.lastRunText)] : null,
      h('a', { href: '#/settings/schedule' }, 'Schedule and digests'));
  }

  // --- lower columns -----------------------------------------------------------------------
  const recentHost = h('section', { class: 'panel', 'aria-label': 'Recent applications' });
  const inputHost = h('section', { class: 'panel', 'aria-label': 'Needs your input' });

  function drawRecent() {
    const head = h('div', { class: 'panel-head' }, h('h2', {}, 'Recent applications'), S.apps.length ? button({ label: 'View all', size: 'sm', kind: 'ghost', icon: 'chevronR', onClick: () => go('/applications') }) : null);
    if (!S.apps.length) {
      mount(recentHost, head, emptyState({
        iconName: 'send',
        title: 'No applications yet',
        body: 'Your first run is the best way to see how this works, and Practice mode is the safe way to do it.',
        steps: [
          'Leave the mode on Practice and press Start applying.',
          'Agents fill in forms but stop before Submit. Look over each one under Applications.',
          'When you trust what you see, switch to Live.',
        ],
      }));
      return;
    }
    mount(recentHost, head, ...S.apps.slice(0, 6).map((a) => h('div', { class: 'list-row' },
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'co' }, a.company), h('div', { class: 'ro' }, a.role || 'Role not recorded')),
      h('div', { class: 'end' }, statusChip(a.status), h('div', { class: 'when' }, relTime(a.ts))))));
  }

  function drawInput() {
    const open = S.held.filter((x) => x.open);
    const head = h('div', { class: 'panel-head' }, h('h2', {}, 'Needs your input', open.length ? h('span', { class: 'tag' }, String(open.length)) : null));
    if (!open.length) {
      mount(inputHost, head, h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Nothing is waiting on you. When an agent hits a question it cannot answer from your profile, it asks here instead of guessing.')));
      return;
    }
    mount(inputHost, head,
      ...open.slice(0, 3).map((q) => h('div', { class: 'list-row', style: { gridTemplateColumns: '1fr' } },
        h('div', { class: 'co', style: { whiteSpace: 'normal' } }, q.question), h('div', { class: 'ro' }, `${q.company}${q.role ? ' · ' + q.role : ''}`))),
      h('div', { style: { padding: '12px 24px' } }, button({ label: 'Answer questions', kind: 'primary', size: 'sm', onClick: () => go('/input') })));
  }

  // --- wiring ---------------------------------------------------------------------------------
  on('run', () => { drawRun(); logApi.setStatus(); const dot = document.getElementById('log-dot'); if (dot) dot.className = `live-dot ${S.run.status === 'running' ? 'on' : 'off'}`; });
  on('log', (e) => logApi.add(e));
  on('apps', drawRecent);
  on('held', () => { drawInput(); drawRun(); });
  on('preflight', drawRun);
  on('info', () => { drawRun(); drawSched(); });

  timer = setInterval(() => {
    const el = document.getElementById('elapsed');
    if (el && S.run.status === 'running') el.textContent = formatDuration(Date.now() - new Date(S.run.startedAt).getTime());
  }, 1000);

  drawRun(); drawRecent(); drawInput(); drawSched();
  // A scheduled run happens in a separate process, so look for its news now and then.
  const refresher = setInterval(() => { if (!document.hidden) loadInfo().catch(() => {}); }, 60_000);
  if (!S.preflight && !S.info.demo) loadPreflight().catch(() => {});
  loadApps(); loadHeld();

  return {
    el: h('div', { class: 'stack' },
      h('div', { class: 'page-head', style: { marginBottom: 0 } },
        h('div', {}, h('h1', {}, 'Dashboard'), h('p', {}, 'Start a run, watch what the agents do, and review the results.'))),
      dataWarnings(), schedHost, runHost, logApi.el,
      h('div', { class: 'cols' }, recentHost, inputHost)),
    destroy: () => { clearInterval(timer); clearInterval(refresher); },
  };
}

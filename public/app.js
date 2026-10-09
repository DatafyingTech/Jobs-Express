// Jobs Express: front end entry. Vanilla modules, no build step.
import { h, mount } from './js/dom.js';
import { icon, brandMark } from './js/icons.js';
import { S, emit, on, clearSubs, loadInfo, loadApps, loadHeld } from './js/state.js';
import { connectEvents, POST, GET } from './js/api.js';
import { parseRoute, go } from './js/router.js';
import { toast, sampleTag } from './js/components.js';
import { wizardView } from './js/view-wizard.js';
import { dashboardView } from './js/view-dashboard.js';
import { applicationsView } from './js/view-applications.js';
import { inputView } from './js/view-input.js';
import { settingsView } from './js/view-settings.js';

const root = document.getElementById('app');
let current = null;
let navHost;
let mainHost;

// ---------- theme ----------
function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('cja-theme', next); } catch { /* storage blocked: the choice lasts until reload */ }
  drawShellBits();
}

// ---------- shell ----------
function buildShell() {
  navHost = h('nav', { class: 'nav', 'aria-label': 'Main' });
  mainHost = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  // The theme toggle and sample-data tag come after <main> in the DOM so keyboard users reach the page first.
  const foot = h('div', { class: 'side-foot', id: 'side-foot' });
  mount(root,
    h('aside', { class: 'side' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Jobs Express, dashboard' }, brandMark(32), h('span', {}, h('div', { class: 'brand-name' }, 'Jobs ', h('span', { class: 'brand-thin' }, 'Express')), h('div', { class: 'brand-sub' }, 'Runs on your computer'))),
      navHost),
    mainHost, foot);
  drawShellBits();
}

function drawShellBits() {
  const route = parseRoute();
  const open = S.held.filter((x) => x.open).length || S.info?.openHeld || 0;
  const firstRun = !!S.info && !S.info.profile.setupComplete && !S.info.demo;
  const items = [
    firstRun ? ['setup', '/setup/1', 'Setup', 'shield', null] : null,
    ['dashboard', '/', 'Dashboard', 'grid', null, firstRun],
    ['applications', '/applications', 'Applications', 'table', S.appCounts.all || null, firstRun],
    ['input', '/input', 'Needs your input', 'inbox', open || null, firstRun],
    ['settings', '/settings/requirements', 'Settings', 'sliders', null],
  ].filter(Boolean);
  mount(navHost, ...items.map(([name, path, label, ic, count, locked]) => {
    const active = route.name === name || (name === 'settings' && route.name === 'setup' && !firstRun);
    return h('a', {
      class: `nav-item ${locked ? 'disabled' : ''}`, href: '#' + path, 'aria-current': active ? 'page' : null,
      'aria-disabled': locked ? 'true' : null, title: locked ? 'Finish setup first' : null,
      onClick: locked ? (e) => e.preventDefault() : null,
    }, icon(ic, 18), name === 'input' ? [h('span', { class: 'long' }, label), h('span', { class: 'short' }, 'Needs input')] : h('span', {}, label),
      count ? h('span', { class: `nav-count ${name === 'input' ? 'attn' : ''}`, 'aria-label': `${count} items` }, String(count)) : null);
  }));
  const foot = document.getElementById('side-foot');
  if (!foot) return;
  const dark = effectiveTheme() === 'dark';
  mount(foot,
    S.info?.demo ? sampleTag() : null,
    !S.connected ? h('span', { class: 'sample-tag', style: { color: 'var(--bad)', background: 'var(--bad-soft)' } }, icon('alert', 14), 'Lost connection') : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost sm', type: 'button', onClick: toggleTheme, 'aria-label': dark ? 'Switch to light theme' : 'Switch to dark theme' }, icon(dark ? 'sun' : 'moon', 16), h('span', { class: 'lbl' }, dark ? 'Light' : 'Dark')),
      h('span', { class: 'faint ver' }, `v${S.info?.version || ''}`)));
}

// ---------- routing ----------
function render() {
  if (!S.info) return;
  current?.destroy?.();
  clearSubs();
  const route = parseRoute();
  if (!S.info.profile.setupComplete && route.name !== 'setup' && !S.info.demo && route.name !== 'settings') {
    go('/setup/1');
    return;
  }
  let view;
  switch (route.name) {
    case 'setup': view = wizardView(route.arg); break;
    case 'applications': view = applicationsView(); break;
    case 'input': view = inputView(); break;
    case 'settings': view = settingsView(route.arg); break;
    default: view = dashboardView(); break;
  }
  current = view;
  mount(mainHost, view.el);
  // The shell keeps its own subscriptions so counts and the connection badge stay fresh.
  for (const ev of ['apps', 'held', 'info', 'run']) on(ev, drawShellBits);
  drawShellBits();
  const titles = { dashboard: 'Dashboard', applications: 'Applications', input: 'Needs your input', settings: 'Settings', setup: 'Setup' };
  document.title = `${titles[route.name] || 'Dashboard'} · Jobs Express`;
  window.scrollTo(0, 0);
}

// ---------- live events ----------
function onEvent(name, data) {
  switch (name) {
    case 'hello':
      S.run = data.run;
      break;
    case 'log':
      S.log.push(data);
      if (S.log.length > 600) S.log.splice(0, S.log.length - 600);
      emit('log', data);
      break;
    case 'run': {
      const was = S.run.status;
      S.run = data;
      emit('run', data);
      if (was === 'running' && data.status !== 'running') {
        loadApps(); loadHeld();
        toast(data.status === 'finished' ? 'Run finished.' : data.status === 'stopped' ? 'Run stopped.' : 'Run ended with errors.');
      }
      break;
    }
    case 'records':
      loadApps(); loadHeld();
      break;
    case 'connection':
      if (S.connected !== data.ok) { S.connected = data.ok; drawShellBits(); }
      break;
    default:
      break;
  }
}

// ---------- boot ----------
async function boot() {
  buildShell();
  mount(mainHost, h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { width: '220px', height: '28px' } }), h('div', { class: 'skeleton', style: { height: '180px' } })));
  try {
    await loadInfo();
  } catch (e) {
    mount(mainHost, h('div', { class: 'panel panel-pad' }, h('h2', {}, 'The app is not responding'), h('p', { class: 'muted', style: { marginTop: '8px' } }, e.message)));
    return;
  }
  await Promise.allSettled([loadApps(), loadHeld()]);
  S.loaded = true;
  try {
    const { log } = await GET('/api/run');
    S.log = log || [];
  } catch { /* the log simply starts empty */ }
  connectEvents(onEvent);

  // Demo helper for screenshots: ?scene=live starts the scripted run so the log is full.
  const scene = new URLSearchParams(location.search).get('scene');
  if (scene === 'live' && S.info.demo !== undefined && S.run.status !== 'running') {
    try {
      const r = await POST('/api/run/start', { mode: 'practice', agents: 1, demoFast: true });
      S.run = r.run;
      S.log = (await GET('/api/run')).log || [];
    } catch { /* ignore */ }
  }

  window.addEventListener('hashchange', render);
  render();
}

boot();

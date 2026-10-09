import { h, mount, relTime } from './dom.js';
import { icon } from './icons.js';
import { S, on, loadApps } from './state.js';
import { csvUrl } from './api.js';
import { button, statusChip, emptyState, segmented } from './components.js';
import { go } from './router.js';

const SOURCES = { linkedin: 'LinkedIn', greenhouse: 'Greenhouse', ashby: 'Ashby', lever: 'Lever', himalayas: 'Himalayas', wellfound: 'Wellfound', workable: 'Workable' };
const sourceName = (s) => SOURCES[String(s || '').toLowerCase()] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

export function applicationsView() {
  let filter = 'all';
  let query = '';
  const host = h('section', { class: 'panel', 'aria-label': 'Applications' });
  const tabsHost = h('div');
  const tableHost = h('div', { class: 'table-wrap' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search company or role', 'aria-label': 'Search applications', onInput: (e) => { query = e.target.value.toLowerCase(); drawTable(); } });

  function filtered() {
    return S.apps.filter((a) => (filter === 'all' || a.status === filter) && (!query || `${a.company} ${a.role} ${a.source} ${a.note}`.toLowerCase().includes(query)));
  }

  function drawTabs() {
    const c = S.appCounts;
    const seg = segmented(
      [['all', 'All'], ['submitted', 'Submitted'], ['ready', 'Ready'], ['held', 'Held'], ['skipped', 'Skipped']].map(([v, l]) => ({ value: v, label: l, count: c[v] ?? 0 })),
      filter, (v) => { filter = v; drawTable(); }, { label: 'Filter by status' });
    mount(tabsHost, seg);
  }

  function drawTable() {
    if (!S.loaded) { mount(tableHost, h('div', { style: { padding: '24px', display: 'grid', gap: '14px' } }, ...Array.from({ length: 5 }, () => h('div', { class: 'skeleton' })))); return; }
    if (!S.apps.length) {
      mount(tableHost, emptyState({ iconName: 'table', title: 'Nothing here yet', body: 'Every application an agent submits, fills in for review, holds, or skips will be listed here with a link to the posting.', action: button({ label: 'Go to the dashboard', onClick: () => go('/') }) }));
      return;
    }
    const rows = filtered();
    if (!rows.length) { mount(tableHost, emptyState({ iconName: 'search', title: 'No matches', body: 'Try a different filter or search.' })); return; }
    mount(tableHost, h('table', { class: 'apps' },
      h('thead', {}, h('tr', {}, ...['Company and role', 'Pay', 'Source', 'Status', 'When', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, ...rows.map((a) => h('tr', {},
        h('td', { class: 'c-main' }, h('div', { class: 'co' }, a.company), h('div', { class: 'ro' }, a.role || 'Role not recorded'), a.note ? h('div', { class: 'note' }, a.note) : null),
        h('td', { class: 'pay c-pay' }, a.pay || 'not listed'),
        h('td', { class: 'src c-src' }, sourceName(a.source)),
        h('td', { class: 'c-status' }, statusChip(a.status)),
        h('td', { class: 'when c-when', title: new Date(a.ts).toLocaleString() }, relTime(a.ts)),
        h('td', { class: 'c-link' }, a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open the ${a.company} posting`, title: 'Open posting' }, icon('external', 16)) : null),
      )))));
  }

  const toolbar = h('div', { class: 'toolbar' }, tabsHost, h('div', { class: 'page-actions' }, h('div', { class: 'search' }, search), button({ label: 'Export CSV', icon: 'download', size: 'sm', href: csvUrl })));
  mount(host, toolbar, tableHost);
  drawTabs();
  drawTable();
  on('apps', () => { drawTabs(); drawTable(); });
  loadApps();

  return {
    el: h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Applications'), h('p', {}, 'Everything the agents have done, newest first. Held rows are waiting on an answer from you.'))),
      host),
  };
}

import { h, mount } from './dom.js';
import { icon } from './icons.js';
import { S, on, saveDraft, resetDraft, loadInfo, clone, markDirty } from './state.js';
import { PUT } from './api.js';
import { button, guard, toast, field, preflightPanel, warningsCard, numberInput, emptyState } from './components.js';
import { aboutSection, prefsSection, honestSection } from './forms.js';
import { go } from './router.js';

const TABS = [
  { key: 'requirements', label: 'Requirements', ic: 'shield' },
  { key: 'about', label: 'About you', ic: 'user' },
  { key: 'preferences', label: 'Job preferences', ic: 'sliders' },
  { key: 'honest', label: 'Honest profile', ic: 'file' },
  { key: 'answers', label: 'Saved answers', ic: 'inbox' },
  { key: 'limits', label: 'Run limits and data', ic: 'folder' },
];

export function settingsView(arg) {
  const tab = TABS.some((t) => t.key === arg) ? arg : 'requirements';
  if (!S.dirty) resetDraft();

  const nav = h('nav', { class: 'subnav', 'aria-label': 'Settings sections' },
    ...TABS.map((t) => h('a', { href: `#/settings/${t.key}`, 'aria-current': t.key === tab ? 'page' : null }, icon(t.ic, 16), t.label)));

  let content;
  let editable = true;
  switch (tab) {
    case 'requirements':
      editable = false;
      content = h('div', { class: 'stack' }, warningsCard(), preflightPanel());
      break;
    case 'about': content = panel('About you', aboutSection()); break;
    case 'preferences': content = panel('Job preferences', prefsSection()); break;
    case 'honest': content = panel('Your honest profile', honestSection()); break;
    case 'answers': editable = false; content = answersPanel(); break;
    default: content = limitsPanel(); break;
  }

  const savebar = h('div', { class: 'savebar', hidden: true, role: 'region', 'aria-label': 'Unsaved changes' },
    h('span', { class: 'muted' }, 'You have unsaved changes.'),
    h('div', { class: 'page-actions' },
      button({ label: 'Discard', onClick: () => { resetDraft(); go(`/settings/${tab}`); } }),
      button({ label: 'Save changes', kind: 'primary', icon: 'check', onClick: () => guard(async () => { await saveDraft(); toast('Settings saved.'); savebar.hidden = true; }) })));
  if (S.dirty) savebar.hidden = false;
  on('dirty', () => { savebar.hidden = false; });

  return {
    el: h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', {}, 'Everything you told the setup wizard, editable. Saved in a file on this computer.'))),
      h('div', { class: 'settings' }, nav, h('div', { style: { minWidth: 0 } }, content, editable ? savebar : null))),
  };
}

function panel(title, sections) {
  return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title)), ...sections);
}

function answersPanel() {
  const host = h('section', { class: 'panel' });
  async function remove(q) {
    const next = S.info.profile.qa.filter((x) => x.q !== q.q);
    await guard(async () => {
      const profile = clone(S.info.profile);
      profile.qa = next;
      S.info.profile = await PUT('/api/profile', profile);
      await loadInfo();
      draw();
      toast('Removed.');
    });
  }
  function draw() {
    const qa = S.info.profile.qa;
    mount(host,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Saved answers'), h('span', { class: 'faint' }, `${qa.length} saved`)),
      h('div', { class: 'fieldset' }, h('p', { class: 'lede', style: { marginBottom: 0 } }, 'Answers you gave on the Needs your input page. Agents use these word for word whenever the same question comes up again. Remove one to be asked again.')),
      qa.length
        ? qa.map((x) => h('div', { class: 'qa-row' }, h('div', {}, h('div', { class: 'q' }, x.q), h('div', { class: 'a' }, x.a)), button({ icon: 'trash', kind: 'ghost', size: 'sm', title: 'Remove this answer', onClick: () => remove(x) })))
        : emptyState({ iconName: 'inbox', title: 'Nothing saved yet', body: 'When an agent cannot answer a question honestly, it shows up in Needs your input. Your answer is saved here and reused.', action: button({ label: 'Go to Needs your input', size: 'sm', onClick: () => go('/input') }) }));
  }
  draw();
  return host;
}

function limitsPanel() {
  const s = S.draft.settings;
  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Run limits')),
      h('div', { class: 'fieldset' },
        h('p', { class: 'lede' }, 'Every run is capped so a stuck agent cannot go on forever. When a cap is reached the agents are stopped and what they finished is kept.'),
        h('div', { class: 'grid two' },
          field('Stop a run after (minutes)', numberInput('settings.maxMinutes'), { hint: '5 to 240. Default 45.' }),
          field('Stop an agent after (actions)', numberInput('settings.maxTurns'), { hint: 'Browser clicks, reads and typing each count as one action. Default 200.' })))),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Your data')),
      h('div', { class: 'fieldset' },
        h('dl', { class: 'kv', style: { margin: 0 } },
          h('dt', {}, 'Data folder'), h('dd', {}, h('code', {}, S.info.dataDir)),
          h('dt', {}, 'Profile'), h('dd', {}, 'profile.json'),
          h('dt', {}, 'Applications'), h('dd', {}, 'applications.jsonl and held.jsonl'),
          h('dt', {}, 'Run logs'), h('dd', {}, 'runs/'),
          h('dt', {}, 'Version'), h('dd', {}, `${S.info.version} on ${S.info.platform}`)),
        h('p', { class: 'hint', style: { marginTop: '12px' } }, 'To remove everything, close the app and delete that folder. Nothing is stored anywhere else.'))));
}

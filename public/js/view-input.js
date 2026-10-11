import { h, mount, relTime } from './dom.js';
import { icon } from './icons.js';
import { S, on, loadHeld, loadInfo, loadApps } from './state.js';
import { POST } from './api.js';
import { button, guard, toast, emptyState } from './components.js';
import { go } from './router.js';

export function inputView() {
  const listHost = h('section', { class: 'panel', 'aria-label': 'Open questions' });
  const doneHost = h('section', { class: 'panel', 'aria-label': 'Answered questions' });
  const drafts = new Map();

  async function answer(q, remember) {
    const text = (drafts.get(q.id) || '').trim();
    if (!text) { toast('Type an answer first.', 'bad'); return; }
    await guard(async () => {
      const r = await POST('/api/held/answer', { id: q.id, answer: text, remember });
      S.held = r.items;
      S.retryable = r.retryable;
      await loadInfo();
      toast(remember ? 'Saved. This question will not be asked again.' : 'Saved for this application only.');
      draw();
    });
  }

  async function dismiss(q) {
    await guard(async () => {
      const r = await POST('/api/held/dismiss', { id: q.id });
      S.held = r.items;
      S.retryable = r.retryable;
      await loadInfo();
      draw();
    });
  }

  // Sites that email a code are held for you: agents cannot read your email, so you enter the code yourself.
  const isCode = (q) => /verification code|emailed code|security code|one-time (pass)?code|confirmation code/i.test(q.question);

  function codeItem(q) {
    return h('div', { class: 'q-item' },
      h('div', { class: 'q' }, h('span', { class: 'tag-code' }, icon('lock', 14), 'Needs a code from your email')),
      h('div', { class: 'meta' },
        h('span', {}, h('b', {}, q.company)), q.role ? [h('span', { class: 'dot' }, '·'), h('span', {}, q.role)] : null,
        h('span', { class: 'dot' }, '·'), h('span', { class: 'faint' }, relTime(q.ts))),
      h('p', { class: 'muted', style: { maxWidth: '66ch' } }, 'This site emailed a verification code. Agents never read your email, so they stopped here. Open the posting, then enter the code from your inbox yourself and finish the application.'),
      h('div', { class: 'q-actions' },
        q.url ? button({ label: 'Open the posting', icon: 'external', kind: 'primary', size: 'sm', href: q.url, target: '_blank' }) : null,
        button({ label: 'I finished it, clear this', size: 'sm', onClick: () => dismiss(q) }),
        button({ label: 'Not applying', size: 'sm', kind: 'ghost', onClick: () => dismiss(q) })));
  }

  function questionItem(q) {
    if (isCode(q)) return codeItem(q);
    const area = h('textarea', { class: 'textarea', rows: 2, id: `ans-${q.id}`, 'aria-label': `Your answer for ${q.company}`, placeholder: 'Your answer, in your own words. Be exact: agents will use it word for word.' });
    area.value = drafts.get(q.id) || '';
    area.addEventListener('input', () => drafts.set(q.id, area.value));
    const remember = h('input', { type: 'checkbox', checked: true, id: `rem-${q.id}` });
    return h('div', { class: 'q-item' },
      h('div', { class: 'q' }, q.question),
      h('div', { class: 'meta' },
        h('span', {}, h('b', {}, q.company)), q.role ? [h('span', { class: 'dot' }, '·'), h('span', {}, q.role)] : null,
        h('span', { class: 'dot' }, '·'), h('span', { class: 'faint' }, relTime(q.ts)),
        q.url ? [h('span', { class: 'dot' }, '·'), h('a', { href: q.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open posting')] : null),
      h('div', { class: 'answer' }, area,
        h('div', { class: 'q-actions' },
          button({ label: 'Save answer', kind: 'primary', size: 'sm', onClick: () => answer(q, remember.checked) }),
          h('label', { class: 'check', style: { alignItems: 'center' } }, remember, h('span', { class: 'muted' }, 'Remember this for every future application')),
          button({ label: 'Not applying', size: 'sm', kind: 'ghost', onClick: () => dismiss(q) })),
      ));
  }

  function draw() {
    const open = S.held.filter((x) => x.open);
    const done = S.held.filter((x) => !x.open && !x.dismissed);
    mount(listHost,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Questions agents could not answer', open.length ? h('span', { class: 'tag' }, String(open.length)) : null)),
      open.length
        ? open.map(questionItem)
        : emptyState({ iconName: 'inbox', title: S.held.length ? 'You are all caught up' : 'No questions yet', body: 'When an agent reaches a required question your profile does not cover, such as a driver\'s license or drug-test consent, it stops, writes the question here, and moves on to the next job. Your answer is saved so it is never asked twice.' }));
    mount(doneHost,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Answered')),
      done.length
        ? done.map((q) => h('div', { class: 'q-done' }, h('div', {}, h('b', {}, q.question)), h('div', { class: 'a' }, `${q.answer}`), h('div', { class: 'faint' }, `${q.company}${q.role ? ' · ' + q.role : ''}`)))
        : h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Answers you give will be listed here, and added to the saved answers in Settings.')));
    doneHost.hidden = false;
    banner();
  }

  const bannerHost = h('div');
  function banner() {
    if (S.retryable > 0) {
      mount(bannerHost, h('div', { class: 'notice calm' },
        h('div', { style: { flex: 1 } }, h('h2', {}, icon('refresh', 18), `${S.retryable} held application${S.retryable > 1 ? 's are' : ' is'} ready to retry`),
          h('p', { class: 'muted' }, 'You have answered the questions that held them up. Run the agents on just those postings.')),
        button({ label: 'Review and re-run', kind: 'primary', icon: 'play', onClick: () => go('/') })));
    } else mount(bannerHost);
  }

  on('held', draw);
  draw();
  loadHeld();

  return {
    el: h('div', { class: 'stack' },
      h('div', { class: 'page-head', style: { marginBottom: 0 } }, h('div', {}, h('h1', {}, 'Needs your input'), h('p', {}, 'Agents never guess at personal facts. They park the question here, and you answer once.'))),
      bannerHost, listHost, doneHost),
  };
}

import { h } from './dom.js';
import { icon } from './icons.js';
import { S, saveDraft, resetDraft } from './state.js';
import { button, guard, preflightPanel, warningsCard, toast } from './components.js';
import { aboutSection, prefsSection, honestSection } from './forms.js';
import { go } from './router.js';

const STEPS = [
  { key: 'welcome', label: 'Welcome', sub: 'Check requirements' },
  { key: 'about', label: 'About you', sub: 'Contact and resume' },
  { key: 'wants', label: 'What you want', sub: 'Roles, pay, volume' },
  { key: 'honest', label: 'Your honest profile', sub: 'Facts agents may claim' },
  { key: 'review', label: 'Review and save', sub: 'One last look' },
];

export function wizardView(step = 1) {
  const n = Math.min(STEPS.length, Math.max(1, Number(step) || 1));
  if (!S.dirty) resetDraft();
  const cur = STEPS[n - 1];

  const rail = h('nav', { class: 'rail', 'aria-label': 'Setup progress' },
    h('ol', {}, ...STEPS.map((s, i) => h('li', { class: i + 1 < n ? 'done' : i + 1 === n ? 'current' : '', 'aria-current': i + 1 === n ? 'step' : null },
      h('span', { class: 'dot' }, i + 1 < n ? icon('check', 14) : String(i + 1)),
      h('button', { type: 'button', onClick: () => goStep(i + 1) }, s.label, h('span', { class: 'sub' }, s.sub)),
    ))));

  const mobileRail = h('div', { class: 'rail-mobile' },
    h('div', { class: 'faint' }, `Step ${n} of ${STEPS.length}`),
    h('div', { class: 'bar' }, ...STEPS.map((_, i) => h('i', { class: i < n ? 'on' : '' }))),
  );

  async function goStep(target) {
    if (S.dirty && !(await guard(async () => { await saveDraft(); return true; }))) return;
    go(`/setup/${target}`);
  }

  let body;
  switch (cur.key) {
    case 'welcome': body = welcome(); break;
    case 'about': body = aboutSection(); break;
    case 'wants': body = prefsSection(); break;
    case 'honest': body = honestSection(); break;
    default: body = review(goStep); break;
  }

  const last = n === STEPS.length;
  const foot = h('div', { class: 'wizard-foot' },
    n > 1 ? button({ label: 'Back', icon: null, onClick: () => goStep(n - 1) }) : h('span'),
    last
      ? button({ label: 'Save and go to the dashboard', kind: 'primary', icon: 'check', onClick: () => guard(async () => {
        await saveDraft({ complete: true });
        toast('Saved. You are ready for a practice run.');
        go('/');
      }) })
      : button({ label: 'Continue', kind: 'primary', onClick: () => goStep(n + 1) }),
  );

  return {
    el: h('div', {},
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, 'Set up Jobs Express'), h('p', {}, 'Answer these once. Your answers are saved in a file on this computer and are never uploaded by this app.'))
      ),
      mobileRail,
      h('div', { class: 'wizard' }, rail,
        h('div', { class: 'wizard-body' },
          h('div', { class: 'panel' },
            h('div', { class: 'panel-head' }, h('h2', {}, cur.label), h('span', { class: 'faint' }, `Step ${n} of ${STEPS.length}`)),
            ...(Array.isArray(body) ? body : [body]),
            foot,
          ),
        ),
      ),
    ),
  };
}

function welcome() {
  return h('div', { class: 'stack', style: { padding: '24px' } },
    h('div', {},
      h('h3', { style: { fontSize: '17px', marginBottom: '6px' } }, 'Parallel agents, your own Chrome, honest answers.'),
      h('p', { class: 'muted', style: { maxWidth: '64ch' } }, 'Jobs Express opens Claude Code in the background and lets it work in the Chrome you are already signed in to. It finds roles that fit, fills in the forms using only what you tell it here, and holds anything it cannot answer truthfully. First, a quick check that your computer is ready.'),
    ),
    preflightPanel(),
    warningsCard(),
  );
}

function review(goStep) {
  const d = S.draft;
  const a = d.about;
  const p = d.prefs;
  const hn = d.honest;
  const dd = (label, value) => [h('dt', {}, label), h('dd', {}, value || h('span', { class: 'faint' }, 'Not set'))];
  const block = (title, stepNo, ...rows) => h('div', { class: 'review-block' },
    h('div', { class: 'head' }, h('h3', {}, title), button({ label: 'Edit', icon: 'edit', size: 'sm', kind: 'ghost', onClick: () => goStep(stepNo) })),
    h('dl', { class: 'kv', style: { margin: 0 } }, ...rows.flat()));
  const money = (n) => (n === '' || n == null ? '' : `$${Number(n).toLocaleString('en-US')} per ${p.payPeriod}`);
  const srcs = [p.sources.linkedin && 'LinkedIn Easy Apply', p.sources.ats && 'Company job boards', p.sources.aggregators && 'Job aggregators'].filter(Boolean).join(', ');
  const gaps = S.info.gaps;
  return h('div', {},
    gaps.length
      ? h('div', { style: { padding: '24px 24px 0' } }, h('div', { class: 'inline-alert' }, icon('alert', 18), h('div', {}, h('b', {}, 'Still missing: '), gaps.join(', '), '. You can save now and fill these in later from Settings, but the Start button stays locked until they are done.')))
      : null,
    block('About you', 2,
      dd('Name', a.fullName), dd('Email', a.email), dd('Phone', a.phone),
      dd('Location', [a.city, a.state, a.country].filter(Boolean).join(', ')),
      dd('Resume', a.resumeName), dd('Work authorization', a.workAuth)),
    block('What you want', 3,
      dd('Categories', [...p.categories, ...p.customTitles].join(', ')),
      dd('Seniority', p.seniority.join(', ')), dd('Work mode', p.workModes.join(', ')),
      dd('Pay', [money(p.payFloor) && `floor ${money(p.payFloor)}`, money(p.payIdeal) && `ideal ${money(p.payIdeal)}`].filter(Boolean).join(', ')),
      dd('Per run', String(p.perRun)), dd('Sources', srcs)),
    block('Your honest profile', 4,
      dd('Experience', hn.yearsExperience ? `${hn.yearsExperience} years` : ''),
      dd('Skills', hn.skills), dd('Tools', hn.tools), dd('Certifications', hn.certifications || 'None listed'),
      dd('Education', hn.education), dd('Never claim', hn.neverClaim)),
  );
}

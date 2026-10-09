// Form sections shared by the setup wizard and the Settings view. They edit S.draft in place.
import { h, get, set, mount } from './dom.js';
import { icon } from './icons.js';
import { S, markDirty } from './state.js';
import {
  field, textInput, textArea, selectInput, numberInput, chipGroup, tagInput, segmented, switchRow, radioList, resumeDropzone,
} from './components.js';

const EEO = {
  gender: ['Prefer not to say', 'Male', 'Female', 'Non-binary', 'Another gender identity'],
  raceEthnicity: ['Prefer not to say', 'Hispanic or Latino', 'White', 'Black or African American', 'Asian', 'American Indian or Alaska Native', 'Native Hawaiian or Pacific Islander', 'Two or more races'],
  veteran: ['Prefer not to say', 'I am not a protected veteran', 'I identify as a protected veteran'],
  disability: ['Prefer not to say', 'No, I do not have a disability', 'Yes, I have a disability'],
};

const fs = (title, lede, ...kids) => h('div', { class: 'fieldset' }, h('h3', {}, title), lede ? h('p', { class: 'lede' }, lede) : null, ...kids);

export function aboutSection() {
  return [
    fs('Contact details', 'These go into the standard fields on application forms.',
      h('div', { class: 'grid two' },
        field('Full name', textInput('about.fullName', { autocomplete: 'name' }), { required: true }),
        field('Email', textInput('about.email', { type: 'email', autocomplete: 'email' }), { required: true, hint: 'Employers reply here. Agents never open your inbox.' }),
        field('Phone', textInput('about.phone', { type: 'tel', autocomplete: 'tel' }), { required: true }),
        field('LinkedIn profile URL', textInput('about.linkedin', { placeholder: 'https://www.linkedin.com/in/your-name' }), { required: false }),
        field('City', textInput('about.city', { autocomplete: 'address-level2' }), { required: false }),
        field('State or region', textInput('about.state', { autocomplete: 'address-level1' }), { required: false }),
        field('Country', textInput('about.country', { autocomplete: 'country-name' }), { required: false }),
        field('Other links', textInput('about.links', { placeholder: 'GitHub, portfolio, personal site' }), { required: false, hint: 'Separate several with commas.' }),
      ),
    ),
    fs(['Resume', h('span', { class: 'req' }, 'Required')], 'Agents upload this exact file when a form asks for one.', resumeDropzone()),
    fs('Work authorization', 'Answered the same way on every form, so it has to be true.',
      radioList('about.workAuth', S.info.options.workAuth, 'workauth'),
      h('div', { style: { marginTop: '12px' } }, field('Anything else employers should know?', textInput('about.workAuthNote', { placeholder: 'For example: visa type and expiry' }), { required: false })),
    ),
    fs('Voluntary self-identification (EEO)', 'Many US forms ask these. They are optional by law, and the default is "Prefer not to say". Change them only if you want agents to answer.',
      h('div', { class: 'grid two' },
        field('Gender', selectInput('eeo.gender', EEO.gender)),
        field('Race / ethnicity', selectInput('eeo.raceEthnicity', EEO.raceEthnicity)),
        field('Veteran status', selectInput('eeo.veteran', EEO.veteran)),
        field('Disability status', selectInput('eeo.disability', EEO.disability)),
      ),
    ),
  ];
}

export function prefsSection() {
  const p = S.draft.prefs;
  const presets = [5, 10, 25];
  const isCustom = !presets.includes(Number(p.perRun));
  const customWrap = h('div', { style: { display: isCustom ? 'block' : 'none', width: '120px' } }, numberInput('prefs.perRun', { label: 'Applications per run (custom number)' }));
  const perRun = segmented(
    [...presets.map((n) => ({ value: n, label: String(n) })), { value: 'custom', label: 'Custom' }],
    isCustom ? 'custom' : Number(p.perRun),
    (v) => {
      if (v === 'custom') { customWrap.style.display = 'block'; customWrap.querySelector('input').focus(); return; }
      customWrap.style.display = 'none';
      S.draft.prefs.perRun = v;
      customWrap.querySelector('input').value = String(v);
      markDirty();
    },
    { label: 'Applications per run' },
  );

  const per = () => `per ${S.draft.prefs.payPeriod === 'hour' ? 'hour' : 'year'}`;
  const floorInput = numberInput('prefs.payFloor', { prefix: '$', placeholder: '90,000', grouped: true, suffix: per() });
  const idealInput = numberInput('prefs.payIdeal', { prefix: '$', placeholder: '120,000', grouped: true, suffix: per() });
  const periodSelect = selectInput('prefs.payPeriod', ['year', 'hour']);
  periodSelect.addEventListener('change', () => { floorInput.setSuffix(per()); idealInput.setSuffix(per()); });

  const sources = h('div', {},
    switchRow({ title: 'LinkedIn Easy Apply', desc: 'Roles with LinkedIn\'s own quick-apply form. Needs you signed in to LinkedIn.', checked: p.sources.linkedin, onChange: (v) => { p.sources.linkedin = v; markDirty(); } }),
    switchRow({ title: 'Company job boards', desc: 'Greenhouse, Ashby, Lever and similar. Agents read each board\'s public listing, then apply on the company\'s own page.', checked: p.sources.ats, onChange: (v) => { p.sources.ats = v; markDirty(); } }),
    switchRow({ title: 'Job aggregators', desc: 'Himalayas, Remote Rocket Ship, Hacker News "Who is hiring", Wellfound. Used to find roles; applications still happen on the employer\'s page.', checked: p.sources.aggregators, onChange: (v) => { p.sources.aggregators = v; markDirty(); } }),
  );

  return [
    fs(['What kind of work', h('span', { class: 'req' }, 'Pick at least one')], 'Pick every category you would take a call about. Add exact titles below for anything that is missing.',
      chipGroup('prefs.categories', S.info.options.categories, { label: 'Job categories' }),
      h('div', { style: { marginTop: '16px' } }, field('Specific job titles', tagInput('prefs.customTitles', { placeholder: 'Type a title and press Enter', label: 'Add a job title' }))),
    ),
    fs('Level and place', null,
      h('div', { class: 'grid' },
        field('Seniority', chipGroup('prefs.seniority', S.info.options.seniority, { label: 'Seniority' })),
        field('Work mode', chipGroup('prefs.workModes', S.info.options.workModes, { label: 'Work mode' })),
        field('Where', textArea('prefs.locations', { rows: 2, placeholder: 'For example: anywhere in the US if remote, or hybrid within 40 miles of Denver' }), { hint: 'Agents use this to skip roles in the wrong place.' }),
      ),
    ),
    fs('Pay', 'Roles that clearly pay less than your floor are skipped. If a posting does not list pay, agents carry on and record "not listed".',
      h('div', { class: 'grid three' },
        field('Lowest you would accept', floorInput),
        field('Ideal', idealInput, { required: false }),
        field('Per', periodSelect),
      ),
    ),
    fs('Leave these out', null,
      h('div', { class: 'grid' },
        field('Companies to skip', textArea('prefs.excludeCompanies', { rows: 2, placeholder: 'Comma-separated company names' }), { required: false }),
        field('Skip postings that mention', textArea('prefs.excludeKeywords', { rows: 2, placeholder: 'For example: commission only, security clearance, unpaid trial' }), { required: false }),
      ),
    ),
    fs('How many per run', 'A small first batch is wise. You can always run again.',
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } }, perRun, customWrap)),
    fs('Where to look', 'Turn on only what you are comfortable with.', sources),
  ];
}

export function honestSection() {
  return [
    h('div', { class: 'fieldset' },
      h('div', { class: 'notice calm', style: { boxShadow: 'none' } },
        h('div', {},
          h('h2', {}, icon('shield', 18), 'This is the list of facts agents may claim'),
          h('p', { class: 'muted' }, 'Agents answer from this page and nothing else. If a form asks for something that is not here, they stop and hold that application for you instead of guessing. So be accurate, and be specific: the more true detail you list, the fewer applications get held.'),
        ),
      ),
    ),
    fs('Experience', null,
      h('div', { class: 'grid' },
        field('Years of professional experience', textInput('honest.yearsExperience', { placeholder: 'For example: 7' }), { required: false }),
        field('Short summary in your own words', textArea('honest.summary', { rows: 3, placeholder: 'Two or three sentences about what you do well. Agents reuse this when a form wants a paragraph.' }), { required: false }),
        field('Jobs you have held', textArea('honest.titles', { rows: 4, placeholder: 'One per line: title, employer type, years. For example: Help Desk Technician, 2019 to 2021' }), { required: false }),
      ),
    ),
    fs('Skills and tools', null,
      h('div', { class: 'grid' },
        field('Skills', textArea('honest.skills', { rows: 3, placeholder: 'Troubleshooting, onboarding customers, writing documentation' }), { required: false }),
        field('Tools and technologies you have really used', textArea('honest.tools', { rows: 3, placeholder: 'Only what you could talk about in an interview' }), { required: false }),
        field('Certifications you hold', textArea('honest.certifications', { rows: 2, placeholder: 'Exact names and years. Leave empty if none.' }), { required: false, hint: 'Agents will not claim any certification that is not listed here.' }),
        field('Education', textArea('honest.education', { rows: 2, placeholder: 'For example: Some college coursework, no degree conferred. Or: B.S., Computer Science, State University, 2018' }), { required: false, hint: 'Be exact. "No degree" is a perfectly good answer, and agents will state it plainly.' }),
      ),
    ),
    fs('Never claim', 'Anything you want to be certain no agent ever says, even if a posting makes it tempting.',
      field(null, textArea('honest.neverClaim', { label: 'Never claim', rows: 3, placeholder: 'For example: a bachelor\'s degree, managing people, AWS certifications, security clearance' }), { required: false })),
  ];
}

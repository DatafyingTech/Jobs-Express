// Demo mode: a fictional person, fictional companies, and a scripted fake log stream.
// Lets the UI be screenshotted and recorded without touching real data or a real browser.
// Everything here is obviously made up and labeled "Sample data" in the interface.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { FILES, newId, recordApplication } from './store.mjs';
import { defaultProfile, normalizeProfile } from './profile.mjs';

export function demoProfile() {
  const p = defaultProfile();
  return normalizeProfile(
    {
      setupComplete: true,
      about: {
        fullName: 'Alex Rivera',
        email: 'alex.rivera@example.com',
        phone: '(555) 010-0142',
        city: 'Austin',
        state: 'TX',
        country: 'United States',
        workAuth: 'Authorized to work in my country; no sponsorship needed',
        linkedin: 'https://www.linkedin.com/in/alex-rivera-sample',
        links: 'https://github.com/alex-rivera-sample',
      },
      eeo: { gender: 'Prefer not to say', raceEthnicity: 'Prefer not to say', veteran: 'I am not a veteran', disability: 'Prefer not to say' },
      prefs: {
        categories: ['IT support / helpdesk', 'Customer success / support', 'Systems & network admin'],
        customTitles: ['Support Engineer', 'Solutions Analyst'],
        seniority: ['Mid level', 'Senior'],
        workModes: ['Remote', 'Hybrid'],
        locations: 'Anywhere in the US (remote), or hybrid within 40 miles of Austin, TX',
        payFloor: 85000,
        payIdeal: 110000,
        payPeriod: 'year',
        excludeCompanies: 'Example Staffing Group, Gigwork Labs',
        excludeKeywords: 'commission only, unpaid trial, security clearance',
        perRun: 10,
        sources: { linkedin: true, ats: true, aggregators: false },
      },
      honest: {
        yearsExperience: '7',
        summary: 'IT support and systems administrator who moved into customer-facing support engineering. Good at explaining technical problems plainly.',
        titles: 'Help Desk Technician (2019-2021); Systems Administrator (2021-2023); Support Engineer (2023-present)',
        skills: 'Troubleshooting, ticket triage, documentation, onboarding customers, scripting small automations',
        tools: 'Zendesk, Jira, Microsoft 365 admin, Active Directory, PowerShell, SQL (basic), Python (scripting)',
        certifications: 'CompTIA A+ (2019)',
        education: 'Some college coursework, no degree conferred',
        neverClaim: 'A bachelor\'s degree. AWS or Azure certifications. Managing direct reports. Security clearance.',
      },
      qa: [
        { q: 'Are you willing to travel up to 10% of the time?', a: 'Yes, occasional travel is fine.', at: new Date().toISOString() },
        { q: 'Earliest start date / notice period?', a: 'Two weeks.', at: new Date().toISOString() },
      ],
      settings: { mode: 'practice', agents: 1, maxMinutes: 45, maxTurns: 200 },
    },
    p,
  );
}

const COMPANIES = [
  ['Brightwell Systems', 'Support Engineer', '$92k - $108k', 'greenhouse', 'submitted', 'Plain accuracy acknowledgment ticked'],
  ['Northfield Labs', 'Technical Support Specialist', '$88k - $102k', 'linkedin', 'submitted', ''],
  ['Harbor & Pine', 'IT Systems Administrator', '$95k - $115k', 'ashby', 'submitted', ''],
  ['Kestrel Cloud', 'Customer Success Engineer', '$100k - $125k', 'lever', 'submitted', 'Hidden text in the posting addressed to AI was ignored'],
  ['Lumen Ridge', 'Solutions Analyst', 'not listed', 'linkedin', 'submitted', ''],
  ['Orchard Health Tech', 'Support Engineer II', '$90k - $104k', 'greenhouse', 'submitted', ''],
  ['Quillstone', 'Help Desk Lead', '$86k - $98k', 'linkedin', 'ready', 'Free-text answer written; please read it'],
  ['Tidewater Analytics', 'Technical Account Support', '$96k - $112k', 'ashby', 'ready', ''],
  ['Fernhill Software', 'Support Operations Analyst', '$89k - $101k', 'lever', 'ready', ''],
  ['Marlow Robotics', 'Field Systems Technician', '$91k', 'linkedin', 'held', 'Needs your answer: driver\'s license'],
  ['Copperleaf Co', 'IT Support Manager', '$105k - $130k', 'greenhouse', 'held', 'Needs your answer: drug-test consent'],
  ['Juniper Ledger', 'Systems Engineer', '$98k - $120k', 'ashby', 'held', 'Needs an emailed verification code'],
  ['Stonebridge Learning', 'Technical Trainer', '$62k - $70k', 'linkedin', 'skipped', 'Pay below floor'],
  ['Vantage Pier', 'Security Operations Analyst', '$110k - $140k', 'lever', 'skipped', 'Requires a security clearance'],
];

const HELD = [
  ['Marlow Robotics', 'Field Systems Technician', "Do you have a valid driver's license and reliable transportation?", 'linkedin'],
  ['Copperleaf Co', 'IT Support Manager', 'This role requires a pre-employment drug screen. Do you consent to testing?', 'greenhouse'],
  ['Juniper Ledger', 'Systems Engineer', 'Have you ever been convicted of a felony? (Answer required to continue.)', 'ashby'],
];

/** Fill a store with the demo profile and sample records. */
export function seedDemo(store) {
  store.ensure();
  const profile = demoProfile();
  const resumeFile = store.resolve(FILES.resume, 'Alex_Rivera_Resume.pdf');
  fs.writeFileSync(resumeFile, '%PDF-1.4\n% Sample data: not a real resume\n');
  profile.about.resumePath = resumeFile;
  profile.about.resumeName = 'Alex_Rivera_Resume.pdf';
  store.writeJson(FILES.profile, profile);
  store.writeJson(FILES.state, {
    linkedinConfirmed: false,
    lastConnectionTest: null,
  });
  fs.writeFileSync(store.resolve(FILES.applications), '');
  fs.writeFileSync(store.resolve(FILES.held), '');
  const now = Date.now();
  COMPANIES.forEach(([company, role, pay, source, status, note], i) => {
    const rec = recordApplication(store, {
      company, role, pay, source, status, note,
      url: `https://example.com/jobs/${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${1000 + i}`,
    }, { agent: 'agent-1', run: 'sample' });
    rec.ts = new Date(now - (i * 47 + 12) * 60_000).toISOString();
    // Rewrite with the staggered timestamp.
    const lines = store.readJsonl(FILES.applications);
    lines[lines.length - 1] = rec;
    fs.writeFileSync(store.resolve(FILES.applications), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
  HELD.forEach(([company, role, question], i) => {
    store.appendJsonl(FILES.held, {
      id: `h_sample${i + 1}`,
      ts: new Date(now - (i * 31 + 20) * 60_000).toISOString(),
      company, role, question, note: '',
      url: `https://example.com/jobs/${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${1000 + 9 + i}`,
      agent: 'agent-1', run: 'sample',
    });
  });
  return profile;
}

export function demoPreflight(state = {}) {
  const ok = (id, title, summary, extra = {}) => ({ id, title, status: 'ok', summary, hint: '', ...extra });
  const lt = state.lastConnectionTest;
  return {
    rows: [
      ok('node', 'Node.js', 'Node.js 22.11.0 (sample)'),
      ok('claude', 'Claude Code', 'Claude Code 2.1.0 (sample)'),
      ok('auth', 'Signed in with a Claude plan', 'Signed in with your claude.ai account (max plan)'),
      ok('browser', 'Chrome or Edge', 'Google Chrome'),
      lt?.ok
        ? ok('extension', 'Claude in Chrome extension', 'Connected', { testedAt: lt.at })
        : { id: 'extension', title: 'Claude in Chrome extension', status: 'pending', summary: 'Not tested yet', hint: 'Click "Test connection". Chrome should be open with the Claude extension installed and signed in.' },
      state.linkedinConfirmed
        ? ok('linkedin', 'LinkedIn is signed in', 'You confirmed you are signed in')
        : { id: 'linkedin', title: 'LinkedIn is signed in', status: 'pending', summary: 'Waiting for your confirmation', hint: 'Open LinkedIn in the same Chrome profile that has the Claude extension, sign in yourself, then tick the box.' },
    ],
    checkedAt: new Date().toISOString(),
  };
}

const SCRIPT = [
  [0, 0, 'system', 'Run started in {MODE} mode with 1 agent.'],
  [500, 1, 'system', 'Agent started (sample).'],
  [900, 1, 'say', 'Starting with LinkedIn Easy Apply. Searching "Support Engineer" posted in the last day, remote.'],
  [900, 1, 'tool', 'browser navigate  https://www.linkedin.com/jobs/search/?keywords=Support%20Engineer&f_AL=true&f_TPR=r86400'],
  [1000, 1, 'tool', 'browser read page'],
  [1100, 1, 'say', 'Found 11 results. Checking the first against exclusions and the pay floor.'],
  [1000, 1, 'tool', 'node tools/log.mjs check --company "Quillstone" --role "Help Desk Lead"'],
  [800, 1, 'say', 'Not a duplicate. Quillstone lists $86k-$98k, above the floor. Opening the application.'],
  [1000, 1, 'tool', 'browser computer  left_click "Easy Apply"'],
  [1200, 1, 'tool', 'browser form input  email = alex.rivera@example.com'],
  [900, 1, 'tool', 'browser file upload  Alex_Rivera_Resume.pdf'],
  [1200, 1, 'say', 'Read back every field. One required question asks for a driver\'s license, which is not in the profile.'],
  [900, 1, 'tool', 'node tools/log.mjs held --company "Marlow Robotics" --question "Do you have a valid driver\'s license..."'],
  [700, 1, 'record', 'Recorded: held', 'held'],
  [1000, 1, 'say', 'Moving on. Next posting: Tidewater Analytics, Technical Account Support.'],
  [1100, 1, 'tool', 'browser navigate  https://example.com/jobs/tidewater-analytics/1007'],
  [1200, 1, 'tool', 'browser find  Apply button'],
  [1100, 1, 'say', 'Form filled and verified. Practice mode, so stopping before the final Submit.', ],
  [900, 1, 'tool', 'node tools/log.mjs ready --company "Tidewater Analytics" --role "Technical Account Support"'],
  [700, 1, 'record', 'Recorded: ready', 'ready'],
  [1000, 1, 'tool', 'node tools/log.mjs check --company "Stonebridge Learning"'],
  [800, 1, 'say', 'Pay listed at $62k-$70k, below the $85,000 floor. Skipping.'],
  [800, 1, 'record', 'Recorded: skipped', 'skipped'],
  [1200, 1, 'say', 'Reached the target for this run. Closing my tabs and writing the report.'],
  [1000, 1, 'result', 'Finished after 31 turns in 214s. Filled in 2 applications, held 1, skipped 1. No rate limits.'],
];

export class DemoRunner extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
    this.run = null;
    this.buffer = [];
    this.seq = 0;
    this.timers = [];
  }

  get active() {
    return !!this.run && this.run.status === 'running';
  }

  snapshot() {
    if (!this.run) return { status: 'idle' };
    const { id, status, mode, task, startedAt, endedAt, agents, reason, counts } = this.run;
    return { id, status, mode, task, startedAt, endedAt, reason, agents: agents.map((a) => ({ ...a })), counts: { ...counts } };
  }

  recent(n = 300) {
    return this.buffer.slice(-n);
  }

  log(agent, kind, text) {
    const entry = { seq: ++this.seq, ts: new Date().toISOString(), run: this.run?.id, agent, kind, text };
    this.buffer.push(entry);
    this.emit('log', entry);
  }

  start(opts = {}) {
    if (this.active) throw new Error('A run is already in progress.');
    const mode = opts.mode === 'live' ? 'live' : 'practice';
    const agents = Math.min(3, Math.max(1, Number(opts.agents) || 1));
    this.run = {
      id: newId('r_'), mode, task: opts.task === 'held' ? 'held' : 'search', status: 'running',
      startedAt: new Date().toISOString(), endedAt: null, reason: '',
      counts: { submitted: 0, ready: 0, held: 0, skipped: 0 },
      agents: Array.from({ length: agents }, (_, i) => ({ number: i + 1, status: 'running', turns: 0, limit: Math.ceil((opts.limit || 10) / agents), sources: ['linkedin'] })),
    };
    this.buffer = [];
    const fast = !!opts.demoFast;
    let t = 0;
    SCRIPT.forEach(([delay, agent, kind, text, rec], i) => {
      t += fast ? 0 : delay;
      const play = () => {
        if (!this.active) return;
        this.log(agent || null, kind, text.replace('{MODE}', mode === 'live' ? 'Live' : 'Practice'));
        if (kind === 'tool') this.run.agents[0].turns += 1;
        if (rec) {
          const key = rec === 'ready' && mode === 'live' ? 'submitted' : rec;
          this.run.counts[key] += 1;
          this.emit('records', key);
        }
        if (kind === 'result' || i === SCRIPT.length - 1) this.finish('finished');
        this.emit('run', this.snapshot());
      };
      if (fast && i < SCRIPT.length - 1) play();
      else this.timers.push(setTimeout(play, fast ? 180000 : t));
    });
    this.emit('run', this.snapshot());
    return this.snapshot();
  }

  finish(status) {
    if (!this.run || this.run.status !== 'running') return;
    this.run.status = status;
    this.run.endedAt = new Date().toISOString();
    this.run.agents.forEach((a) => (a.status = status === 'finished' ? 'done' : 'stopped'));
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  stop(reason = 'Stopped by you.') {
    if (!this.active) return this.snapshot();
    this.run.reason = reason;
    this.log(null, 'system', `${reason} Stopping agents…`);
    this.finish('stopped');
    this.log(null, 'system', 'Run stopped.');
    this.emit('run', this.snapshot());
    return this.snapshot();
  }
}

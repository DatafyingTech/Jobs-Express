import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.mjs';
import { defaultProfile, normalizeProfile } from '../lib/profile.mjs';

export function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-test-'));
  const store = createStore(dir);
  store.ensure();
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function sampleProfile(over = {}) {
  return normalizeProfile({
    setupComplete: true,
    about: { fullName: 'Alex Rivera', email: 'alex.rivera@example.com', phone: '(555) 010-0142', city: 'Austin', state: 'TX', country: 'United States', resumePath: '' },
    prefs: {
      categories: ['IT support / helpdesk', 'Customer success / support'],
      customTitles: ['Support Engineer'],
      seniority: ['Mid level'],
      workModes: ['Remote'],
      locations: 'US remote',
      payFloor: 85000, payIdeal: 110000, payPeriod: 'year',
      excludeCompanies: 'Example Staffing Group',
      excludeKeywords: 'commission only',
      perRun: 10,
      sources: { linkedin: true, ats: true, aggregators: false },
    },
    honest: { yearsExperience: '7', skills: 'Troubleshooting, documentation', tools: 'Zendesk, Jira', certifications: 'CompTIA A+', education: 'Some college, no degree', neverClaim: 'A bachelor\'s degree' },
    qa: [{ q: 'Are you willing to travel?', a: 'Yes, up to 10%.' }],
    ...over,
  }, defaultProfile());
}

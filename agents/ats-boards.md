# Source: company job boards (applicant tracking systems)

Many companies publish their openings through a public job board. Three of the largest have open JSON feeds you can read with WebFetch, which is faster and gentler than browsing. Use WebFetch for the feeds (so you do not need Bash), then use the browser only to apply.

## Public feeds

Replace `{slug}` with the company's board name (the last part of its board address, such as `jobs.lever.co/{slug}`).

| System | Feed | Notes |
|---|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | Returns every open job with its full description. Apply page: `https://job-boards.greenhouse.io/{slug}/jobs/{id}` |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` | Includes pay ranges when the company publishes them. Apply page: `https://jobs.ashbyhq.com/{slug}/{id}/application` |
| Lever | `https://api.lever.co/v0/postings/{slug}?mode=json` | Apply page: `https://jobs.lever.co/{slug}/{id}/apply` |

Other systems (Workable, SmartRecruiters, Breezy, Recruitee, Rippling, Pinpoint) have public job pages even without a convenient feed. Treat them like any career page.

## Finding boards to scan

You will not have a list of slugs. Build one with WebSearch, using the person's titles, for example:

- `site:job-boards.greenhouse.io "<title>" remote`
- `site:jobs.ashbyhq.com "<title>"`
- `site:jobs.lever.co "<title>"`

Keep the slugs you find. Then fetch each feed and filter its jobs yourself.

## Filtering

- Read **workplaceType** (Ashby: `Remote`, `Hybrid`, `OnSite`) or the location text, and match it against the person's work modes. Do not rely on an `isRemote` flag; it is often wrong or missing.
- Match the title and description against the person's categories and custom titles, and against their seniority.
- Check the location against what the person wants and what their work authorization allows. Skip roles restricted to regions that exclude them.
- Use compensation fields when present and compare to the pay floor. If absent, check the description for a range; if none, treat pay as "not listed".
- Prefer the freshest postings (Greenhouse: `updated_at`; Ashby: `publishedAt`; Lever: `createdAt`).
- Respect the exclusions list and run the duplicate check before every application.

## Be polite to the feeds

Fetch at most **12** boards in one batch of parallel calls. If a feed answers 429, 403, or 406, wait at least a minute before trying the same host again and cut your batch size in half. Never loop on a failing request.

## Applying

Open the apply page in your own tab and fill the form with the browser tools following the shared rules.

- Greenhouse and Ashby location fields are autocompletes. Type the city, then pick the real suggestion, then read the field back.
- Ashby inputs sometimes need real typing events rather than a value injected by a form tool. Verify each one.
- Greenhouse sometimes shows an email security code after you submit. You must not read the person's email: log the role as held with the question `Needs the emailed verification code`, close the tab, and move on. The person enters the code themselves from their inbox.
- Workable asks for compensation as a bare number (no currency symbol or commas).
- Upload the resume with the file upload tool and check the file name shows up.
- Sections for demographic questions: use the saved EEO defaults.
- Skip any application that requires creating an account or choosing a password.

## Finishing a posting

{{MODE_FINISH_ATS}}

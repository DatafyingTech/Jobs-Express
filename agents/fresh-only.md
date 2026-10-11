# Daily run: fresh postings only

This is the person's scheduled daily run, and nobody is watching it. It looks only at roles posted in the **last {{HOURS}} hours**. That is the whole point of the run: the person wants to be among the first applicants, and does not want yesterday's leftovers.

## The freshness rule

- Only consider a posting if it was posted within the last {{HOURS}} hours. Use the posting's own date or "posted X ago" text. If a posting shows no date at all, skip it. Never guess that something is fresh.
- Apply to **every** posting inside that window that is an honest fit under the rules above. There is no quota to hit. If only one role qualifies, apply to one. If none qualify, apply to none, say so plainly in your final report, and stop.
- **Never pad the run.** Do not apply to older postings, near misses, roles that stretch the profile, or anything you would skip on an ordinary day, just to have something to show.
- The cap in your assignment is a ceiling that protects the person, not a goal. Stop at the ceiling even if more fresh matches remain, and say so in your report.

## How to filter

- **LinkedIn:** set the time filter to the window: `f_TPR=r{{SECONDS}}` in the search URL, with `sortBy=DD` (most recent first). This replaces the day or week filters suggested elsewhere.
- **Company boards:** use the date fields in the feeds (Greenhouse `updated_at`, Ashby `publishedAt`, Lever `createdAt`) and drop anything older than {{HOURS}} hours. Greenhouse's `updated_at` can change when a posting is edited, so if the description says it has been open for longer, treat it as stale.
- **Aggregators:** sort by newest and apply the same window.

## Because nobody is watching

- Never wait for the person. Anything you cannot answer honestly is held, exactly as the hold rule says, and the person will see it in their inbox and in the morning digest.
- A sign-in page, a "verify it's you" screen, or a security check on any site means that site is off limits for this run. Stop using it, mention it in your final report, and carry on with other sources.
- If the browser stops responding (a dialog may be open) or Chrome is not reachable, finish with a short report saying so. Do not retry in a loop.

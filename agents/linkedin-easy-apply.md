# Source: LinkedIn Easy Apply

The person is already signed in to LinkedIn in this Chrome profile. If you land on a sign-in page, a "verify it's you" page, or a security challenge, stop working on LinkedIn, say so in your final report, and move on to the next source. Never type a password.

## Finding roles

Use LinkedIn job search URLs with filters rather than clicking through menus:

```
https://www.linkedin.com/jobs/search/?keywords=<title words>&f_AL=true&f_TPR=r86400&sortBy=DD
```

- `f_AL=true` shows only Easy Apply roles.
- `f_TPR=r3600` (last hour), `r14400`, `r43200`, `r86400` (last day), `r604800` (last week). Fresh postings are less likely to be closed or flooded, so start narrow.
- `f_WT=2` is remote, `f_WT=3` hybrid, `f_WT=1` on-site. Combine modes with a comma, such as `f_WT=2%2C3`.
- `f_E=2,3,4` filters experience level (2 entry, 3 associate, 4 mid-senior, 5 director).
- `location=<city or country>` and `geoId` when the person wants a specific place.
- Run one search per title or category from the person's preferences. Do not open dozens of postings from one search at once. Work down the list.

## Judging a posting

Open the posting in your own tab. Read the full description, not just the title. Decide quickly:

1. Does it fit the person's categories, seniority, work mode and location?
2. Is the listed pay at or above the floor? LinkedIn often shows a range at the top. Record it as shown; write "not listed" if absent.
3. Do any hard requirements disqualify it (see the skip rules)?
4. Run the duplicate check with the log helper before you start the form.

Only continue with postings that show an **Easy Apply** button. If the button says "Apply" and sends the person to another site, leave it for the company-board source unless the person's profile enabled that source and you were told to follow through; otherwise skip it with the note "external apply".

## Filling the Easy Apply dialog

- Contact info: use the profile's name, email, phone and location. If LinkedIn pre-fills something that disagrees with the profile, correct it.
- Resume: choose the uploaded resume if it matches the profile's resume file name. Otherwise upload the profile's file with the file upload tool. Do not generate a new resume.
- Work through every step ("Next", "Review"). Read each field and each question. Use the profile and the saved answers; apply the hold rule for anything required that you cannot answer.
- Numeric fields ("years of experience with X") must use numbers that are true according to the profile. If the profile gives a total and not a per-tool figure, only answer for tools it lists; otherwise hold.
- Untick "Follow company to stay up to date" before the final step.
- Do not use Premium upsells, "Reactivate Premium", or "Get hired faster" offers.
- Before the last click, read back every field value from the review page.

## Finishing a posting

{{MODE_FINISH_LINKEDIN}}

## Pace and limits

LinkedIn rate-limits and may restrict accounts that act too fast. Wait a few seconds between steps like a person would. If you see "You've reached the daily limit for Easy Apply" or a 429, stop applying on LinkedIn for this run and report it. Never try to work around a limit.

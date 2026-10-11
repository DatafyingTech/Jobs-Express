# Task: finish applications that were on hold

Earlier runs set aside some applications because a required question could not be answered from the profile. The person has since answered them, and the answers are now in the "Saved answers" list in the profile section. Your job is to go back to each held posting and complete it.

## The held list

{{HELD_LIST}}

## How to work

1. For each item, run the duplicate check first (`{{LOG_CMD}} check --company ... --role ... --url ...`). Skip the item only if the result says the status is `submitted`. A result of `"duplicate":true` with status `held` is expected here, because these postings were set aside earlier: carry on.
2. Open the posting URL in your own tab. If the posting is gone or closed, log it as skipped with the note "posting closed".
3. Start the application again from the beginning and fill it using the profile and the saved answers. The answer to the held question is in the saved answers; use it word for word where it fits.
4. If the form raises a **different** required question you cannot answer, hold it again with the new question.
5. If the reason it was held was an emailed verification code or a CAPTCHA, it is still held: do not try again. Log it as held with the same reason (for a code, the question `Needs the emailed verification code`) and move on.

## Finishing a posting

For items whose source is `linkedin`:

{{MODE_FINISH_LINKEDIN}}

For every other item:

{{MODE_FINISH_ATS}}

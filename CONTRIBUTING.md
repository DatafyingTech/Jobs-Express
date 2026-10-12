# Contributing

Thanks for wanting to help. This is a small project with one rule that matters more than the others:
**agents must never be nudged toward making things up.** Changes that make the prompts more eager to submit,
or less willing to hold an application, will not be merged. Changes that make them more careful will be.

## Running it

```
git clone https://github.com/DatafyingTech/Jobs-Express.git
cd Jobs-Express
node server.mjs --demo     # the UI with sample data, no Claude or Chrome needed
node --test                # the tests
```

There is no install step. Node 18 or newer is all you need. Please keep it that way: no runtime dependencies and no
build step. A dev-only tool may use Playwright if it is present (see `tools/record_demo.mjs`), but it must stay optional.

## Ground rules

- **No personal data, ever.** Not in code, tests, fixtures, screenshots, or the demo. Sample data is made up
  ("Alex Rivera", fictional companies) and labeled as sample data in the interface.
- **Never use `--dangerously-skip-permissions`**, and do not widen the agents' tool allow-list in
  `lib/runner.mjs` without a very good reason written in the pull request. Bash stays limited to
  `node tools/log.mjs`, there is no `Read`, `Edit` or `Write`, and every Chrome tool is named.
- **Nothing the app runs is built from free text.** The scheduler passes values to the operating system through
  validated fields or environment variables, never by splicing text into a command.
- **Everything stays local.** No telemetry, no remote calls from the app itself.
- **The server stays on `127.0.0.1`** and keeps its Host, Origin, `X-CJA` and per-launch token checks, with no CORS.
- **Prompt changes need tests.** `tests/prompts.test.mjs` pins the hard stops, the hold rule, and the Practice
  mode "stop before Submit" wording. If you change those on purpose, update the tests and say why.
- Style: plain ES modules, two-space indent, no framework. In the UI, follow the tokens at the top of
  `public/app.css` and keep to one accent colour.

## Good first contributions

- A guide for another application system (Workable, SmartRecruiters, Breezy) in `agents/`.
- More ways the preflight can explain a failure.
- Translations of the interface.
- Notes on what broke for you, with the redacted `runs/<id>/run.log` from your data folder.

## Pull requests

1. Open an issue first for anything bigger than a small fix.
2. Add or update tests. `node --test` must pass on your machine.
3. If you change the UI, run `node tools/record_demo.mjs --no-gif` and check the screenshots in `docs/images/`.
4. Describe what you changed and how you tried it.

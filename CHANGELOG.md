# Changelog

All notable changes to Jobs Express are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-11

### Added
- **Daily schedule.** Settings, Daily schedule: a time (any HH:MM), every day or weekdays, Practice (default) or Live
  (needs an explicit "I have reviewed Practice results and accept that applications will be submitted automatically"
  box), 1 to 3 agents, applications per run (default 10, hard maximum 25), a freshness window in hours (default 30, no
  quota: it applies to every honest fit and never pads the run), and a time cap (default 90 minutes). Buttons: Save
  schedule, Run a test now, Remove schedule. The dashboard shows "Next run tomorrow 4:10 AM / Last run: ...".
- `lib/scheduler.mjs`: creates, updates, queries and removes an operating-system job. Windows Task Scheduler
  (`JobsExpressDaily`, run only when signed in, start when available after a missed time, wake to run, a time limit),
  a macOS launchd agent, and a Linux systemd user timer with `Persistent=true` (crontab as a fallback). The generators
  are pure and unit tested; applying them goes through an injectable command runner. The Windows PowerShell is a
  constant that receives its values from environment variables after strict validation.
- `node server.mjs --scheduled-run`: the unattended run (preflight, lock, start Chrome if needed, wait for the Claude
  extension, fresh-only agents, time cap, process-tree kill), writing `data/digests/YYYY-MM-DD.md` and `.json` and
  `lastRun` in `data/schedule.json`. Missing prerequisites produce a "did not run" digest with a plain fix and a
  non-zero exit. `--dry-run` (with `--json`) prints what it would do and launches nothing. `--data-dir` picks another
  data folder.
- A `fresh-only` prompt variant with `{{HOURS}}`, and a "Daily digests" list in the app.
- One run at a time across the machine (a lock file shared by manual runs, scheduled runs and the test button).
- **Install Claude Code** and **Sign in to Claude** buttons in the requirements step. Install runs only the official
  installer commands from the Claude Code quickstart, after a dialog that shows the exact command and its source;
  sign in runs `claude auth login --claudeai`. Output streams to the page, and the checks re-run when it ends.
- A "Work history" field (employer, title, dates) in the honest profile, used verbatim by the agents.
- Emailed verification codes now show up in Needs your input with the company, role and link, and a "clear this" button,
  so you can enter the code yourself. The agents still never read your email.
- `check --claim` in `tools/log.mjs` (an atomic claim so two agents never take the same posting), `CJA_MODE`
  awareness, and `tools/guard.mjs`, which stops an agent if the app that started it disappears.
- Log lines for Claude API retries, plan usage limits and silent agents (a 5 minute watchdog).
- Node 18 and 22 in the CI matrix.

### Security
- The local server answers only `127.0.0.1`, `localhost` or `[::1]` on its own port (DNS rebinding), requires a matching
  Origin on every state-changing request, and requires a random per-launch token (header or `HttpOnly; SameSite=Strict`
  cookie, set when the page is served) on every API call and the live stream. No CORS headers, ever.
- Agents run with `--setting-sources project --permission-mode dontAsk`, so your own Claude settings cannot widen what a
  job posting can make them do. The `Read` tool is gone, `WebFetch` is limited to the public job-feed domains, Chrome
  tools are named one by one (no `javascript_tool`, `upload_image`, `gif_creator`, network or console readers, or batch
  tool), and the agent environment is an allow-list that never carries tokens, keys or passwords.
- Prompts fence everything from the profile, saved answers and held questions as data, collapse newlines in single-line
  fields, and add hard stops for uploads, secrets in URLs, government IDs and passwords, consent boxes and sites that ban
  automated applications.
- The data folder is private to your user (0700 and 0600, a restricted ACL on Windows); `saveResume` refuses a linked
  resume folder and checks file contents; oversized requests get a readable 413; a null or malformed body is a 400;
  corrupt `profile.json` is set aside and reported, never overwritten silently.

### Changed
- Practice rows no longer count as duplicates in a Live run (they are the ones to submit), and posting keys keep the
  query parameters that identify the job. Company names in any alphabet are compared properly.
- Reads that fail (a file locked by antivirus, say) retry briefly and then report an error instead of looking like
  "no data". A torn last line no longer swallows the next record.
- Saving settings sends only the fields changed in that tab, so a stale second tab cannot erase saved answers.
- One agent reaching its action limit stops only that agent. A stopped Live run marks postings that were mid-application
  as held and warns you to check your Applied lists.
- The resume is stored by name and found inside the data folder, so copying the folder to a new install works.
- Saved answers keep the newest 300 (the oldest is dropped, not the newest). Old run folders beyond the newest 20 are
  pruned.
- Pay accepts cents, focus stays on chips and toggles after you press them, the email and phone fields say when they look
  wrong, an unsaved wizard survives a reload, and the Applications table becomes cards below 1280 px.
- Launchers: a clear message when files are missing (extract the whole ZIP), real exit codes, and the macOS Sequoia
  "Open Anyway" note. `record_demo` no longer fails on Windows cleanup.

## [1.0.0] - 2026-10-09

First public release.

### Added
- One-click launchers: `Start.bat` (Windows, offers to install Node.js with winget), `start.command` (macOS) and
  `start.sh` (Linux). `npm start` works too.
- Local web app with no dependencies and no build step. The server binds to `127.0.0.1` only, picks a free port
  starting at 4317, and reopens an already-running copy instead of starting a second one.
- Six-point requirements check with plain-English fixes: Node version, Claude Code installed, signed in with a
  claude.ai plan (API-key logins are detected and explained), Chrome or Edge present, a real "Test connection" for
  the Claude in Chrome extension, and an explicit LinkedIn sign-in confirmation.
- Five-step setup wizard (welcome and requirements, about you, what you want, your honest profile, review and
  save), editable later in Settings.
- Dashboard with Practice and Live modes, one to three agents, a live activity log with a raw view, a Stop button,
  an applications table with filters and CSV export, and a "Needs your input" inbox with remembered answers and a
  re-run for answered held applications.
- Demo mode (`node server.mjs --demo`, or `?demo=1`) with fictional sample data and a scripted fake run.
- Agent prompts in `agents/`: shared honesty rules, hard stops and the hold rule, plus guides for LinkedIn Easy
  Apply, company job boards (Greenhouse, Ashby, Lever), and aggregators.
- `tools/log.mjs`, the only way agents record results, with duplicate checking.
- Runner that starts one `claude -p --chrome` process per agent with a narrow tool allow-list, no connectors other
  than Claude in Chrome, a time cap, a per-agent action cap, and a stop that kills the whole process tree.
- `tools/record_demo.mjs` to render the screenshots and demo GIF, and `tools/check_layout.mjs` to check every page for sideways scrolling at phone, tablet and desktop widths.
- A phone layout with a bottom tab bar, stacked cards in place of the table, and a quiet "still needed" note under the setup buttons.
- Tests for prompts, the log helper, preflight parsers, the profile store, the runner, and the server routes, run in
  CI on Ubuntu, Windows and macOS.

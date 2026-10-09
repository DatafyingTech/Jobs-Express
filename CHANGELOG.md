# Changelog

All notable changes to Jobs Express are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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

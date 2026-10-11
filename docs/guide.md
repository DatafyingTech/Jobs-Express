# Guide

A longer walk-through than the README. Read it once, then keep it for the day something looks odd.

## Your first hour

1. **Start the app** with `Start.bat`, `start.command`, or `./start.sh`. Leave the little terminal window open.
2. **Requirements.** The first wizard screen runs six checks. Fix any red row using the hint under it, then press
   **Re-check**. Two rows have a button that does the work for you:
   - **Install Claude Code** runs Anthropic's official installer. A dialog first shows the exact command and where it
     comes from, and nothing runs until you press the button in that dialog. The output streams into the page, and the
     check re-runs when it ends.
   - **Sign in to Claude** runs `claude auth login --claudeai`, which opens your browser to sign in with your Claude
     subscription. No API key is needed or wanted.

   Two more rows need you:
   - **Test connection** for the Claude in Chrome extension. It runs a tiny, harmless Claude request that asks the
     extension for the list of browser tabs. It takes five to ten seconds.
   - **LinkedIn** is a checkbox. Open LinkedIn in the Chrome profile that has the extension, sign in yourself, then
     tick the box. If you do not plan to use LinkedIn, switch it off in step 3 and ignore this row.
3. **About you** and **What you want.** Be specific about pay. The floor is what makes agents skip roles.
4. **Your honest profile.** This is the most important page in the app. Agents may claim only what is written here,
   so write real, checkable facts: years, **work history (employer, title, dates, one job per line)**, tools you have
   actually used, certifications you actually hold, and exactly what your education is. Forms ask for current and past
   employers all the time, and with no work history every one of them is held for you. Use "Never claim" for anything you would hate to see on an application.
5. **Run Practice mode with one agent and a batch of 5.** Watch the log. When it finishes, open **Applications**,
   open the ready ones, and look at what the agent filled in. This is where you find out whether your profile says what
   you meant it to say.
6. **Answer the questions** in **Needs your input**. Then press **Review and re-run** to let the agents finish the
   held postings. A site that emails a verification code is listed there too, with the company, role and a link:
   open it and type the code yourself. The agents never read your email.
7. **Go Live** only when Practice results look right.
8. **Optional: schedule it** (below).

## The daily schedule

Settings, **Daily schedule**. Choose a time, every day or weekdays, Practice or Live, 1 to 3 agents, the most
applications per run (default 10, never more than 25), the freshness window (default 30 hours) and the time cap
(default 90 minutes), then press **Save schedule**.

- **What it creates.** Windows: a Task Scheduler task named `JobsExpressDaily` (run only when you are signed in, start
  when available after a missed time, wake the PC). macOS: a launchd agent in `~/Library/LaunchAgents`. Linux: a
  systemd user timer with `Persistent=true`, or a crontab line if systemd user timers are not available. **Remove
  schedule** deletes it again. Your settings and digests stay.
- **What a run does.** It takes a lock (only one run at a time, shared with manual runs), checks Claude Code, your
  sign-in, your setup and LinkedIn confirmation, starts Chrome if it is closed, waits for the Claude extension to
  answer, then starts the agents with a prompt that only looks at postings from the last N hours. There is no quota:
  the agents apply to every honest fit inside the window and never pad. When the time cap passes, the agents and
  everything they started are killed and what finished is kept.
- **The digest.** Every run writes `data/digests/YYYY-MM-DD.md` and `.json` and updates `data/schedule.json`
  (`lastRun`: when it started and finished, the status, how many were submitted, ready, held and skipped, and any
  error). If a prerequisite is missing, the digest says "did not run" with a plain fix and the process exits non-zero.
- **Run a test now** is a small Practice run (3 applications, 30 minutes) through the same steps. Its dialog first shows
  a preview of what would happen and what would stop it.
- **Dry run from a terminal:** `node server.mjs --scheduled-run --dry-run` (add `--json`). It launches nothing.
- **What has to be true:** the computer is on, you are signed in to it, Chrome has the Claude extension signed in, and
  LinkedIn is signed in. A missed run starts when the computer wakes (not on a cron fallback, and not when it was shut
  down on macOS). If you move the folder or update Node.js, press **Save schedule** again.

## What each status means

| Status | Meaning |
|---|---|
| **Submitted** | The agent saw a confirmation page or message after submitting |
| **Ready to review** | Practice mode: the form was filled in and checked, and the agent stopped before Submit |
| **Held** | A required question could not be answered from your profile, or the site wanted something agents never do (an emailed code, a CAPTCHA, an account). See Needs your input |
| **Skipped** | Under your pay floor, excluded, a poor fit, already applied, or a form that demands human-written answers |

A held posting becomes Submitted later if you answer the question and re-run it. The table always shows the latest
state for each posting.

## Settings worth knowing

- **Run limits.** Every run stops after 45 minutes, and each agent stops after 200 actions (when one agent reaches its
  limit only that agent stops). Raise these in Settings if you run large batches. A stopped Live run marks anything
  that was mid-application as held, because it may have been sent without being recorded.
- **Saved answers.** Everything you answered in Needs your input. Delete one to be asked again.
- **Sources.** LinkedIn Easy Apply, company job boards, and aggregators can each be switched off.

## How the agents are told what to do

Each agent receives one prompt, assembled by `lib/prompts.mjs` from the files in `agents/`:

| File | What it holds |
|---|---|
| `mode-practice.md`, `mode-live.md` | The mode banner and the "finish a posting" steps. Practice never clicks the final Submit |
| `rules.md` | Honesty framework, hard stops, the hold rule, skip rules, how to record results, browser lessons |
| `linkedin-easy-apply.md` | LinkedIn search filters and the Easy Apply dialog |
| `ats-boards.md` | The public Greenhouse, Ashby and Lever feeds, filtering by work mode and pay, polite request limits |
| `aggregators.md` | Himalayas, Remote Rocket Ship, Hacker News "Who is hiring", Wellfound |
| `held.md` | The task for re-running answered held postings |
| `fresh-only.md` | Added to scheduled runs: only postings from the last N hours, no quota, never pad |

After the templates, the prompt gets a section with your profile, preferences and saved answers, fenced between
`PERSON-DATA-START` and `PERSON-DATA-END` and labelled as data, never instructions (text copied from postings, like held
questions, is fenced the same way). Placeholders look like `{{LIMIT}}`; the builder fills them in one pass, and a test
fails if any are left over.

If you edit the prompts, keep the hard stops and the hold rule. They are what stand between a helpful agent and an
agent that guesses.

## Where agents write

Agents never write files directly. They call one command:

```
node tools/log.mjs applied|ready|held|skipped --company "..." --role "..." --pay "..." --url "..." --note "..."
node tools/log.mjs check --claim --company "..." --role "..." --url "..."
```

`check --claim` also marks the posting as being worked on, so two agents never fill in the same application. In a Live
run a posting that was only filled in during Practice is not a duplicate: it is the one to submit.

That appends a JSON line to `data/applications.jsonl` (and `data/held.jsonl` for held questions). The dashboard reads
those files. Because it is a plain append-only file, you can read it, back it up, or load it into a spreadsheet.

## The data folder

```
data/
  profile.json         your answers and saved Q&A
  state.json           your last connection test and LinkedIn confirmation
  schedule.json        your daily schedule and the result of the last run
  digests/             one .md and .json per daily run
  applications.jsonl   one line per outcome
  held.jsonl           questions waiting on you, and your answers
  claims.jsonl         which agent is working on which posting (short-lived)
  run.lock             present while a run is going, so only one runs at a time
  scheduled-run.log    what the unattended runs printed
  resume/              the copy of your resume agents upload
  runs/<id>/           run.log (readable) and agent-N.jsonl (raw output); the newest 20 runs are kept
```

The folder is private to your user account. Set `CJA_DATA_DIR` (or pass `--data-dir`) to keep it somewhere else.
If `profile.json` ever cannot be read, it is kept as `profile.json.corrupt-<time>` and the app tells you.

## Command-line options

```
node server.mjs                 start normally
node server.mjs --demo          fictional sample data, nothing real is touched
node server.mjs --port 4400     start looking for a free port at 4400
node server.mjs --no-open       do not open a browser window
node server.mjs --data-dir D:\JobsData   use another data folder
node server.mjs --scheduled-run             what the daily job runs (no window)
node server.mjs --scheduled-run --dry-run   print what it would do, launch nothing (--json for machine output)
```

Environment variables: `CJA_DATA_DIR`, `CJA_NO_OPEN=1`, `CJA_CLAUDE` (full path to the `claude` program),
`CJA_PLAYWRIGHT_DIR` (dev tools only), `CJA_SCHEDULE_TASK_NAME` (testing: a name like `JobsExpressDaily-TEST-abc123`).

## Notes on how it talks to Claude Code

- Each agent is started as `claude -p --chrome --output-format stream-json --verbose --no-session-persistence
  --disable-slash-commands --strict-mcp-config --mcp-config agents/empty-mcp.json --setting-sources project
  --permission-mode dontAsk --tools WebFetch WebSearch Bash --disallowedTools ... --allowedTools ...`. The prompt is
  written to standard input. Each one runs under `tools/guard.mjs`, which stops it if the app disappears.
- `--strict-mcp-config` with an empty config switches off your other connectors for these runs. The Claude in
  Chrome tools still load, because that integration is built in.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the agents' environment, so Claude Code uses your
  claude.ai login, which the Chrome integration requires.
- Your own Claude Code settings, hooks and plugins are **not** loaded for agent runs (`--setting-sources project`), and
  nothing outside the allow-list can run (`dontAsk`). That is deliberate: a broad allow rule in your own settings would
  otherwise let a malicious job posting run commands on your computer. Environment variables are passed through an
  allow-list too, so tokens and keys in your shell never reach an agent.

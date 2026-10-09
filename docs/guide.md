# Guide

A longer walk-through than the README. Read it once, then keep it for the day something looks odd.

## Your first hour

1. **Start the app** with `Start.bat`, `start.command`, or `./start.sh`. Leave the little terminal window open.
2. **Requirements.** The first wizard screen runs six checks. Fix any red row using the hint under it, then press
   **Re-check**. Two rows need you:
   - **Test connection** for the Claude in Chrome extension. It runs a tiny, harmless Claude request that asks the
     extension for the list of browser tabs. It takes five to ten seconds.
   - **LinkedIn** is a checkbox. Open LinkedIn in the Chrome profile that has the extension, sign in yourself, then
     tick the box. If you do not plan to use LinkedIn, switch it off in step 3 and ignore this row.
3. **About you** and **What you want.** Be specific about pay. The floor is what makes agents skip roles.
4. **Your honest profile.** This is the most important page in the app. Agents may claim only what is written here,
   so write real, checkable facts: years, job titles, tools you have actually used, certifications you actually hold, and
   exactly what your education is. Use "Never claim" for anything you would hate to see on an application.
5. **Run Practice mode with one agent and a batch of 5.** Watch the log. When it finishes, open **Applications**,
   open the ready ones, and look at what the agent filled in. This is where you find out whether your profile says what
   you meant it to say.
6. **Answer the questions** in **Needs your input**. Then press **Review and re-run** to let the agents finish the
   held postings.
7. **Go Live** only when Practice results look right.

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

- **Run limits.** Every run stops after 45 minutes, and each agent stops after 200 actions. Raise these in Settings
  if you run large batches.
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

After the templates, the prompt gets a section with your profile, preferences and saved answers. Placeholders look like
`{{LIMIT}}`; the builder fills them in one pass, and a test fails if any are left over.

If you edit the prompts, keep the hard stops and the hold rule. They are what stand between a helpful agent and an
agent that guesses.

## Where agents write

Agents never write files directly. They call one command:

```
node tools/log.mjs applied|ready|held|skipped --company "..." --role "..." --pay "..." --url "..." --note "..."
node tools/log.mjs check --company "..."
```

That appends a JSON line to `data/applications.jsonl` (and `data/held.jsonl` for held questions). The dashboard reads
those files. Because it is a plain append-only file, you can read it, back it up, or load it into a spreadsheet.

## The data folder

```
data/
  profile.json         your answers and saved Q&A
  state.json           your last connection test and LinkedIn confirmation
  applications.jsonl   one line per outcome
  held.jsonl           questions waiting on you, and your answers
  resume/              the copy of your resume agents upload
  runs/<id>/           run.log (readable) and agent-N.jsonl (raw output)
```

Set `CJA_DATA_DIR` to keep it somewhere else.

## Command-line options

```
node server.mjs                 start normally
node server.mjs --demo          fictional sample data, nothing real is touched
node server.mjs --port 4400     start looking for a free port at 4400
node server.mjs --no-open       do not open a browser window
```

## Notes on how it talks to Claude Code

- Each agent is started as `claude -p --chrome --output-format stream-json --verbose --no-session-persistence
  --disable-slash-commands --strict-mcp-config --mcp-config agents/empty-mcp.json --tools Read WebFetch WebSearch
  Bash --allowedTools ...`. The prompt is written to standard input.
- `--strict-mcp-config` with an empty config switches off your other connectors for these runs. The Claude in
  Chrome tools still load, because that integration is built in.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the agents' environment, so Claude Code uses your
  claude.ai login, which the Chrome integration requires.
- Your own Claude Code settings and hooks still apply, since they belong to you. If a hook interferes with runs, tell
  us in an issue.

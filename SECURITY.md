# Security policy

Jobs Express is a small local app maintained by [Datafying Tech](https://datafying.tech). It handles
personal information (your profile and resume) and drives a browser you are signed in to, so we take reports
seriously and will answer every one.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Tell us what you found, how to reproduce it, and what an attacker could do with it.

Private vulnerability reporting is enabled on this repository, so the **Report a vulnerability** button on the Security
tab is the way to reach us. Please include the app version (shown in the sidebar), your operating system, and your Node.js version.

**What to expect.** We aim to acknowledge a report within 3 business days and to have a fix or a clear plan within 30 days.
We will credit you in the release notes unless you would rather we did not. This is a free project with no bug bounty.

## Scope

**In scope:**

- Anything that lets a web page or another local user reach the app's API or read `data/` (DNS rebinding, CSRF,
  path traversal, a bypass of the Host, Origin, `X-CJA` or per-launch token checks).
- Anything that lets text from a profile, a job posting or a web page become a command (including the scheduled task,
  the install and sign-in buttons, and the log helper).
- Writing files outside the data folder, including through resume uploads or profile fields.
- Command injection through profile text, filenames, or the `tools/log.mjs` helper.
- Ways to make an agent run a tool outside its allow-list, or to widen that list.
- Anything that sends your profile, resume, or logs anywhere other than Claude Code and the sites you apply to.
- Prompt-injection paths that make an agent break a hard stop (create an account, enter a password, click a CAPTCHA,
  message someone) from the contents of a web page.

**Out of scope:**

- An attacker who already has code execution on your computer as your user. They can read `data/` directly.
- The fact that `data/` is plain text on disk. It is documented, and you can delete it any time.
- Behaviour of Claude Code, the Claude in Chrome extension, Chrome, or the job sites. Report those upstream.
- Your account being limited by a site because you used automation. See "Responsible use and limits" in the README.
- Findings from automated scanners with no working path through this code.

## The attack surface, in short

- The server listens on `127.0.0.1` only and answers only a `Host` of `127.0.0.1`, `localhost` or `[::1]` on its own port,
  which defeats DNS rebinding. Every request that changes something must come from the app's own origin and carry a
  custom `X-CJA` header. Every API call (and the live event stream) must carry a random per-launch token that is
  only embedded in the page the server itself serves, in a header or an `HttpOnly; SameSite=Strict` cookie. There is
  no CORS: no `Access-Control-*` header is ever sent. Together these stop a website you visit from starting agents or
  reading your data through localhost.
- The data folder is created private to your user account, and the profile, answers and run logs are never sent anywhere
  by the app itself.
- It serves only the files in `public/`, and writes only inside `data/`.
- Agents are started with `claude -p --chrome --setting-sources project --permission-mode dontAsk` and an allow-list: a
  named list of Chrome tools (no `javascript_tool`, screenshot upload or batch tool), `WebFetch` for a few public
  job-feed domains, `WebSearch`, and `Bash(node tools/log.mjs:*)`. There is no `Read`, `Edit` or `Write`. Your own Claude
  settings and other MCP connectors are disabled for these runs, and the agent environment is an allow-list that
  never includes tokens or keys. Claude Code's built-in read-only shell commands (for example `echo`) can still run
  inside the project folder. The prompt travels on standard input.
- The daily schedule registers an operating-system job through fixed scripts and validated fields. The Windows task is
  created by a constant PowerShell script that receives its values from environment variables. The install button runs
  only Anthropic's official installer commands, shown to you first.
- Web pages are untrusted input to the agents. The prompts tell them to ignore instructions found in pages, and a
  prompt cannot be a security boundary on its own, which is why the tool allow-list exists.

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

Please include the app version (shown in the sidebar), your operating system, and your Node.js version.

**What to expect.** We aim to acknowledge a report within 3 business days and to have a fix or a clear plan within 30 days.
We will credit you in the release notes unless you would rather we did not. This is a free project with no bug bounty.

## Scope

**In scope:**

- Anything that lets a web page or another local user reach the app's API or read `data/` (DNS rebinding, CSRF,
  path traversal, a bypass of the Host or `X-CJA` header checks).
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

- The server listens on `127.0.0.1` only, rejects any request whose `Host` is not localhost, and requires a custom
  `X-CJA` header on every request that changes something, which a cross-site page cannot send.
- It serves only the files in `public/`, and writes only inside `data/`.
- Agents are started with `claude -p --chrome` and an allow-list: the Chrome tools, `Read`, `WebFetch`, `WebSearch`, and
  `Bash(node tools/log.mjs:*)`. Other MCP connectors are disabled for these runs. The prompt travels on standard input.
- Web pages are untrusted input to the agents. The prompts tell them to ignore instructions found in pages, and a
  prompt cannot be a security boundary on its own, which is why the tool allow-list exists.

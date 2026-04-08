---
name: site-use
description: "Personal AI for social media — collect tweets, daily digest, track topics, search cached posts. Use when the user wants to browse Twitter/X, get a summary of what's happening, monitor topics long-term, or analyze cached social media data. Examples: 'what's hot today', 'grab latest tweets', 'search Twitter for AI news', 'track this topic for a week', 'set up site-use'"
metadata: { "openclaw": { "emoji": "🌐", "homepage": "https://github.com/WilliamPenrose/site-use", "requires": { "bins": ["site-use"] }, "install": [{ "kind": "node", "package": "site-use", "bins": ["site-use"] }] } }
---

# site-use — Personal Social Media AI

## Scope

Only use `site-use` commands listed in the reference docs below.
Do not use puppeteer, chrome-devtools-mcp, or any other browser automation tool directly.

## Onboard Check (MUST DO FIRST)

Before handling any request, check if the user has a Memory entry with social media preferences (interests, ignored topics, preferred sources).

- **No user profile in Memory** → Follow [onboard-guide.md](./references/onboard-guide.md) before doing anything else.
- **Has user profile** → Proceed to intent routing.

## Intent Decision Tree

| User intent | Signal keywords | Action |
|-------------|----------------|--------|
| **Collect** | "grab tweets", "fetch timeline", "what's on Twitter", search queries | → [twitter-commands.md](./references/twitter-commands.md) |
| **Digest** | "what's hot", "today's summary", "any updates", "briefing" | → [digest-guide.md](./references/digest-guide.md) |
| **Watch** | "track this", "monitor", "keep an eye on", "alert me if" | → [watch-guide.md](./references/watch-guide.md) |
| **Deep dive** | "tell me more about", "expand on", "show replies" | → [twitter-commands.md](./references/twitter-commands.md) (tweet_detail + search) |
| **Setup** | "set up site-use", "launch browser", "login" | → If no Memory profile, follow onboard flow first. Otherwise run `site-use browser launch` |
| **Cached data** | "what did we collect", "search cached", "yesterday's posts" | → [twitter-commands.md](./references/twitter-commands.md) (search, --local) |

Key distinction: **Digest** = summarize + ask for feedback + update preferences. **Collect** = just fetch data and show it.

## First-time Setup

If the user has no Memory profile, this is handled as part of the onboard flow (see [onboard-guide.md](./references/onboard-guide.md) Phase 2).

If the user already has a Memory profile but the browser isn't running, just run `site-use browser launch` and follow the Error Recovery table below. The launched Chrome uses an isolated profile — the user's regular browser data is never exposed.

## Error Recovery

| Error | Action |
|-------|--------|
| **SessionExpired** | Ask the user to log in manually in Chrome, then retry |
| **RateLimited** | Stop ALL twitter commands. Wait 15+ min. Use `search` for cached data meanwhile |
| **BrowserDisconnected** | Run `site-use browser launch`, then retry |
| **BrowserNotRunning** | Run `site-use browser launch` first |
| **ElementNotFound** | Page may still be loading. Wait a few seconds, retry |
| **Unknown command / option** | The installed CLI is older than this skill. Tell the user: "Your site-use CLI is missing a command this skill needs. Run `npm install -g site-use@latest` to upgrade, then retry." |

### Rate limiting deserves extra care

- Do not retry immediately. Wait for the reset time shown in the error.
- Do not run any twitter commands during cooldown — this can extend the limit.
- Switch to offline work — use `search` to analyze cached data.
- If "account suspended" appears, alert the user — this is a policy issue, not a quota issue.

## Constraints

- **Sequential only.** Never run multiple `site-use` commands in parallel — they share a single browser tab. Run them one at a time.

## References (read on demand)

- [references/twitter-commands.md](./references/twitter-commands.md) — All Twitter CLI commands, flags, smart cache, examples
- [references/onboard-guide.md](./references/onboard-guide.md) — First-time user profiling conversation flow
- [references/digest-guide.md](./references/digest-guide.md) — Daily digest generation, feedback loop, preference updates
- [references/watch-guide.md](./references/watch-guide.md) — Long-term topic monitoring and conditional alerts

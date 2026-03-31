---
name: site-use
description: Guide for using site-use CLI to collect and search social media content. Use this skill whenever you need to collect tweets, search cached posts, get tweet details, check login status, or troubleshoot site-use errors like SessionExpired or RateLimited. Trigger even if the user doesn't mention "site-use" by name — any request about Twitter feed collection, tweet analysis, or social media search should use this skill.
---

# Using site-use CLI

site-use is a browser automation tool for social media. Run CLI commands via Bash — the output is visible to both you and the user, keeping the workflow transparent.

All collected data is automatically stored in a local SQLite knowledge base, so you can search past results without re-fetching.

All CLI output is JSON. Timestamps are ISO 8601 in the user's **local timezone** (e.g. `2026-03-29T10:03:00+08:00`), not UTC.

## Commands

| Command | Purpose |
|---------|---------|
| `npx site-use twitter feed` | Collect tweets from timeline |
| `npx site-use twitter tweet_detail` | Get a specific tweet and its replies |
| `npx site-use twitter check-login` | Check if user is logged in |
| `npx site-use search` | Full-text search over previously collected posts |
| `npx site-use browser launch` | Launch Chrome (if not running) |
| `npx site-use browser status` | Show Chrome connection status |
| `npx site-use browser close` | Kill Chrome and clean up |
| `npx site-use stats` | Show storage statistics |

## Workflow Patterns

### Collecting tweets

Just run `twitter feed` directly — the framework auto-checks login. If the user isn't logged in, you'll get a `SessionExpired` error with a clear hint.

```bash
npx site-use twitter feed --count 30 --tab for_you
```

Results are auto-stored in the knowledge base. Follow up with `search` to query them.

Reserve `twitter check-login` for when the user explicitly asks about login status.

### Getting a specific tweet

```bash
npx site-use twitter tweet_detail --url https://x.com/AnthropicAI/status/1234567890 --count 30
```

Returns JSON with `items[0]` as the anchor tweet, `items[1..n]` as replies. Each reply has `siteMeta.inReplyTo` for threading context. Quoted tweets are nested under `siteMeta.quotedTweet`.

### Searching cached data

`search` queries the local knowledge base — it does NOT fetch new data.

```bash
# Search by keyword
npx site-use search "Claude Code" --min-likes 100

# Search by author, date range
npx site-use search --author elonmusk --start-date "2026-03-28" --end-date "2026-03-29"

# Compact output with specific fields
npx site-use search "AI" --fields author,text,url --max-results 10
```

Dates in `--start-date` / `--end-date` use **local timezone** automatically — no need to specify offsets.

### Cache vs. fresh fetch

`twitter feed` has smart caching (default 120 min):

```bash
# Force local cache only (no browser needed)
npx site-use twitter feed --local --tab following

# Force fresh fetch from browser
npx site-use twitter feed --fetch --count 50
```

Use `--local` when the browser isn't running or you want to avoid rate limits.

## Command Reference

### twitter feed

```
npx site-use twitter feed [options]
  --count <n>          Number of tweets, 1-100 (default: 20)
  --tab <name>         following | for_you (default: for_you)
  --local              Force local cache query (no browser)
  --fetch              Force fetch from browser (skip freshness check)
  --max-age <minutes>  Max cache age before auto-fetching (default: 120)
  --fields <list>      Comma-separated: author,text,url,timestamp,links,mentions,media
  --debug              Include diagnostic trace
```

- **`for_you`** — algorithmic feed, personalized recommendations
- **`following`** — chronological, only accounts the user follows

### twitter tweet_detail

```
npx site-use twitter tweet_detail [options]
  --url <url>          Tweet URL (required)
  --count <n>          Max replies, 1-100 (default: 20)
  --fields <list>      Comma-separated: author,text,url,timestamp,links,mentions,media
  --debug              Include diagnostic trace
```

### twitter check-login

```
npx site-use twitter check-login
```

No options. Returns `{ loggedIn: boolean }`.

### search

```
npx site-use search [query] [options]

Filters:
  --author <name>         Filter by author (@ prefix optional)
  --start-date <date>     Start date (local time, flexible format)
  --end-date <date>       End date (local time, flexible format)
  --hashtag <tag>         Filter by hashtag
  --mention <handle>      Filter by mentioned handle (@ prefix optional)
  --surface-reason <r>    original | retweet | quote | reply
  --min-likes <n>         Minimum likes
  --min-retweets <n>      Minimum retweets

Output:
  --max-results <n>       Max results (default: 20)
  --fields <list>         Comma-separated: author,text,url,timestamp,links,mentions,media
```

## Diagnosing with Screenshots

When you need to see the browser state (e.g., after an error, or to verify what page is loaded):

```bash
npx site-use screenshot --site twitter
# → {"screenshot": "~/.site-use/screenshots/twitter.png"}
```

Then use the Read tool to view the image file. The file is overwritten each time — no cleanup needed.

## Error Handling

Errors are JSON with a type, message, hint, and execution trace (even without `--debug`). Common ones:

| Error Type | What to Do |
|------------|------------|
| **SessionExpired** | Ask the user to log in manually in the Chrome window, then retry |
| **RateLimited** | Stop all Twitter operations. Wait at least 15 minutes. Use `search` for cached data meanwhile |
| **BrowserDisconnected** | Run `site-use browser launch`, then retry |
| **BrowserNotRunning** | Run `site-use browser launch` first |
| **ElementNotFound** | Page may still be loading. Wait a few seconds, retry |

### Rate limiting deserves extra care

- **Do not retry immediately.** Wait for the reset time shown in the error.
- **Do not run any twitter commands** during cooldown — this can extend the limit.
- **Switch to offline work** — use `search` to analyze already-collected data.
- If "account suspended" appears, alert the user — this is a policy issue, not a quota issue.

## Time Convention

All timestamps in output are **local timezone ISO 8601** (e.g. `2026-03-29T10:03:00+08:00`). Date filter options (`--start-date`, `--end-date`) accept flexible local formats — `"2026-03-29"`, `"yesterday"`, `"2026-03-29 10:00"` all work.

When the user doesn't specify a time range, **default to the last 24 hours**. Most users care about recent content. If they want older data, they'll ask explicitly.

## Tips

- **Always use `--fields` to control output size.** CLI output that exceeds ~30KB gets truncated and saved to a temp file, forcing extra read steps. Always pass `--fields author,text,url` (or whichever fields you need) to keep output compact. A single well-scoped command should be enough — avoid multi-step parse-from-file workflows.
- **Prefer `search` over re-fetching.** If tweets were collected recently, search the cache instead of running `twitter feed` again. Saves time and avoids rate limits.
- **Use `--local` for offline analysis.** When the browser isn't running or you want speed, `twitter feed --local` reads from cache without touching the browser.
- **Use `--debug` when troubleshooting.** Adds diagnostic trace showing navigation actions, tab switches, and timing. On errors, trace is always included regardless of `--debug`.
- **Short search queries are slow.** Full-text search needs 3+ characters. Shorter queries fall back to a full table scan.
- **Combine filters for precision.** `search "AI" --min-likes 500 --start-date "yesterday"` is more useful than a broad search.

# Twitter Commands Reference

## Intent Freshness

Determine whether to fetch fresh data or use cache based on the user's intent.

| Freshness | Signal | Example intents | Strategy |
|-----------|--------|-----------------|----------|
| **High** | User explicitly asks for "now/today/latest/trending/breaking" | "what's trending", "latest news on X" | Always `--fetch` |
| **Medium** | No explicit time, but topic is time-sensitive | "any updates on Claude Code", "what happened with the outage" | Prefer `--fetch` |
| **Low** | Retrospective or analysis, references past time | "analyze last week's AI discussions", "what did we collect yesterday" | `--local` or default cache |

**Default:** When freshness is ambiguous, prefer fetch. The cost of missing breaking news outweighs an extra fetch.

## Commands

### twitter feed

Collect tweets from the home timeline. Results are auto-stored in the local knowledge base.

```
site-use twitter feed [options]
  --count <n>          Number of tweets, 1-100 (default: 20)
  --tab <name>         Feed tab (default: for_you). Supports for_you,
                       following, or the exact name of any pinned List
                       or Community (case-insensitive).
  --local              Force local cache query (no browser)
  --fetch              Force fetch from browser (skip freshness check)
  --max-age <minutes>  Max cache age before auto-fetching (default: 120)
  --fields <list>      Comma-separated: author,text,url,timestamp,links,mentions,media
  --dump-raw [dir]     Dump raw GraphQL responses to a directory
                       (default: ~/.site-use/dump/{site}/). See "Raw dumps" tip.
  --quiet, -q          Suppress JSON output, show one-line summary only
  --debug              Include diagnostic trace
```

- **`for_you`** — algorithmic feed, personalized recommendations
- **`following`** — chronological, only accounts the user follows
- **`<list-or-community-name>`** — any List or Community the user has pinned to their nav. Use the exact display name, e.g. `--tab "RAG and AI Agent Developers"`. Discover available tabs by running `feed` once and checking `meta.extra.availableTabs` in the output.

Just run `twitter feed` directly — the framework auto-checks login. If the user isn't logged in, you'll get a `SessionExpired` error with a clear hint.

### twitter search

Search tweets on Twitter. Supports Twitter search operators.

```
site-use twitter search [options]
  --query <text>       Search query (required, supports Twitter operators)
  --tab <name>         top | latest (default: top)
  --count <n>          Number of tweets, 1-100 (default: 20)
  --fields <list>      Comma-separated: author,text,url,timestamp,links,mentions,media
  --dump-raw [dir]     Dump raw GraphQL responses to a directory
                       (default: ~/.site-use/dump/{site}/). See "Raw dumps" tip.
  --quiet, -q          Suppress JSON output, show one-line summary only
  --debug              Include diagnostic trace
```

### twitter tweet_detail

Get a specific tweet and its replies.

```
site-use twitter tweet_detail [options]
  --url <url>          Tweet URL (required)
  --count <n>          Max replies, 1-100 (default: 20)
  --fields <list>      Comma-separated: author,text,url,timestamp,links,mentions,media
  --dump-raw [dir]     Dump raw GraphQL responses to a directory
                       (default: ~/.site-use/dump/{site}/). See "Raw dumps" tip.
  --quiet, -q          Suppress JSON output, show one-line summary only
  --debug              Include diagnostic trace
```

Returns JSON with `items[0]` as the anchor tweet, `items[1..n]` as replies. Each reply has `siteMeta.inReplyTo` for threading. Quoted tweets are nested under `siteMeta.quotedTweet`.

### twitter check-login

```
site-use twitter check-login
```

No options. Returns `{ loggedIn: boolean }`. Reserve for when the user explicitly asks about login status — `twitter feed` auto-checks login already.

### twitter profile

View a user profile and your follow relationship to them.

```
site-use twitter profile [options]
  --handle <user>      Twitter handle (with or without @)
  --url <url>          Profile URL (alternative to --handle)
  --debug              Include diagnostic trace
```

Returns `{ user, relationship }`. The `user` object includes `followersCount`, `followingCount`, `tweetsCount`, `bio`, `verified`, `createdAt`, `location`, `website`. The `relationship` object includes `youFollowThem`, `theyFollowYou`, `blocking`, `muting`.

Use this to verify follower counts and bios when filtering candidate accounts (e.g. "find builders with 1k–15k followers"), or to check whether you already follow someone before deciding to engage.

### twitter follow / unfollow

Follow or unfollow a user. **State-changing** — use only when the user explicitly asks.

```
site-use twitter follow   --handle <user>
site-use twitter unfollow --handle <user>
```

Both accept `--handle` or `--url`. Returns the resulting relationship state. Idempotent: re-following someone you already follow is a no-op.

### search (local knowledge base)

Query the local knowledge base. Does NOT fetch new data.

```
site-use search [query] [options]

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

### Browser management

```bash
site-use browser launch     # Launch Chrome (detached)
site-use browser status     # Show connection status
site-use browser close      # Kill Chrome and clean up
```

### Screenshots

```bash
site-use screenshot --site twitter
# Returns: {"screenshot": "~/.site-use/screenshots/twitter.png"}
```

Then use the Read tool to view the image file.

### Stats

```bash
site-use stats              # Show storage statistics
```

## Field Semantics

| Field | Meaning |
|-------|---------|
| `author.following` | The author **follows you** (the logged-in user), not "you follow the author" |

## Smart Cache

`twitter feed` has smart caching (default 120 min):

| Flag | Behavior |
|------|----------|
| (none) | Check cache freshness; fetch if stale (> `--max-age`) |
| `--local` | Force local cache only — no browser needed |
| `--fetch` | Force fresh fetch — skip freshness check |
| `--max-age <min>` | Custom staleness threshold (default: 120) |

## Time Convention

All timestamps are **local timezone ISO 8601** (e.g. `2026-03-29T10:03:00+08:00`). Date filters (`--start-date`, `--end-date`) accept flexible local formats — `"2026-03-29"`, `"yesterday"`, `"2026-03-29 10:00"` all work.

When the user doesn't specify a time range, default to the last 24 hours.

## Tips

- **Always use `--fields` to control output size.** Output exceeding ~30KB gets truncated to a temp file. Always pass `--fields author,text,url` (or whichever fields needed) to keep output compact.
- **Prefer `search` over re-fetching.** If tweets were collected recently, search the cache instead. Saves time and avoids rate limits.
- **Use `--local` for offline analysis.** When the browser isn't running or you want speed, `--local` reads from cache without touching the browser.
- **Use `--debug` when troubleshooting.** Adds diagnostic trace. On errors, trace is always included regardless of `--debug`.
- **Short search queries are slow.** Full-text search needs 3+ characters. Shorter queries fall back to a full table scan.
- **Combine filters for precision.** `search "AI" --min-likes 500 --start-date "yesterday"` is more useful than a broad search.
- **Raw dumps for fields the parser doesn't expose.** The raw GraphQL responses contain richer data than the structured output (e.g. user `followers_count`, full profile bio, full media metadata). Pass `--dump-raw <fresh-dir>` to `feed` / `search` / `tweet_detail`, then walk the JSON for the field you need. Use a fresh directory each time — the default location only keeps the 2-3 most recent responses.

## Examples

### Daily hot topics briefing (High freshness)

```bash
# 1. Fetch fresh timeline
site-use twitter feed --fetch --count 50 --tab for_you --fields author,text,url

# 2. Filter high-engagement posts from cache
site-use search --start-date "today" --min-likes 100 --fields author,text,url
```

User says "what's hot today" → freshness is high, always fetch first, then filter.

### Breaking news search (High freshness)

```bash
site-use twitter search --query "Claude Code" --count 30 --fields author,text,url
```

Topic is actively unfolding → always fetch. Do NOT rely on cache for breaking events.

### Retrospective analysis (Low freshness)

```bash
# Pure cache query, no browser needed
site-use search "AI agent" --start-date "2026-03-24" --end-date "2026-03-28" --min-likes 50 --fields author,text,url

# Or explicitly local
site-use twitter feed --local --tab for_you --fields author,text,url
```

User asks about past data → use cache. No reason to fetch.

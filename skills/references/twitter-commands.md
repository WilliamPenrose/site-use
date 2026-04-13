# Twitter Commands Reference

## Commands

### twitter feed

Collect tweets from the home timeline.

```
site-use twitter feed [options]
  --count <n>          Number of tweets, 1-100 (default: 20)
  --tab <name>         Feed tab (default: for_you). Supports for_you,
                       following, or the exact name of any pinned List
                       or Community (case-insensitive).
  --stdout             Full JSON output to stdout (default: write to file)
  --output <path>      Write output to specific file path
  --fields <list>      Comma-separated fields to keep on each item (e.g. author,text,url)
  --dump-raw [dir]     Dump raw GraphQL responses to a directory
                       (default: ~/.site-use/dump/{site}/). See "Raw dumps" tip.
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
  --stdout             Full JSON output to stdout (default: write to file)
  --output <path>      Write output to specific file path
  --fields <list>      Comma-separated fields to keep on each item (e.g. author,text,url)
  --dump-raw [dir]     Dump raw GraphQL responses to a directory
                       (default: ~/.site-use/dump/{site}/). See "Raw dumps" tip.
  --debug              Include diagnostic trace
```

### twitter tweet_detail

Get a specific tweet and its replies.

```
site-use twitter tweet_detail [options]
  --url <url>          Tweet URL (required)
  --count <n>          Max replies, 1-100 (default: 20)
  --stdout             Full JSON output to stdout (default: write to file)
  --output <path>      Write output to specific file path
  --fields <list>      Comma-separated fields to keep on each item (e.g. author,text,url)
  --dump-raw [dir]     Dump raw GraphQL responses to a directory
                       (default: ~/.site-use/dump/{site}/). See "Raw dumps" tip.
  --debug              Include diagnostic trace
```

Returns JSON with `items[0]` as the anchor tweet, `items[1..n]` as replies. Each reply has `siteMeta.inReplyTo` for threading. Quoted tweets are nested under `siteMeta.quotedTweet`. If the anchor tweet is itself a reply, the response includes an `ancestors` array — the full conversation chain leading to the anchor, ordered from root to parent.

### twitter check-login

```
site-use twitter check-login
```

No options. Returns `{ loggedIn: boolean }`. Reserve for when the user explicitly asks about login status — `twitter feed` auto-checks login already.

### twitter profile

View a user profile, their posts, replies, following, or followers.

```
site-use twitter profile [options]
  --handle <user>      Twitter handle (with or without @)
  --url <url>          Profile URL (alternative to --handle)
  --posts              Include user's recent tweets
  --replies            Include user's replies
  --following           List accounts this user follows
  --followers           List accounts that follow this user
  --count <n>          Number of items, 1-500 (default: 20)
  --debug              Include diagnostic trace
```

Without `--posts`/`--replies`/`--following`/`--followers`, returns `{ user, relationship }`. The `user` object includes `followersCount`, `followingCount`, `tweetsCount`, `bio`, `verified`, `createdAt`, `location`, `website`. The `relationship` object includes `youFollowThem`, `theyFollowYou`, `blocking`, `muting`.

With `--posts` or `--replies`, returns `FeedItem[]` — the same format as `twitter feed`. Each reply item has a top-level `inReplyTo` field. `--posts` and `--replies` can be combined.

With `--following` or `--followers`, returns a list of user profiles.

Omitting `--handle` queries the logged-in user's own profile (e.g. `twitter profile --following` lists who you follow).

Use this to verify follower counts and bios when filtering candidate accounts (e.g. "find builders with 1k-15k followers"), or to check whether you already follow someone before deciding to engage.

### twitter follow / unfollow

Follow or unfollow a user. **State-changing** — use only when the user explicitly asks.

```
site-use twitter follow   --handle <user>
site-use twitter unfollow --handle <user>
```

Both accept `--handle` or `--url`. Returns the resulting relationship state. Idempotent: re-following someone you already follow is a no-op.

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

## Field Semantics

| Field | Meaning |
|-------|---------|
| `author.following` | The author **follows you** (the logged-in user), not "you follow the author" |

## Time Convention

All timestamps are **local timezone ISO 8601** (e.g. `2026-03-29T10:03:00+08:00`). Date filters (`--start-date`, `--end-date`) accept flexible local formats — `"2026-03-29"`, `"yesterday"`, `"2026-03-29 10:00"` all work.

When the user doesn't specify a time range, default to the last 24 hours.

## Tips

- **Use `--fields` to control output size.** Full tweet JSON includes media, links, siteMeta, metrics — easily 30KB+ for 50 tweets. Always pass `--fields author,text,url` (or whichever fields needed) to keep output compact for LLM consumption.
- **Collection commands default to file output.** `feed`, `search`, `tweet_detail` write results to `~/.site-use/output/{site}/` and print a summary `{"count":N,"file":"..."}` to stdout. Use `--stdout` to get full JSON to stdout instead. Use `--output <path>` to specify a custom file path.
- **Use `--debug` when troubleshooting.** Adds diagnostic trace. On errors, trace is always included regardless of `--debug`.
- **Raw dumps for fields the parser doesn't expose.** The raw GraphQL responses contain richer data than the structured output (e.g. user `followers_count`, full profile bio, full media metadata). Pass `--dump-raw <fresh-dir>` to `feed` / `search` / `tweet_detail`, then walk the JSON for the field you need. Use a fresh directory each time — the default location only keeps the 2-3 most recent responses.

## Examples

### Daily hot topics briefing

```bash
# Fetch fresh timeline with compact output for summarization
site-use twitter feed --count 50 --tab for_you --stdout --fields author,text,url
```

### Search for a topic

```bash
site-use twitter search --query "Claude Code" --count 30 --stdout --fields author,text,url
```

### Inspect a conversation thread

```bash
site-use twitter tweet_detail --url "https://x.com/user/status/123" --count 30
```

Returns the anchor tweet, its ancestor chain (if it's a reply), and replies.

### Explore a user's activity

```bash
# Profile overview + recent posts
site-use twitter profile --handle elonmusk --posts --count 10

# Who does this user follow?
site-use twitter profile --handle elonmusk --following --count 50
```

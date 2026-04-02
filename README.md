# site-use

[中文](README.zh.md)

Want your AI agent to monitor your Twitter timeline — but worried about getting banned, or burning tokens on every scroll?

site-use lets your agent browse Twitter like a real person, automatically caches everything it sees, and delivers structured content at the lowest possible cost.

## Why site-use

### Won't get you banned

Your agent isn't "scraping" Twitter — it's browsing like a human.

site-use uses your own Chrome browser, mimicking real human behavior — variable-speed scrolling, mouse movements with natural curves, clicks with jitter, pauses between actions. Over the years, countless anti-detection projects have battled platforms, and many once-effective strategies have been patched out. We continuously track this arms race, incorporating only what still works today, with a built-in diagnostic suite to verify effectiveness.

### Lowest cost

Without site-use, your agent has to take a screenshot → read the page → decide what to do → execute — just to scroll down. These auxiliary actions consume far more tokens than the tweet content itself.

site-use bakes all browsing actions into deterministic code. Zero token cost at execution time. Your agent only processes the final tweet content.

A single feed collection takes just seconds — the slight wait is intentional, mimicking human browsing pace.

### Photographic memory

All collected content is automatically stored in a local database with full-text search. Filter by author, date, engagement metrics, or tweet type. Fetch once, query forever.

Compared to alternatives:

- **Traditional scrapers** can't see your personalized timeline unless you hand over your credentials to a third party
- **Letting your agent browse the web directly** is not only expensive, but doesn't cache anything — every session starts from scratch
- **Twitter's official API** is the best option if you can afford it — we encourage subscribing to support the platform. site-use is for those who can't justify $200/month

### Structured semantics

Your agent doesn't get a wall of HTML. It gets structured, meaningful content:

- **Who** posted (author, follow relationship)
- **When** it was posted
- **How** (original, retweet, reply, quote)
- **What** they said (full text)
- **Engagement** (likes, retweets, replies, views)

Dumping raw HTML into a language model fills its context with low-value tags — the actual content is a tiny fraction. This is not only expensive but degrades model performance. site-use feeds only meaningful content to your agent.

## Quick start

You'll need [Node.js 22.14+](https://nodejs.org/) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

### 1. Install site-use

```bash
npm install -g site-use
```

### 2. Add the skill to your AI agent

**Claude Code:**

```
/plugin marketplace add WilliamPenrose/site-use
/plugin install site-use@site-use
```

**OpenClaw:**

```bash
openclaw skills install site-use-x
```

### 3. Go

Ask your agent "help me set up site-use" — it will launch Chrome, walk you through logging in to Twitter, and collect your first tweets.

## CLI

site-use also works standalone without an AI agent:

```bash
site-use twitter feed             # Fetch timeline
site-use twitter search --query "AI agents"  # Search Twitter
site-use search "keyword"         # Search cached data
```

## Architecture

```
Browser layer → Sites layer → CLI
```

**Browser layer (security foundation)**

Isolated Chrome profile protects user privacy. Anti-fingerprinting at the launch-parameter level. Human-like behavior at the interaction level. Three layers of defense built from the ground up.

**Sites layer (workflows + local private storage)**

Twitter-specific workflows that extract full structured data directly from Twitter. All content flows into a local database — your Twitter data belongs to you permanently, never passing through any third party.

**CLI (deterministic automation)**

All browsing actions are baked into deterministic code — zero token cost at execution time. Your agent only processes the final structured content. A Claude Code plugin is included for seamless agent integration.

## Roadmap

- [x] Twitter timeline collection and local caching
- [x] Full-text search with structured filters
- [x] Anti-detection diagnostic suite
- [ ] Reddit support
- [ ] More sites (vote in Issues)

## License

MIT

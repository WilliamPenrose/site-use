# Capability 03: Site-Level Rate Limiting

> Upstream: [M3 Overview](00-overview.md) — Group A
> Status: Complete (2026-03-22, commits 452e832 + ba89c80)

## Context

### What M1 Already Has

The throttle layer (`throttle.ts`) applies a random delay (1-3s) before each operation. The backend layer (`click-enhanced.ts`, `scroll-enhanced.ts`) handles intra-operation simulation (Bezier trajectories, humanized scrolling, click jitter). These two layers are orthogonal — M3 does not change the backend layer.

### What M3 Adds

A global frequency cap: "no more than N operations per time window per site". This sits in the throttle layer alongside the existing random delay.

---

## Research: Safe Defaults for Twitter

### Human Browsing Behavior

| Metric | Value | Source |
|--------|-------|--------|
| Average time reading one tweet | ~6.6 seconds | [ResearchGate study](https://www.researchgate.net/post/What_is_an_average_time_for_reading_attending_to_a_single_message_on_social_media_twitter_or_facebook) |
| Human scroll frequency | 1-2 per minute | Derived: 5-8 tweets per screen × 6.6s |
| Average Twitter session | 2m 11s | [BusinessDasher](https://www.businessdasher.com/average-time-spent-on-social-media/) |
| Daily Twitter usage | ~20 minutes | [BusinessDasher](https://www.businessdasher.com/average-time-spent-on-social-media/) |

### Twitter Rate Limits (Browser-Level)

| Limit | Value | Source |
|-------|-------|--------|
| Daily tweet reading (verified) | 10,000 tweets/day | [TweetDelete](https://tweetdelete.net/resources/twitter-reading-limits-for-posts-can-you-bypass-xs-rules/) |
| Daily tweet reading (unverified) | 1,000 tweets/day | [TweetDelete](https://tweetdelete.net/resources/twitter-reading-limits-for-posts-can-you-bypass-xs-rules/) |
| Request hard floor | ≥1.5s per request | [imperatrona/twitter-scraper](https://github.com/imperatrona/twitter-scraper) (empirical) |
| Browser refreshes before 429 | ~25 refreshes | [SeleniumBase issue #2291](https://github.com/seleniumbase/SeleniumBase/issues/2291) |

### Industry Consensus for Safe Automation

| Source | Recommended Delay |
|--------|------------------|
| imperatrona/twitter-scraper (Go) | ≥1.5s/request (hard floor) |
| n0madic/twitter-scraper (Go) | 5s delay (`WithDelay(5)`) |
| Multiple Python guides | `random.uniform(2, 5)` seconds |
| Puppeteer Twitter tutorials | 4-5s per scroll (1-2s triggers detection) |
| PhantomBuster | ≤50 operations/hour |

Sources:
- [imperatrona/twitter-scraper](https://github.com/imperatrona/twitter-scraper)
- [n0madic/twitter-scraper](https://github.com/n0madic/twitter-scraper)
- [Puppeteer Twitter tutorial](https://rafaelquintanilha.com/counting-presidential-tweets/)
- [PhantomBuster rate limits](https://support.phantombuster.com/hc/en-us/articles/360017014479-Automation-Rate-Limits-by-Platform-and-Popular-Phantom-with-daily-limits)
- [PhantomBuster best practices](https://support.phantombuster.com/hc/en-us/articles/360011875099-Best-Practices-for-Social-Media-Platforms-Automation)

### What Triggers Detection

- Requests at fixed intervals (e.g., exactly every 2s) — strong signal
- Burst requests even if total volume is safe
- 24/7 uninterrupted activity
- Scroll intervals below 2 seconds

Source: [OpenTweet automation rules 2026](https://opentweet.io/blog/twitter-automation-rules-2026), [BlackHatWorld safe automation 2025](https://www.blackhatworld.com/seo/safe-automation-on-twitter-x-in-2025-what-still-works-without-getting-banned.1758573/)

---

## Design

### Default Values

Based on the research above:

**Random delay (tuning M1 defaults):**

```typescript
// M1 current: { minDelay: 1000, maxDelay: 3000 }
// M3 updated:
{ minDelay: 2000, maxDelay: 5000 }
```

Rationale: 1-3s is below the industry consensus of 2-5s, and scroll intervals under 2s are known to trigger detection.

**Rate limiting (new):**

```typescript
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  window: 60_000,   // 1 minute
  maxOps: 10,       // max 10 operations per minute
};
```

Rationale: 10 ops/min = 600 ops/hour theoretical max, but combined with 2-5s random delays the effective rate is ~12-20 ops/min. The rate limiter acts as a safety ceiling, not the primary pacing mechanism. 10 ops/min ≈ PhantomBuster's 50/hour recommendation with safety margin.

### Sliding Window Implementation

Added inside `throttle.ts` as part of `createThrottledPrimitives`:

- Maintains an array of operation timestamps (one per site)
- Before each throttled operation: evict timestamps outside the window → check count
- Under limit → record timestamp, proceed with random delay + operation
- Over limit → **wait** until the oldest timestamp in the window expires, then proceed

### Over-Limit Behavior: Wait, Not Error

When the rate limit is exceeded, the operation is **delayed** (not rejected). Rationale:
- Rate limiting is internal protection, not a user error
- Workflows should not need to handle "too fast" exceptions
- Observable effect is simply slower operations — consistent with "behave like a real human"

### Which Operations Count Toward Rate Limit

> **Important distinction**: The existing random delay (throttle) and the new rate-limit counter are separate mechanisms. All operations listed below still go through the random delay as in M1. The rate-limit counter is an *additional* check on top of the delay.

**Counted** toward rate limit (trigger network requests or visible page behavior):
`navigate`, `click`, `type`, `scroll`, `scrollIntoView`

**Not counted** toward rate limit (but still subject to existing throttle delay):
`takeSnapshot`, `evaluate`, `interceptRequest`

**Fully exempt** (no throttle delay, no rate-limit counting — unchanged from M1):
`screenshot`, `getRawPage`

> Note: `type` is not yet implemented (planned for M2). The rate-limit counter logic handles it, but the code path is unreachable until M2.

### Config Types

```typescript
interface RateLimitConfig {
  /** Time window in ms. Default: 60_000 (1 minute) */
  window: number;
  /** Max operations within window. Default: 10 */
  maxOps: number;
}

interface SiteThrottleConfig {
  delay: ThrottleConfig;          // M1: random delay
  rateLimit?: RateLimitConfig;    // M3: frequency cap
}
```

Default config is sufficient for now. Not exposed as environment variables — can be added later if needed.

---

## Files Changed

| File | Change |
|------|--------|
| `src/primitives/throttle.ts` | Add sliding window logic; update default delays |
| `src/primitives/types.ts` | Add `RateLimitConfig` type; extend `ThrottleConfig` with optional `rateLimit` |

---

## Validation

1. Rapid 30 consecutive scroll calls → first ~10 execute at 2-5s intervals, remainder auto-delayed until window frees
2. After 1 minute passes → normal rate resumes
3. `takeSnapshot` / `evaluate` calls → not affected by rate limit
4. Default delay range is 2-5s (not 1-3s)

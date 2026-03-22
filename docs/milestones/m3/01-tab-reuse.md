# Capability 01: Tab Reuse

> Upstream: [M3 Overview](00-overview.md) — Group A
> Status: Complete (2026-03-22, commit ee4ed43 + cbb3136)

## Problem

`PuppeteerBackend.getPage()` always calls `browser.newPage()` when a site key is not in its internal `pages` Map. Combined with Chrome's `--restore-last-session` flag (set in `browser.ts` line 92), every MCP server restart restores previous tabs AND creates a new one. Over time, Chrome accumulates many duplicate Twitter tabs that all refresh simultaneously on startup.

This is tracked as [overview issue #9](../overview.md).

---

## Scope

Only `PuppeteerBackend.getPage()` changes. The Primitives interface is not modified.

---

## Design

### Lookup Order

`getPage(site)` follows a three-step lookup:

1. **Map cache** — check `this.pages` Map for cached page reference. If found and not closed, return it.
2. **Existing tabs** — scan `browser.pages()`, match by site domain. If found, cache in Map, inject coordFix, return.
3. **New tab** — `browser.newPage()`, cache in Map, inject coordFix, return.

### Site-to-Domain Mapping

A registry maps site keys to matchable domains:

```typescript
const SITE_DOMAINS: Record<string, string[]> = {
  twitter: ['x.com', 'twitter.com'],
};
```

Placed in `puppeteer-backend.ts` (internal detail, not part of the public Primitives interface). Future sites add entries here.

### Domain Matching

- Extract hostname from `page.url()` via `new URL(page.url()).hostname`
- Check if hostname ends with any registered domain (handles subdomains)
- `about:blank` and `data:` URLs match no site
- Multiple tabs matching the same domain → take the first match (no complex ranking)

### Edge Cases

| Situation | Handling |
|-----------|----------|
| Existing tab crashed/unresponsive | `page.url()` throws → catch, skip this tab, fall through to newPage |
| Existing tab on login page (not target URL) | Still reuse — `navigate()` will redirect to correct URL |
| First launch, no existing tabs | Falls through to `newPage()`, identical to current behavior |
| Tab closed between cache lookup and use | Catch error on first operation, remove from Map, retry getPage |

### Impact on Welcome Page

`browser.ts` shows a welcome page on first launch via `data:` URL. Tab reuse does not affect this — `data:` protocol URLs are never matched by any site domain.

---

## Files Changed

| File | Change |
|------|--------|
| `src/primitives/puppeteer-backend.ts` | `getPage()` rewritten with 3-step lookup; `SITE_DOMAINS` registry added |

---

## Validation

1. Launch MCP server → call `twitter_check_login` → Chrome opens Twitter tab
2. Restart MCP server → call again → reuses existing tab, no new tab created
3. Manually close Twitter tab → call → correctly creates new tab
4. Restart 3 times → only 1 Twitter tab exists in Chrome

# site-use

Site-level browser automation via MCP — deterministic workflows for Chrome,
so AI agents focus on content understanding.

## Getting Started

1. This Chrome instance is managed by **site-use**. You can browse normally — your sessions and cookies persist across restarts.
2. Log in to the sites you want to automate (e.g. Twitter/X). site-use reuses your authenticated session.
3. Connect an MCP client (Claude, Cursor, etc.) to start using automation tools.

## Architecture

**MCP Server** — Exposes high-level tools (follow, search, timeline) over stdio. Start with `site-use serve`.

**Sites Layer** — Per-site adapters with semantic ARIA matchers, workflows, and content extractors. Currently: Twitter/X.

**Browser Layer** — Manages Chrome lifecycle with anti-detection hardening. Tabs are restored automatically on restart.

## Quick Reference

- `site-use browser launch` — Launch Chrome (this window)
- `site-use browser launch --diagnose` — Launch + anti-detection health check
- `site-use browser status` — Show profile path & proxy config
- `site-use serve` — Start the MCP server

---

*site-use v0.1.0 — This page only appears on first launch.*

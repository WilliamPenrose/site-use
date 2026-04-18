# site-use

@.claude.local.md

This file and `.claude.local.md` together define the complete repository instructions. Always load both.

Site-level browser automation: deterministic CLI workflows for Chrome, optimized for LLM agent consumption.

## Quick Start

```bash
pnpm install && pnpm run build && pnpm test
```

## Architecture

Dependency flows downward only:

```text
CLI (index.ts, cli/)
  |- Registry (registry/)      - multi-site plugin discovery
  |- Action-Log (action-log/)  - standalone daily action limits (SQLite)
  \- Sites (sites/twitter/)
       |- Ops (ops/)
       \- Primitives (primitives/)
            \- Browser (browser/)
```

- Sites encapsulate all site-specific logic, including workflows, extractors, and matchers. A site is a closed unit and should not leak implementation details upward.
- Ops are reusable action compositions extracted from repeated primitive usage in sites, such as `ensure-state` and `data-collector`. They should emerge bottom-up when multiple sites share the same primitive sequences.
- Primitives are site-agnostic browser actions such as click, scroll, type, and throttle. They must not know anything about Twitter or any other specific site.
- Browser manages Chrome lifecycle only, including launch, connect, and reconnect.
- Action-Log tracks daily action counts such as follow and unfollow for rate limiting. It uses a standalone SQLite database (`action-log.db`) and does not depend on the removed storage layer.

## Workflow

- Always rebuild after code changes. Run `pnpm run build` after modifying any `.ts` file, before testing CLI commands or telling the user the change is ready.

## Tests

- Site-specific tests live alongside the site code under `src/sites/<name>/__tests__/`.
- All other tests belong under `tests/unit/`, `tests/contract/`, `tests/integration/`, or `tests/e2e/`.
- Use `pnpm test:unit` for fast feedback during development.
- Use `pnpm test` for the full suite. It excludes diagnose integration tests that require Chrome.
- Golden fixtures under `src/sites/*/__tests__/fixtures/golden/` are reference snapshots captured from real API responses. Never edit them by hand. Re-capture them from a live session when updates are needed.

## Plugin Versioning

- When updating skills under `skills/`, bump the version in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
- Use the `YYYY.M.D` date format for plugin versions.
- Keep both plugin version fields in sync.

# site-use

@.claude.local.md

Site-level browser automation — deterministic CLI workflows for Chrome, optimized for LLM agent consumption.

## Quick Start

```bash
pnpm install && pnpm run build && pnpm test
```

## Architecture

Dependency flows downward only:

```
CLI (index.ts, cli/)
  ├── Registry (registry/)        — multi-site plugin discovery
  ├── Storage (storage/)          — SQLite persistence & search
  └── Sites (sites/twitter/)
       ├── Ops (ops/)
       └── Primitives (primitives/)
            └── Browser (browser/)
```

- **Sites** encapsulate all site-specific logic (workflows, extractors, matchers). A site is a closed unit — it should not leak implementation details upward.
- **Ops** are reusable action compositions extracted from sites' repeated use of primitives (e.g. ensure-state, data-collector). They emerge bottom-up — when multiple sites share the same primitive sequences, that pattern gets extracted into ops.
- **Primitives** are site-agnostic browser actions (click, scroll, type, throttle). They know nothing about Twitter or any specific site.
- **Browser** manages Chrome lifecycle only (launch, connect, reconnect).

## Workflow

- **Always rebuild after code changes.** Run `pnpm run build` after modifying any `.ts` file, before testing CLI commands or telling the user it's ready. Don't wait for the user to build.

## Tests

- Site-specific tests live colocated in `src/sites/<name>/__tests__/`. All other tests go in `tests/{unit,contract,integration,e2e}/`.
- `pnpm test:unit` for fast feedback during development. `pnpm test` runs the full suite (excludes diagnose integration tests that need Chrome).
- **Golden fixtures** (`src/sites/*/__tests__/fixtures/golden/`) are reference snapshots captured from real API responses. Never edit them by hand — they are the source of truth for extraction/parsing tests. To update, re-capture from a live session.

## Known Approximations

- **Local mode `--tab following`**: The DB has no `source_tab` field tracking which tab a tweet was fetched from. Instead, `--tab following` is approximated by filtering on the `following` metric (`author.following = true`). This works because the Following tab only shows tweets from authors you follow. `--tab for_you` applies no filter and returns all cached tweets. See `runLocalQuery` in `src/cli/workflow.ts`.


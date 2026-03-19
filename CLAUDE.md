# site-use

Site-level browser automation via MCP — deterministic workflows for Chrome, so AI agents focus on content understanding.

## Quick Start

```bash
pnpm install && pnpm run build && pnpm test
```

## Architecture

Three layers, dependency flows downward only:

```
MCP Server (server.ts)
  └── Sites (sites/twitter/)
       └── Primitives (primitives/)
            └── Browser (browser/)
```

## Design Documents

- `docs/site-use-design.md` — Overall design
- `docs/milestones/overview.md` — Milestone breakdown

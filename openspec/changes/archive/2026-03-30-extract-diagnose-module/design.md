## Context

`src/diagnose/` is a 30+ file anti-detection diagnostic module with its own build pipeline (esbuild IIFE bundle, separate DOM tsconfig). It currently lives as a CLI subcommand wired through `src/index.ts`, creating a reverse dependency (core CLI imports a debugging tool). The build script (`scripts/build.mjs`) already treats diagnose as a separate compilation unit — it runs tsc for core code first, then handles diagnose barrel generation, DOM type-checking, and esbuild bundling as distinct steps.

## Goals / Non-Goals

**Goals:**
- Move `src/diagnose/` to `tools/diagnose/`, establishing `tools/` as the location for auxiliary developer modules.
- Fully decouple diagnose from the CLI — `src/index.ts` has zero references to diagnose.
- Create a standalone entry point `tools/diagnose/main.ts` that replaces the CLI subcommand.
- Keep cross-boundary imports: diagnose imports `ensureBrowser` from `src/browser/` and `humanScroll` from `src/primitives/`.

**Non-Goals:**
- Making diagnose a separate npm package or workspace.
- Extracting other modules (harness, testing, display) — out of scope for this change.
- Changing diagnose's internal architecture or adding new features.

## Decisions

### D1: Target directory — `tools/` at project root

**Choice**: `tools/diagnose/` at project root.

**Alternatives considered**:
- `packages/diagnose/` — implies a workspace package, which adds unnecessary complexity.
- `extras/diagnose/` — non-standard naming.
- `src/tools/diagnose/` — still under `src/`, defeats the purpose of separation.

**Rationale**: `tools/` is a common convention for auxiliary/developer tooling that doesn't belong in the core source tree. It's immediately clear these are support utilities, not core runtime code.

### D2: Import strategy — standalone entry point, not CLI wiring

**Choice**: Create `tools/diagnose/main.ts` as a standalone entry point. `src/index.ts` no longer imports diagnose at all. Instead, `tools/diagnose/main.ts` imports from `src/browser/` (for `ensureBrowser`) and `src/primitives/` (for `humanScroll`).

**Alternatives considered**:
- Keep `src/index.ts` importing from `tools/diagnose/` via relative path — maintains a reverse dependency where core imports a dev tool.
- Re-export from a barrel in `src/` — obscures the actual dependency.

**Rationale**: The whole point of extraction is to decouple. Having core CLI import a debugging tool is the wrong dependency direction. A standalone entry point means `src/` has zero knowledge of `tools/`, achieving true separation.

### D3: Standalone entry point replaces CLI subcommand

**Choice**: Remove the `diagnose` case from `src/index.ts` entirely. Add `"diagnose": "node dist/tools/diagnose/main.js"` to `package.json` scripts.

**Alternatives considered**:
- Keep the CLI subcommand alongside the standalone entry — dual invocation paths add confusion.
- Only have `pnpm run diagnose` with no CLI removal — leaves dead code in index.ts.

**Rationale**: Diagnose is a developer tool, not a user-facing command. `pnpm run diagnose` is the natural invocation for developers. Removing the CLI case eliminates the reverse dependency completely.

### D4: TypeScript compilation — extend existing separate compilation

**Choice**: Keep diagnose excluded from main `tsc` (as it already is). Update `tsconfig.json` exclude pattern. `main.ts` is compiled by main tsc to `dist/tools/diagnose/main.js`. The build script already compiles diagnose separately — just update paths.

**Rationale**: The current build already treats diagnose as a separate compilation unit. Moving the directory just changes the paths, not the approach.

### D5: dist output unchanged

**Choice**: Output remains at `dist/diagnose/` for checks and HTML. `main.ts` compiles to `dist/tools/diagnose/main.js`.

**Rationale**: No consumer-visible change for the diagnostic page. The standalone entry point naturally lands under `dist/tools/` via tsc's rootDir mapping.

## Dependency Boundary

```
tools/diagnose/main.ts
  ├─→ src/browser/           ensureBrowser()
  ├─→ src/primitives/        humanScroll()
  └─→ tools/diagnose/*       runner, server, checks...

src/
  └─✕ tools/                 Core code has zero references to tools/
```

Rules:
- `tools/` → `src/` is allowed (tools depend on core)
- `src/` → `tools/` is forbidden (core never depends on tools)

## Risks / Trade-offs

- **Risk**: Relative import paths from `tools/diagnose/` to `src/` cross directory boundaries → Acceptable because this is the correct dependency direction (tools depend on core, never reverse).
- **Risk**: Future tools added to `tools/` may need their own tsconfig/build steps → Acceptable; we handle this when it happens, not prematurely.
- **Risk**: **BREAKING** — `site-use diagnose` CLI subcommand is removed → Acceptable because diagnose is a developer-only tool, not part of the public API. `pnpm run diagnose` is the replacement.

## Why

The `src/diagnose/` module is a self-contained anti-detection diagnostic tool with its own build pipeline (esbuild IIFE bundle, separate DOM tsconfig), 30+ browser checks, and an HTTP server — yet it lives alongside core automation primitives. This inflates the core `src/` surface area and couples an auxiliary debugging tool to the main compilation. Extracting it establishes a clean boundary: core automation code in `src/`, developer tools outside it.

## What Changes

- Move `src/diagnose/` to a top-level `tools/diagnose/` directory, outside the core `src/` tree.
- Remove the `diagnose` CLI subcommand from `src/index.ts` entirely (BREAKING — `site-use diagnose` no longer works).
- Add standalone `tools/diagnose/main.ts` entry point that parses args, calls `ensureBrowser` and `runDiagnose`.
- Add `pnpm run diagnose` script in `package.json` as the new invocation method.
- Update the build pipeline (`scripts/build.mjs`) so the diagnose-specific steps (barrel generation, DOM type-check, esbuild bundle, HTML copy) reference the new location.
- Update `tsconfig.json` exclude paths to reflect the move.
- Preserve cross-boundary dependencies: `tools/diagnose/main.ts` imports `ensureBrowser` from `src/browser/` and `tools/diagnose/runner.ts` imports `humanScroll` from `src/primitives/`. Core `src/` has zero references to `tools/`.

## Capabilities

### New Capabilities

- `tools-directory-convention`: Establish a `tools/` top-level directory for auxiliary developer/debugging modules that are not part of the core automation runtime.

### Modified Capabilities

- `diagnose-invocation`: **BREAKING** — `site-use diagnose` CLI subcommand is removed. Replaced by `pnpm run diagnose`. This only affects developer usage; diagnose is not part of the public API.

## Impact

- **Code**: `src/diagnose/` (all files) relocated to `tools/diagnose/`. New `tools/diagnose/main.ts` standalone entry point created. `src/index.ts` diagnose case and import deleted entirely.
- **Build**: `scripts/build.mjs` barrel generation, type-check, and esbuild steps update source paths. `main.ts` compiled by main tsc to `dist/tools/diagnose/main.js`. Output for checks/HTML still goes to `dist/diagnose/`.
- **Tests**: Integration tests (`tests/integration/diagnose-*.test.ts`) and unit tests (`tests/unit/scroll-analyzer.test.ts`) update import paths.
- **tsconfig**: Exclude pattern changes from `src/diagnose/checks/**/*` to `tools/diagnose/checks/**/*`.
- **Breaking change**: `site-use diagnose` subcommand removed, replaced by `pnpm run diagnose`. Only affects developer usage.

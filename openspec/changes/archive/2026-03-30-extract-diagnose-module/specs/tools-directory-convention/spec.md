## ADDED Requirements

### Requirement: Tools directory exists at project root
The project SHALL have a `tools/` directory at the repository root for auxiliary developer/debugging modules that are not part of the core automation runtime.

#### Scenario: Directory structure after extraction
- **WHEN** the project is built
- **THEN** `tools/diagnose/` SHALL exist at the project root, containing all files previously in `src/diagnose/`

### Requirement: Diagnose module is fully relocated
All source files from `src/diagnose/` SHALL be moved to `tools/diagnose/` with identical internal structure. No diagnose source files SHALL remain under `src/`.

#### Scenario: No residual files in src/diagnose
- **WHEN** the move is complete
- **THEN** `src/diagnose/` SHALL NOT exist
- **THEN** `tools/diagnose/runner.ts`, `tools/diagnose/server.ts`, `tools/diagnose/registry.ts`, `tools/diagnose/types.ts`, `tools/diagnose/page.ts`, `tools/diagnose/checks/`, `tools/diagnose/index.html`, and `tools/diagnose/tsconfig.checks.json` SHALL all exist

### Requirement: Diagnose has standalone entry point
`tools/diagnose/main.ts` SHALL exist as the standalone entry point for the diagnose tool. It SHALL parse CLI arguments (e.g., `--keep-open`), call `ensureBrowser` from `src/browser/`, and invoke `runDiagnose`.

#### Scenario: Standalone entry point exists
- **WHEN** inspecting `tools/diagnose/`
- **THEN** `tools/diagnose/main.ts` SHALL exist
- **THEN** it SHALL import `ensureBrowser` from `src/browser/`
- **THEN** it SHALL import `humanScroll` from `src/primitives/` (directly or via runner)

### Requirement: CLI subcommand is removed (BREAKING)
The `site-use diagnose` CLI subcommand SHALL be removed from `src/index.ts`. The diagnose case, its import, and its help text SHALL all be deleted. Diagnose is replaced by `pnpm run diagnose`.

#### Scenario: No diagnose references in src/index.ts
- **WHEN** inspecting `src/index.ts`
- **THEN** there SHALL be no import of `runDiagnose` or any reference to the diagnose module
- **THEN** there SHALL be no `case 'diagnose'` branch

#### Scenario: Running diagnose via pnpm
- **WHEN** user runs `pnpm run diagnose`
- **THEN** the diagnostic server starts, checks execute, and results are printed
- **WHEN** user runs `pnpm run diagnose -- --keep-open`
- **THEN** the diagnostic page remains open after checks complete

### Requirement: Build output is unchanged
The build pipeline SHALL produce `dist/diagnose/checks.js` and `dist/diagnose/index.html` at the same paths as before the move. Additionally, `dist/tools/diagnose/main.js` SHALL be produced as the compiled standalone entry point.

#### Scenario: Build produces correct dist output
- **WHEN** `pnpm run build` completes
- **THEN** `dist/diagnose/checks.js` and `dist/diagnose/index.html` SHALL exist with correct content
- **THEN** `dist/tools/diagnose/main.js` SHALL exist

### Requirement: Core code has zero references to tools/
`src/` code SHALL NOT import from `tools/` in any file. The dependency direction is strictly one-way: `tools/` depends on `src/`, never the reverse.

#### Scenario: Import boundary
- **WHEN** inspecting imports across the tools/src boundary
- **THEN** no file under `src/` SHALL import from `tools/`
- **THEN** `tools/diagnose/main.ts` MAY import from `src/browser/`
- **THEN** `tools/diagnose/runner.ts` MAY import from `src/primitives/`

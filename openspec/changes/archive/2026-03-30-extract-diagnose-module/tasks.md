## 1. Move Files

- [ ] 1.1 Create `tools/diagnose/` directory at project root
- [ ] 1.2 Move all files from `src/diagnose/` to `tools/diagnose/` preserving internal structure
- [ ] 1.3 Delete empty `src/diagnose/` directory

## 2. Create Standalone Entry Point

- [ ] 2.1 Create `tools/diagnose/main.ts` — standalone entry that parses args (`--keep-open`), calls `ensureBrowser` from `src/browser/`, and invokes `runDiagnose` (extract logic from `src/index.ts` diagnose case)

## 3. Remove CLI Subcommand (BREAKING)

- [ ] 3.1 Delete the `import { runDiagnose }` from `src/index.ts`
- [ ] 3.2 Delete the `case 'diagnose'` branch from `src/index.ts`
- [ ] 3.3 Remove diagnose from help text in `src/index.ts`

## 4. Update Imports

- [ ] 4.1 Update `tools/diagnose/runner.ts` import of `humanScroll` to point to `../../src/primitives/scroll-enhanced.js`

## 5. Add Package Script

- [ ] 5.1 Add `"diagnose": "node dist/tools/diagnose/main.js"` to `package.json` scripts

## 6. Update Build Config

- [ ] 6.1 Update `tsconfig.json` exclude pattern from `src/diagnose/checks/**/*` to `tools/diagnose/checks/**/*` (and `src/diagnose/page.ts` to `tools/diagnose/page.ts`)
- [ ] 6.2 Update `scripts/build.mjs` — change all `src/diagnose/` references to `tools/diagnose/` (barrel generation, DOM type-check, esbuild entry, HTML copy)
- [ ] 6.3 Update `tools/diagnose/tsconfig.checks.json` if it has relative paths that need adjusting (extends, include paths)

## 7. Update Tests

- [ ] 7.1 Update import paths in `tests/integration/diagnose-server.test.ts`
- [ ] 7.2 Update import paths in `tests/integration/diagnose-runner.test.ts` (if exists)
- [ ] 7.3 Update import paths in `tests/unit/scroll-analyzer.test.ts`

## 8. Verify

- [ ] 8.1 Run `pnpm run build` — confirm successful build with `dist/diagnose/checks.js`, `dist/diagnose/index.html`, and `dist/tools/diagnose/main.js`
- [ ] 8.2 Run `pnpm test` — confirm all diagnose-related tests pass
- [ ] 8.3 Run `pnpm run diagnose` — confirm standalone entry point works
- [ ] 8.4 Verify no residual files remain in `src/diagnose/`
- [ ] 8.5 Verify `src/index.ts` has zero references to diagnose

# Design: dump-raw and harness capture integration

**Date:** 2026-03-27
**Status:** Approved

## Problem

`--dump-raw` and `harness capture` are two disconnected features that should work together:

- `--dump-raw <dir>` dumps raw GraphQL responses to a user-specified directory, but has no default path and requires a directory argument.
- `harness capture <site>` is a shell command that prints manual instructions instead of doing anything.
- `captureForHarness` exists and does the right thing (extract entries, diff against golden, save novel variants), but nothing calls it in production.
- `saveCaptured` writes one file per entry, fragmenting captured data into dozens of files when it should be one file per domain matching golden format.
- `--dump-raw` is a plugin parameter in `TwitterFeedParamsSchema`, but it's really a framework-level concern (controls output side effect of fetching).

## Design

### 1. `--dump-raw` as a framework flag

`--dump-raw` is a side effect of fetching — "while fetching, also save raw responses to disk". It requires a fetch to happen and is meaningless without one.

- Remove `dumpRaw` from `TwitterFeedParamsSchema`.
- Extract `--dump-raw [dir]` from args in codegen, before the `hasCacheSupport` branch, so all feed commands can use it.
- `--dump-raw` implies `forceFetch = true` — asking to dump raw browser data means you need the browser.
- `--dump-raw` and `--local` are mutually exclusive — error if both are present.

Behavior:
- `--dump-raw` (no arg) → default directory `~/.site-use/dump/{site}/`
- `--dump-raw <dir>` → specified directory (existing behavior)

Note: `wrapToolHandler` validates `rawParams` against the Zod schema but passes the original `rawParams` (not the stripped result) to the handler. So the injected `dumpRaw` key survives to reach the workflow. This is existing behavior, not a new coupling.

### 2. Backup rotation (default directory only)

When using the default dump directory, the codegen layer rotates existing files before the workflow writes new ones:

- For each `*.json` file in the directory (excluding `*.prev.json`): mv to `*.prev.json`.

This is safe because `--dump-raw` implies `forceFetch`, so the workflow will always run and write new files.

When `--dump-raw <dir>` is used with an explicit directory, no rotation is performed.

One-level backup with no `rm` operations. Maximum storage is 2x one dump.

**Output:** After the feed completes, codegen prints the dump directory to stderr:
```
Dumped to ~/.site-use/dump/twitter/
```

### 3. `harness capture` reads dump files

Replace the current help-text shell with an automated flow:

1. Load the harness descriptor via `loadHarness(site)` to get domain definitions (each with `extractEntries` and `variantSignature`).
2. Read `~/.site-use/dump/{site}/*.json` (ignore `*.prev.json`).
3. If no dump files found, print error: `No dump files found. Run "site-use {site} feed --dump-raw" first.`
4. For each dump file, for each domain in the harness descriptor, call `captureForHarness(responseBody, domain, domainName, goldenDirPath, capturedDirPath)`.
5. Non-matching responses (where `extractEntries` returns empty) are silently skipped.
6. Print summary: `Captured {n}, skipped {m}. Files in ~/.site-use/harness/{site}/captured/`

### 4. Captured data format: one file per domain

Change `saveCaptured` to **upsert into a single file per domain** instead of creating one file per entry.

New signature:
```ts
function upsertCaptured(capturedDir: string, domain: string, entries: FixtureEntry[]): string
```

- File: `captured/{domain}-variants.json` (same format as golden: array of `FixtureEntry`)
- Reads existing file (if any), merges by `_variant` key (same variant → replace, new variant → append), writes back.
- Multiple captures accumulate in the same file. Same variant from a later capture overwrites the earlier one.
- Returns the file path.

### 5. `harness promote` adaptation

Current `promoteFixture` works on a single file and infers domain from filename. Replace with domain-based promotion:

- `site-use harness promote <site> [domain]`
- If domain specified: read `captured/{domain}-variants.json`, merge all entries into `golden/{domain}-variants.json` (upsert by `_variant`), delete captured file.
- If domain omitted: promote all domains found in `captured/`.
- User can edit `captured/{domain}-variants.json` before promoting to remove unwanted variants.

This is a breaking change to the `promote` CLI interface. Acceptable because the feature is not yet in active use.

## Data flow

```
codegen.ts (framework layer)
  ├─ extract --dump-raw [dir] from args (all feed commands)
  ├─ resolve default dir if no arg: ~/.site-use/dump/{site}/
  │
  ├─ if hasCacheSupport:
  │    ├─ stripFrameworkFlags → cacheFlags (forceLocal, forceFetch, maxAge)
  │    ├─ if --dump-raw + forceLocal: error "mutually exclusive"
  │    ├─ if --dump-raw: set forceFetch = true
  │    ├─ rotate: mv *.json → *.prev.json (default dir only, safe: forceFetch)
  │    ├─ inject dumpRaw into params
  │    └─ withSmartCache(forceFetch=true, ...) → always goes remote
  ├─ else:
  │    ├─ rotate: mv *.json → *.prev.json (default dir only, safe: always fetches)
  │    ├─ inject dumpRaw into params
  │    └─ wrappedFeed(params)
  │
  └─ after feed completes: print "Dumped to {dir}"

workflows.ts (plugin layer)
  └─ GraphQL interception callback
      └─ if dumpRaw: writes response.body to {dumpRaw}/graphql-{n}.json

harness capture {site}
  ├─ loadHarness(site) → domain descriptors
  ├─ read ~/.site-use/dump/{site}/*.json (ignore *.prev.json)
  └─ for each file × each domain:
      └─ captureForHarness(responseBody, domain, ...)
          ├─ extractEntries → per-entry variant signatures
          ├─ diff against golden/{domain}-variants.json
          └─ upsertCaptured into captured/{domain}-variants.json

harness promote {site} [domain]
  └─ merge captured/{domain}-variants.json into golden/{domain}-variants.json
      └─ delete captured file
```

## Files to modify

| File | Change |
|------|--------|
| `src/sites/twitter/types.ts` | Remove `dumpRaw` from `TwitterFeedParamsSchema` |
| `src/sites/twitter/index.ts` | Remove `--dump-raw` from plugin-level help text |
| `src/sites/twitter/workflows.ts` | No change — `getFeed` already accepts `dumpRaw` via `GetFeedOptions`, continues to write to the given directory |
| `src/cli/smart-cache.ts` | No change — cache flags remain as-is |
| `src/registry/codegen.ts` | Extract `--dump-raw` before `hasCacheSupport` branch; resolve default dir; perform backup rotation; set `forceFetch` if cache supported; inject `dumpRaw` into params; print dump dir after feed completes; add `--dump-raw` to `buildFeedHelp` output (before cache options, applies to all feed commands) |
| `src/harness/fixture-io.ts` | Replace `saveCaptured` with `upsertCaptured`; replace `promoteFixture` with domain-based merge |
| `src/harness/capture.ts` | Use `upsertCaptured` API |
| `src/cli/harness.ts` | `capture` reads dump dir via `loadHarness`, calls `captureForHarness`; `promote` accepts domain instead of file |

## Out of scope

- Auto-capture during normal feed fetch (user explicitly opted against this for storage reasons).
- Cleanup commands for dump files (user manages manually for now).

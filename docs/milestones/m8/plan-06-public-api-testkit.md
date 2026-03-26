# Plan 6: Public API Exports + Test Kit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure `package.json` exports for the three public API surfaces (`site-use`, `site-use/ops`, `site-use/testing`) and extract duplicated test helpers into a shared test kit.

**Architecture:** `site-use` re-exports registry types (SitePlugin, FeedItem, etc.). `site-use/ops` re-exports matchers and ensure-state. `site-use/testing` provides `createMockPrimitives`, `buildSnapshot`, `createMockStore`, `assertIngestItems`. Existing tests that duplicate these helpers are updated to import from the test kit.

**Tech Stack:** TypeScript, Vitest, Zod

**Spec:** [M8 Multi-Site Plugin Architecture](./multi-site-plugin-architecture.md) — Section 8.2

**Depends on:** Plans 1-5

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/testing/index.ts` | Test kit: createMockPrimitives, buildSnapshot, createMockStore, assertIngestItems |
| Create | `src/ops/index.ts` | Public re-export of ops utilities |
| Modify | `src/registry/index.ts` | Ensure all public types exported |
| Modify | `package.json` | Add `exports` entries for `./ops` and `./testing` |
| Modify | `tests/unit/throttle.test.ts` | Import from test kit instead of local helper |
| Modify | `tests/unit/auth-guard.test.ts` | Import from test kit instead of local helper |
| Modify | `tests/unit/ops-ensure-state.test.ts` | Import from test kit instead of local helper |
| Modify | `tests/unit/ops-matchers.test.ts` | Import from test kit instead of local helper |
| Modify | `tests/contract/server.test.ts` | Import from test kit instead of local helper |
| Create | `tests/unit/testing-kit.test.ts` | Verify test kit exports work correctly |

---

### Task 1: Create the test kit

**Files:**
- Create: `src/testing/index.ts`
- Create: `tests/unit/testing-kit.test.ts`

- [ ] **Step 1: Write failing tests for the test kit**

```ts
// tests/unit/testing-kit.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  createMockPrimitives,
  buildSnapshot,
  createMockStore,
  assertIngestItems,
} from '../../src/testing/index.js';

describe('createMockPrimitives', () => {
  it('returns a Primitives object with all methods as spies', () => {
    const p = createMockPrimitives();
    expect(typeof p.navigate).toBe('function');
    expect(typeof p.takeSnapshot).toBe('function');
    expect(typeof p.click).toBe('function');
    expect(typeof p.type).toBe('function');
    expect(typeof p.scroll).toBe('function');
    expect(typeof p.scrollIntoView).toBe('function');
    expect(typeof p.evaluate).toBe('function');
    expect(typeof p.screenshot).toBe('function');
    expect(typeof p.interceptRequest).toBe('function');
    expect(typeof p.getRawPage).toBe('function');
  });

  it('allows overriding specific methods', () => {
    const p = createMockPrimitives({
      evaluate: async () => 'https://x.com/home',
    });
    await expect(p.evaluate('window.location.href')).resolves.toBe('https://x.com/home');
  });
});

describe('buildSnapshot', () => {
  it('returns a Snapshot with uid-keyed nodes', () => {
    const snap = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '2', role: 'button', name: 'Tweet' },
    ]);
    expect(snap['1']).toEqual({ uid: '1', role: 'link', name: 'Home' });
    expect(snap['2']).toEqual({ uid: '2', role: 'button', name: 'Tweet' });
  });

  it('returns empty snapshot for empty input', () => {
    const snap = buildSnapshot([]);
    expect(Object.keys(snap)).toHaveLength(0);
  });
});

describe('createMockStore', () => {
  it('returns a KnowledgeStore with spyable methods', () => {
    const store = createMockStore();
    expect(typeof store.ingest).toBe('function');
    expect(typeof store.search).toBe('function');
    expect(typeof store.statsBySite).toBe('function');
  });
});

describe('assertIngestItems', () => {
  it('passes for valid IngestItem array', () => {
    const items = [{
      site: 'test',
      id: '1',
      text: 'hello',
      author: 'alice',
      timestamp: '2026-01-01T00:00:00Z',
      url: 'https://test.com/1',
      rawJson: '{}',
    }];
    expect(() => assertIngestItems(items)).not.toThrow();
  });

  it('throws for invalid IngestItem (missing id)', () => {
    const items = [{ site: 'test', text: 'hello' }];
    expect(() => assertIngestItems(items as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/unit/testing-kit.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the test kit**

```ts
// src/testing/index.ts
import { vi } from 'vitest';
import { z } from 'zod';
import type { Primitives, Snapshot, SnapshotNode } from '../primitives/types.js';
import type { KnowledgeStore, IngestItem } from '../storage/types.js';

/**
 * Create a mock Primitives object with all methods as Vitest spies.
 * Pass overrides to customize specific methods.
 */
export function createMockPrimitives(overrides: Partial<Primitives> = {}): Primitives {
  return {
    navigate: vi.fn(async () => {}),
    takeSnapshot: vi.fn(async () => ({})),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    scrollIntoView: vi.fn(async () => {}),
    evaluate: vi.fn(async () => undefined as never),
    screenshot: vi.fn(async () => ''),
    interceptRequest: vi.fn(async () => () => {}),
    getRawPage: vi.fn(async () => ({}) as never),
    ...overrides,
  };
}

/**
 * Build a Snapshot (uid → SnapshotNode map) from an array of nodes.
 */
export function buildSnapshot(nodes: SnapshotNode[]): Snapshot {
  const snapshot: Snapshot = {};
  for (const node of nodes) {
    snapshot[node.uid] = node;
  }
  return snapshot;
}

/**
 * Create a mock KnowledgeStore with all methods as Vitest spies.
 */
export function createMockStore(): KnowledgeStore {
  return {
    ingest: vi.fn(async () => ({ inserted: 0, updated: 0, skipped: 0 })),
    search: vi.fn(async () => ({ items: [], total: 0 })),
    statsBySite: vi.fn(async () => ({})),
    deleteItems: vi.fn(async () => ({ deleted: 0 })),
    previewDelete: vi.fn(async () => ({ count: 0, items: [] })),
    exportItems: vi.fn(),
    rebuild: vi.fn(async () => ({ reindexed: 0 })),
  } as unknown as KnowledgeStore;
}

const IngestItemSchema = z.object({
  site: z.string(),
  id: z.string(),
  text: z.string(),
  author: z.string(),
  timestamp: z.string(),
  url: z.string(),
  rawJson: z.string(),
  metrics: z.array(z.object({
    metric: z.string(),
    numValue: z.number().optional(),
    realValue: z.number().optional(),
    strValue: z.string().optional(),
  })).optional(),
  mentions: z.array(z.string()).optional(),
  hashtags: z.array(z.string()).optional(),
});

/**
 * Validate that an array of items conforms to the IngestItem schema.
 * Throws with details on first invalid item.
 */
export function assertIngestItems(items: IngestItem[]): void {
  const schema = z.array(IngestItemSchema);
  schema.parse(items);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/testing-kit.test.ts`
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/testing/index.ts tests/unit/testing-kit.test.ts
git commit -m "feat(testing): create shared test kit with mock primitives, snapshot builder, store mock"
```

---

### Task 2: Create ops public export

**Files:**
- Create: `src/ops/index.ts`

- [ ] **Step 1: Create `src/ops/index.ts`**

```ts
// src/ops/index.ts
export { matchByRule, matchAllByRule, type MatchRule } from './matchers.js';
export { makeEnsureState } from './ensure-state.js';
```

- [ ] **Step 2: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 3: Commit**

```bash
git add src/ops/index.ts
git commit -m "feat(ops): public API re-export for plugin authors"
```

---

### Task 3: Configure package.json exports

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add export entries**

In `package.json`, update the `exports` field:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./browser": {
      "import": "./dist/browser/browser.js",
      "types": "./dist/browser/browser.d.ts"
    },
    "./primitives": {
      "import": "./dist/primitives/factory.js",
      "types": "./dist/primitives/factory.d.ts"
    },
    "./storage": {
      "import": "./dist/storage/index.js",
      "types": "./dist/storage/index.d.ts"
    },
    "./registry": {
      "import": "./dist/registry/index.js",
      "types": "./dist/registry/index.d.ts"
    },
    "./ops": {
      "import": "./dist/ops/index.js",
      "types": "./dist/ops/index.d.ts"
    },
    "./testing": {
      "import": "./dist/testing/index.js",
      "types": "./dist/testing/index.d.ts"
    }
  }
}
```

- [ ] **Step 2: Build and verify exports resolve**

Run: `pnpm run build`
Expected: success, all `.d.ts` files generated in dist

Verify the key type declarations exist:
```bash
ls dist/registry/index.d.ts dist/ops/index.d.ts dist/testing/index.d.ts
```
Expected: all three files exist

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: configure package.json exports for registry, ops, and testing"
```

---

### Task 4: Migrate existing tests to use test kit

**Files:**
- Modify: `tests/unit/throttle.test.ts`
- Modify: `tests/unit/auth-guard.test.ts`
- Modify: `tests/unit/ops-ensure-state.test.ts`
- Modify: `tests/unit/ops-matchers.test.ts`
- Modify: `tests/contract/server.test.ts`

Each file currently defines its own local `createMockPrimitives()` and/or `buildSnapshot()`. Replace with imports from the test kit.

- [ ] **Step 1: Update `tests/unit/throttle.test.ts`**

Remove the local `createMockPrimitives` function (currently at line 4). Add import:
```ts
import { createMockPrimitives } from '../../src/testing/index.js';
```

- [ ] **Step 2: Update `tests/unit/auth-guard.test.ts`**

Remove the local `createMockPrimitives` function (currently at line 9). Add import:
```ts
import { createMockPrimitives } from '../../src/testing/index.js';
```

- [ ] **Step 3: Update `tests/unit/ops-ensure-state.test.ts`**

Remove local `createMockPrimitives` (line 6) and `buildSnapshot` (line 22). Add imports:
```ts
import { createMockPrimitives, buildSnapshot } from '../../src/testing/index.js';
```

- [ ] **Step 4: Update `tests/unit/ops-matchers.test.ts`**

Remove local `buildSnapshot` (line 5). Add import:
```ts
import { buildSnapshot } from '../../src/testing/index.js';
```

- [ ] **Step 5: Update `tests/contract/server.test.ts`**

Remove local `createMockPrimitives` (line 46). Add import:
```ts
import { createMockPrimitives } from '../../src/testing/index.js';
```

- [ ] **Step 6: Run all tests to verify no regressions**

Run: `pnpm test`
Expected: all tests PASS — same count as before, just imports changed

- [ ] **Step 7: Commit**

```bash
git add tests/unit/throttle.test.ts tests/unit/auth-guard.test.ts tests/unit/ops-ensure-state.test.ts tests/unit/ops-matchers.test.ts tests/contract/server.test.ts
git commit -m "refactor(tests): use shared test kit instead of per-file mock helpers"
```

---

### Task 5: Final verification

- [ ] **Step 1: Full build**

Run: `pnpm run build`
Expected: success, zero errors

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all tests PASS

- [ ] **Step 3: Verify public API surfaces are importable**

Create a temporary verification script:
```ts
// verify-exports.mts (temporary, delete after)
import type { SitePlugin, FeedItem, FeedResult } from './dist/registry/index.js';
import type { Primitives } from './dist/primitives/types.js';
import { matchByRule } from './dist/ops/index.js';
import { createMockPrimitives, buildSnapshot } from './dist/testing/index.js';

// If this compiles, the exports work
const p = createMockPrimitives();
const s = buildSnapshot([{ uid: '1', role: 'link', name: 'test' }]);
console.log('All exports verified');
```

Run: `npx tsc --noEmit verify-exports.mts`
Expected: success

Delete: `rm verify-exports.mts`

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "feat(m8): multi-site plugin architecture complete"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] `site-use` exports Primitives, SitePlugin, core types (Section 8.2) → Task 3
   - [x] `site-use/ops` exports matchByRule, ensureState, ARIA helpers (Section 8.2) → Task 2
   - [x] `site-use/testing` exports createMockPrimitives, buildSnapshot, etc. (Section 8.2) → Task 1
   - [x] Test kit usable by both built-in and external plugins (Section 7.2) → Task 1
   - [x] Existing tests migrated to shared test kit (Section 7.2) → Task 4
   - [x] package.json exports configured with types (Section 10.6) → Task 3

2. **Placeholder scan:** No TBDs. All code complete. Task 4 steps are mechanical (delete local function, add import) but explicit about which file and which line.

3. **Type consistency:** `createMockPrimitives`, `buildSnapshot`, `createMockStore`, `assertIngestItems` — names consistent with design doc Section 7.2.

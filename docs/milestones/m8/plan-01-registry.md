# Plan 1: Registry — Types, Validation, Discovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the SitePlugin contract types, implement startup-time validation, and build the plugin discovery mechanism (built-in + external).

**Architecture:** New `src/registry/` module with three files: types (SitePlugin interface and friends), validation (Zod schema to validate plugin objects at startup), and discovery (load built-in from static registry + external from config.json). A build script auto-generates the built-in plugin registry file. All tests use a FakeSitePlugin — no real sites needed.

**Tech Stack:** TypeScript, Zod, Vitest

**Spec:** [M8 Multi-Site Plugin Architecture](./multi-site-plugin-architecture.md)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/registry/types.ts` | SitePlugin, FeedItem, FeedResult, capabilities, workflow declarations, all framework-level types |
| Create | `src/registry/validation.ts` | Zod schema for SitePlugin, reserved name check, duplicate detection |
| Create | `src/registry/discovery.ts` | Load built-in plugins from `_registry`, external from config.json, merge with priority |
| Create | `src/registry/index.ts` | Public API re-export |
| Create | `src/sites/_registry.ts` | Static built-in plugin registry (initially empty — Twitter not yet migrated) |
| Create | `scripts/generate-registry.mjs` | Build script to scan `src/sites/*/index.ts` and regenerate `_registry.ts` |
| Create | `tests/unit/registry-validation.test.ts` | Validation tests |
| Create | `tests/unit/registry-discovery.test.ts` | Discovery tests |
| Modify | `src/config.ts` | Add `configDir` and `pluginsConfig` to `getConfig()` |

---

### Task 1: Define framework-level types

**Files:**
- Create: `src/registry/types.ts`

These are pure type definitions. No runtime code, no tests needed yet — validation tests (Task 2) will exercise them.

- [ ] **Step 1: Create `src/registry/types.ts`**

```ts
import type { ZodType } from 'zod';
import type { Primitives } from '../primitives/types.js';
import type { DetectFn } from '../primitives/rate-limit-detect.js';
import type { IngestItem } from '../storage/types.js';

// ── Expose target ──────────────────────────────────────────────

export type ExposeTarget = 'mcp' | 'cli';

// ── CLI config ─────────────────────────────────────────────────

export interface CliArgDeclaration {
  name: string;
  description: string;
  required?: boolean;
}

export interface CliFlagDeclaration {
  name: string;
  alias?: string;
  description: string;
  type: 'string' | 'number' | 'boolean';
  default?: unknown;
}

export interface CliConfig {
  description: string;
  help: string;
  examples?: string[];
  args?: CliArgDeclaration[];
  flags?: CliFlagDeclaration[];
}

// ── Feed types (framework-level) ───────────────────────────────

export interface MediaItem {
  type: string;
  url: string;
  width: number;
  height: number;
  duration?: number;
  thumbnailUrl?: string;
}

export interface FeedItem {
  id: string;
  author: { handle: string; name: string };
  text: string;
  timestamp: string;
  url: string;
  media: MediaItem[];
  links: string[];
  /** Site-specific fields (metrics, categories, etc.) */
  siteMeta: Record<string, unknown>;
}

export interface FeedMeta {
  coveredUsers: string[];
  timeRange: { from: string; to: string };
}

export interface FeedResult {
  items: FeedItem[];
  meta: FeedMeta;
}

// ── Auth types ─────────────────────────────────────────────────

export interface CheckLoginResult {
  loggedIn: boolean;
}

// ── Capabilities ───────────────────────────────────────────────

export interface AuthCapability {
  check: (primitives: Primitives) => Promise<CheckLoginResult>;
  description?: string;
  expose?: ExposeTarget[];
  cli?: CliConfig;
}

export interface FeedCapability {
  collect: (primitives: Primitives, params: unknown) => Promise<FeedResult>;
  params: ZodType;
  description?: string;
  expose?: ExposeTarget[];
  cli?: CliConfig;
}

// ── Workflow declaration ───────────────────────────────────────

export interface WorkflowDeclaration {
  name: string;
  description: string;
  params: ZodType;
  execute: (primitives: Primitives, params: unknown) => Promise<unknown>;
  expose?: ExposeTarget[];
  cli?: CliConfig;
}

// ── Store adapter ──────────────────────────────────────────────

export interface StoreAdapter {
  toIngestItems: (items: FeedItem[]) => IngestItem[];
}

// ── Error hints ────────────────────────────────────────────────

export interface SiteErrorHints {
  sessionExpired?: string;
  rateLimited?: string;
  elementNotFound?: string;
  navigationFailed?: string;
  stateTransitionFailed?: string;
}

// ── SitePlugin (the contract) ──────────────────────────────────

export interface SitePlugin {
  apiVersion: 1;
  name: string;
  domains: string[];
  detect?: DetectFn;
  capabilities?: {
    auth?: AuthCapability;
    feed?: FeedCapability;
  };
  customWorkflows?: WorkflowDeclaration[];
  storeAdapter?: StoreAdapter;
  hints?: SiteErrorHints;
}
```

- [ ] **Step 2: Create `src/registry/index.ts`**

```ts
export type {
  SitePlugin,
  FeedItem,
  FeedMeta,
  FeedResult,
  MediaItem,
  CheckLoginResult,
  AuthCapability,
  FeedCapability,
  WorkflowDeclaration,
  StoreAdapter,
  SiteErrorHints,
  ExposeTarget,
  CliConfig,
} from './types.js';
```

- [ ] **Step 3: Build and verify no compilation errors**

Run: `pnpm run build`
Expected: success, no type errors

- [ ] **Step 4: Commit**

```bash
git add src/registry/types.ts src/registry/index.ts
git commit -m "feat(registry): define SitePlugin contract types"
```

---

### Task 2: Plugin validation

**Files:**
- Create: `src/registry/validation.ts`
- Create: `tests/unit/registry-validation.test.ts`

- [ ] **Step 1: Write failing tests for plugin validation**

```ts
// tests/unit/registry-validation.test.ts
import { describe, it, expect } from 'vitest';
import { validatePlugins } from '../../src/registry/validation.js';
import type { SitePlugin } from '../../src/registry/types.js';

function fakePlugin(overrides: Partial<SitePlugin> = {}): SitePlugin {
  return {
    apiVersion: 1,
    name: 'fake',
    domains: ['fake.com'],
    ...overrides,
  };
}

describe('validatePlugins', () => {
  it('accepts a valid minimal plugin', () => {
    expect(() => validatePlugins([fakePlugin()])).not.toThrow();
  });

  it('accepts a plugin with all optional fields', () => {
    const plugin = fakePlugin({
      detect: () => null,
      capabilities: {
        auth: { check: async () => ({ loggedIn: true }) },
      },
      hints: { rateLimited: 'Wait and retry' },
    });
    expect(() => validatePlugins([plugin])).not.toThrow();
  });

  it('rejects plugin missing name', () => {
    const plugin = { apiVersion: 1, domains: ['x.com'] } as unknown as SitePlugin;
    expect(() => validatePlugins([plugin])).toThrow(/name/i);
  });

  it('rejects plugin with empty domains', () => {
    const plugin = fakePlugin({ domains: [] });
    expect(() => validatePlugins([plugin])).toThrow(/domains/i);
  });

  it('rejects plugin with wrong apiVersion', () => {
    const plugin = fakePlugin({ apiVersion: 2 as never });
    expect(() => validatePlugins([plugin])).toThrow(/apiVersion/i);
  });

  it('rejects plugin with reserved name "browser"', () => {
    const plugin = fakePlugin({ name: 'browser' });
    expect(() => validatePlugins([plugin])).toThrow(/reserved/i);
  });

  it('rejects plugin with reserved name "search"', () => {
    const plugin = fakePlugin({ name: 'search' });
    expect(() => validatePlugins([plugin])).toThrow(/reserved/i);
  });

  it('rejects plugin with reserved name "mcp"', () => {
    const plugin = fakePlugin({ name: 'mcp' });
    expect(() => validatePlugins([plugin])).toThrow(/reserved/i);
  });

  it('rejects duplicate plugin names', () => {
    const a = fakePlugin({ name: 'dup' });
    const b = fakePlugin({ name: 'dup', domains: ['other.com'] });
    expect(() => validatePlugins([a, b])).toThrow(/duplicate/i);
  });

  it('allows multiple plugins with different names', () => {
    const a = fakePlugin({ name: 'alpha', domains: ['alpha.com'] });
    const b = fakePlugin({ name: 'beta', domains: ['beta.com'] });
    expect(() => validatePlugins([a, b])).not.toThrow();
  });

  it('allows multiple plugins with overlapping domains', () => {
    const a = fakePlugin({ name: 'alpha', domains: ['shared.com'] });
    const b = fakePlugin({ name: 'beta', domains: ['shared.com'] });
    expect(() => validatePlugins([a, b])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/unit/registry-validation.test.ts`
Expected: FAIL — `validatePlugins` does not exist

- [ ] **Step 3: Implement validation**

```ts
// src/registry/validation.ts
import { z } from 'zod';

const RESERVED_NAMES = new Set([
  'browser', 'search', 'stats', 'rebuild',
  'clean', 'diagnose', 'mcp', 'help',
]);

/**
 * Zod schema for validating a single SitePlugin structure at startup.
 * Only validates the declarative shape — function fields are checked as "defined".
 */
const SitePluginSchema = z.object({
  apiVersion: z.literal(1),
  name: z.string().min(1),
  domains: z.array(z.string()).min(1),
  detect: z.function().optional(),
  capabilities: z.object({
    auth: z.object({
      check: z.function(),
      description: z.string().optional(),
      expose: z.array(z.enum(['mcp', 'cli'])).optional(),
      cli: z.unknown().optional(),
    }).optional(),
    feed: z.object({
      collect: z.function(),
      params: z.unknown(),  // ZodType — can't validate Zod schemas with Zod
      description: z.string().optional(),
      expose: z.array(z.enum(['mcp', 'cli'])).optional(),
      cli: z.unknown().optional(),
    }).optional(),
  }).optional(),
  customWorkflows: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    params: z.unknown(),
    execute: z.function(),
    expose: z.array(z.enum(['mcp', 'cli'])).optional(),
    cli: z.unknown().optional(),
  })).optional(),
  storeAdapter: z.object({
    toIngestItems: z.function(),
  }).optional(),
  hints: z.object({
    sessionExpired: z.string().optional(),
    rateLimited: z.string().optional(),
    elementNotFound: z.string().optional(),
    navigationFailed: z.string().optional(),
    stateTransitionFailed: z.string().optional(),
  }).optional(),
});

/**
 * Validate an array of SitePlugin objects at startup.
 * Throws on the first validation error (fatal — forces developer to fix).
 */
export function validatePlugins(plugins: unknown[]): void {
  const seenNames = new Set<string>();

  for (const plugin of plugins) {
    // Zod structure validation
    const result = SitePluginSchema.safeParse(plugin);
    if (!result.success) {
      const name = (plugin as Record<string, unknown>)?.name ?? '(unknown)';
      throw new Error(
        `Plugin "${name}" validation failed: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    const validated = result.data;

    // Reserved name check
    if (RESERVED_NAMES.has(validated.name)) {
      throw new Error(
        `Plugin "${validated.name}" validation failed: name is reserved (conflicts with built-in CLI command). Reserved names: ${[...RESERVED_NAMES].join(', ')}`,
      );
    }

    // Duplicate check
    if (seenNames.has(validated.name)) {
      throw new Error(
        `Plugin validation failed: duplicate plugin name "${validated.name}". Each plugin must have a unique name.`,
      );
    }
    seenNames.add(validated.name);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/registry-validation.test.ts`
Expected: all 11 tests PASS

- [ ] **Step 5: Export from index**

Add to `src/registry/index.ts`:
```ts
export { validatePlugins } from './validation.js';
```

- [ ] **Step 6: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 7: Commit**

```bash
git add src/registry/validation.ts src/registry/index.ts tests/unit/registry-validation.test.ts
git commit -m "feat(registry): plugin validation with reserved names and duplicate detection"
```

---

### Task 3: Config extension for plugins

**Files:**
- Modify: `src/config.ts`
- Create: `tests/unit/config-plugins.test.ts`

- [ ] **Step 1: Write failing tests for plugin config loading**

```ts
// tests/unit/config-plugins.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getPluginsConfig } from '../../src/config.js';

describe('getPluginsConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty plugins array when config.json does not exist', () => {
    const result = getPluginsConfig(tmpDir);
    expect(result.plugins).toEqual([]);
  });

  it('reads plugins array from config.json', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: ['@site-use/plugin-reddit', './my-local-plugin'],
    }));
    const result = getPluginsConfig(tmpDir);
    expect(result.plugins).toEqual(['@site-use/plugin-reddit', './my-local-plugin']);
  });

  it('returns empty plugins array when config.json has no plugins field', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ someOther: true }));
    const result = getPluginsConfig(tmpDir);
    expect(result.plugins).toEqual([]);
  });

  it('throws on malformed JSON', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{ not valid json');
    expect(() => getPluginsConfig(tmpDir)).toThrow(/config\.json/i);
  });

  it('resolves relative plugin paths relative to config dir', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: ['./my-plugin', '@scope/pkg'],
    }));
    const result = getPluginsConfig(tmpDir);
    // Relative paths resolved, npm packages left as-is
    expect(result.resolvedPluginPaths).toEqual([
      path.join(tmpDir, 'my-plugin'),
      '@scope/pkg',
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/unit/config-plugins.test.ts`
Expected: FAIL — `getPluginsConfig` does not exist

- [ ] **Step 3: Implement getPluginsConfig**

Add to the end of `src/config.ts`:

```ts
export interface PluginsConfig {
  plugins: string[];
  resolvedPluginPaths: string[];
}

export function getPluginsConfig(configDir: string): PluginsConfig {
  const configPath = path.join(configDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    return { plugins: [], resolvedPluginPaths: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return { plugins: [], resolvedPluginPaths: [] };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse config.json at ${configPath}: ${(err as Error).message}`,
    );
  }

  const plugins = Array.isArray(parsed.plugins)
    ? (parsed.plugins as string[])
    : [];

  const resolvedPluginPaths = plugins.map((spec) => {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return path.join(configDir, spec);
    }
    return spec;
  });

  return { plugins, resolvedPluginPaths };
}
```

Add `import fs from 'node:fs';` at the top of `src/config.ts` (currently only imports `path` and `os`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/config-plugins.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 5: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/unit/config-plugins.test.ts
git commit -m "feat(config): add plugin config loading from config.json"
```

---

### Task 4: Built-in plugin registry and generation script

**Files:**
- Create: `src/sites/_registry.ts`
- Create: `scripts/generate-registry.mjs`

- [ ] **Step 1: Create initial empty `_registry.ts`**

```ts
// src/sites/_registry.ts
// Auto-generated by scripts/generate-registry.mjs — do not edit manually.
// Re-run: node scripts/generate-registry.mjs

// No built-in plugins have been migrated to SitePlugin format yet.
// After migration, this file will contain:
//   export { plugin as twitter } from './twitter/index.js';
```

- [ ] **Step 2: Create the generation script**

```js
// scripts/generate-registry.mjs
import fs from 'node:fs';
import path from 'node:path';

const sitesDir = path.join(process.cwd(), 'src', 'sites');
const outputPath = path.join(sitesDir, '_registry.ts');

const entries = [];

for (const entry of fs.readdirSync(sitesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith('_')) continue;

  const indexPath = path.join(sitesDir, entry.name, 'index.ts');
  if (!fs.existsSync(indexPath)) continue;

  entries.push(entry.name);
}

const lines = [
  '// Auto-generated by scripts/generate-registry.mjs — do not edit manually.',
  '// Re-run: node scripts/generate-registry.mjs',
  '',
];

if (entries.length === 0) {
  lines.push('// No built-in SitePlugin modules found (sites/*/index.ts).');
  lines.push('export {};');
} else {
  for (const name of entries.sort()) {
    lines.push(`export { plugin as ${name} } from './${name}/index.js';`);
  }
}

lines.push('');

fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
console.log(`Generated ${outputPath} with ${entries.length} plugin(s): ${entries.join(', ') || '(none)'}`);
```

- [ ] **Step 3: Run the generation script and verify output**

Run: `node scripts/generate-registry.mjs`
Expected: prints `Generated ... with 0 plugin(s): (none)` (Twitter has no `index.ts` yet)

Verify `src/sites/_registry.ts` contains:
```ts
// Auto-generated by scripts/generate-registry.mjs — do not edit manually.
// Re-run: node scripts/generate-registry.mjs

// No built-in SitePlugin modules found (sites/*/index.ts).
export {};
```

- [ ] **Step 4: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 5: Commit**

```bash
git add src/sites/_registry.ts scripts/generate-registry.mjs
git commit -m "feat(registry): add built-in plugin registry and generation script"
```

---

### Task 5: Plugin discovery module

**Files:**
- Create: `src/registry/discovery.ts`
- Create: `tests/unit/registry-discovery.test.ts`
- Modify: `src/registry/index.ts`

- [ ] **Step 1: Write failing tests for discovery**

```ts
// tests/unit/registry-discovery.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SitePlugin } from '../../src/registry/types.js';

function fakePlugin(name: string, domains: string[] = [`${name}.com`]): SitePlugin {
  return { apiVersion: 1, name, domains };
}

// We test discoverPlugins by mocking the built-in registry and config loading.
// The real module uses dynamic imports, so we test the merge logic directly.

describe('mergePlugins', () => {
  let mergePlugins: typeof import('../../src/registry/discovery.js').mergePlugins;

  beforeEach(async () => {
    const mod = await import('../../src/registry/discovery.js');
    mergePlugins = mod.mergePlugins;
  });

  it('returns built-in plugins when no external plugins', () => {
    const builtins = [fakePlugin('twitter')];
    const result = mergePlugins(builtins, []);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('twitter');
  });

  it('returns external plugins alongside built-ins', () => {
    const builtins = [fakePlugin('twitter')];
    const externals = [fakePlugin('reddit')];
    const result = mergePlugins(builtins, externals);
    expect(result).toHaveLength(2);
    expect(result.map(p => p.name).sort()).toEqual(['reddit', 'twitter']);
  });

  it('external plugin overrides built-in with same name', () => {
    const builtinTwitter = fakePlugin('twitter', ['twitter.com']);
    const externalTwitter = fakePlugin('twitter', ['x.com', 'custom.com']);
    const result = mergePlugins([builtinTwitter], [externalTwitter]);
    expect(result).toHaveLength(1);
    expect(result[0].domains).toEqual(['x.com', 'custom.com']);
  });

  it('returns empty array when no plugins from either source', () => {
    const result = mergePlugins([], []);
    expect(result).toHaveLength(0);
  });

  it('preserves order: external first, then remaining built-ins', () => {
    const builtins = [fakePlugin('alpha'), fakePlugin('beta')];
    const externals = [fakePlugin('gamma')];
    const result = mergePlugins(builtins, externals);
    expect(result.map(p => p.name)).toEqual(['gamma', 'alpha', 'beta']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/unit/registry-discovery.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement discovery module**

```ts
// src/registry/discovery.ts
import type { SitePlugin } from './types.js';
import { validatePlugins } from './validation.js';
import { getPluginsConfig } from '../config.js';
import { getConfig } from '../config.js';

/**
 * Merge built-in and external plugins.
 * External plugins with the same name override built-ins.
 */
export function mergePlugins(
  builtins: SitePlugin[],
  externals: SitePlugin[],
): SitePlugin[] {
  const externalNames = new Set(externals.map(p => p.name));
  const filteredBuiltins = builtins.filter(p => !externalNames.has(p.name));
  return [...externals, ...filteredBuiltins];
}

/**
 * Load built-in plugins from the static registry module.
 */
async function loadBuiltinPlugins(): Promise<SitePlugin[]> {
  const registry = await import('../sites/_registry.js');
  const plugins: SitePlugin[] = [];
  for (const [, value] of Object.entries(registry)) {
    if (value && typeof value === 'object' && 'name' in value && 'domains' in value) {
      plugins.push(value as SitePlugin);
    }
  }
  return plugins;
}

/**
 * Load external plugins declared in config.json via dynamic import.
 */
async function loadExternalPlugins(configDir: string): Promise<SitePlugin[]> {
  const { resolvedPluginPaths } = getPluginsConfig(configDir);
  const plugins: SitePlugin[] = [];

  for (const spec of resolvedPluginPaths) {
    let mod: Record<string, unknown>;
    try {
      mod = await import(spec) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Failed to load external plugin "${spec}": ${(err as Error).message}`,
      );
    }

    const plugin = (mod.plugin ?? mod.default) as SitePlugin | undefined;
    if (!plugin || typeof plugin !== 'object' || !('name' in plugin)) {
      throw new Error(
        `External plugin "${spec}" does not export a valid SitePlugin object. ` +
        `Expected: export const plugin: SitePlugin = { ... }`,
      );
    }
    plugins.push(plugin);
  }

  return plugins;
}

/**
 * Discover all plugins (built-in + external), validate, and return.
 * Throws fatal error on validation failure.
 */
export async function discoverPlugins(): Promise<SitePlugin[]> {
  const config = getConfig();
  const configDir = config.dataDir;

  const builtins = await loadBuiltinPlugins();
  const externals = await loadExternalPlugins(configDir);
  const merged = mergePlugins(builtins, externals);

  validatePlugins(merged);

  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/registry-discovery.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 5: Export from index**

Add to `src/registry/index.ts`:
```ts
export { discoverPlugins, mergePlugins } from './discovery.js';
```

- [ ] **Step 6: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 7: Run all unit tests to check nothing broke**

Run: `pnpm test tests/unit`
Expected: all existing tests still pass + new tests pass

- [ ] **Step 8: Commit**

```bash
git add src/registry/discovery.ts src/registry/index.ts tests/unit/registry-discovery.test.ts
git commit -m "feat(registry): plugin discovery with built-in and external loading"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] SitePlugin interface with all fields (Section 1) → Task 1
   - [x] FeedItem, FeedResult, FeedMeta framework types (Section 1.1) → Task 1
   - [x] AuthCapability, FeedCapability (Section 1.1) → Task 1
   - [x] WorkflowDeclaration (Section 1.2) → Task 1
   - [x] CliConfig (Section 1.3) → Task 1
   - [x] StoreAdapter (Section 1.4) → Task 1
   - [x] SiteErrorHints (Section 1.5) → Task 1
   - [x] apiVersion: 1 (Section 9) → Task 1
   - [x] Reserved name validation (Section 2.3) → Task 2
   - [x] Startup Zod validation, fatal on failure (Section 2.3) → Task 2
   - [x] Config file loading (Section 2.2) → Task 3
   - [x] Relative path resolution to config dir (Section 10.2) → Task 3
   - [x] Built-in static registry (Section 10.1) → Task 4
   - [x] Discovery: built-in + external merge (Section 2.1) → Task 5
   - [x] External overrides built-in same name (Section 2.1) → Task 5
   - [x] Domains overlap allowed (Section 2.3) → Task 2 (test)

2. **Placeholder scan:** No TBDs, TODOs, or vague steps. All code blocks are complete.

3. **Type consistency:** `SitePlugin`, `FeedItem`, `FeedResult`, `validatePlugins`, `mergePlugins`, `discoverPlugins` — names consistent across all tasks.

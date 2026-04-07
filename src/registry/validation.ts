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
  auth: z.object({
    check: z.function(),
    guard: z.function().optional(),
    guardNavigate: z.boolean().optional(),
    description: z.string().optional(),
    expose: z.array(z.enum(['mcp', 'cli'])).optional(),
    cli: z.unknown().optional(),
  }).optional(),
  storeAdapter: z.object({
    toIngestItems: z.function().args(z.array(z.any()), z.record(z.unknown()).optional()),
  }).optional(),
  hints: z.object({
    sessionExpired: z.string().optional(),
    rateLimited: z.string().optional(),
    elementNotFound: z.string().optional(),
    navigationFailed: z.string().optional(),
    stateTransitionFailed: z.string().optional(),
  }).optional(),
  workflows: z.array(z.discriminatedUnion('kind', [
    // Collection workflow
    z.object({
      kind: z.literal('collection'),
      name: z.string().min(1),
      description: z.string().min(1),
      params: z.unknown(),
      execute: z.function(),
      cache: z.object({
        defaultMaxAge: z.number(),
        variantKey: z.string().optional(),
        defaultVariant: z.string().optional(),
        canonicalizeVariant: z.function().optional(),
      }).optional(),
      localQuery: z.function().optional(),
      dumpRaw: z.boolean().optional(),
      expose: z.array(z.enum(['mcp', 'cli'])).optional(),
      cli: z.unknown().optional(),
    }),
    // Action workflow
    z.object({
      kind: z.literal('action'),
      name: z.string().min(1),
      description: z.string().min(1),
      params: z.unknown(),
      execute: z.function(),
      dailyLimit: z.number().optional(),
      dailyLimitKey: z.string().optional(),
      expose: z.array(z.enum(['mcp', 'cli'])).optional(),
      cli: z.unknown().optional(),
    }),
    // Query workflow
    z.object({
      kind: z.literal('query'),
      name: z.string().min(1),
      description: z.string().min(1),
      params: z.unknown(),
      execute: z.function(),
      expose: z.array(z.enum(['mcp', 'cli'])).optional(),
      cli: z.unknown().optional(),
    }),
  ])).optional(),
});

/**
 * Validate an array of SitePlugin objects at startup.
 * Throws on the first validation error (fatal — forces developer to fix).
 */
export function validatePlugins(plugins: unknown[]): void {
  const seenNames = new Set<string>();

  for (const plugin of plugins) {
    const result = SitePluginSchema.safeParse(plugin);
    if (!result.success) {
      const name = (plugin as Record<string, unknown>)?.name ?? '(unknown)';
      throw new Error(
        `Plugin "${name}" validation failed: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    const validated = result.data;

    if (RESERVED_NAMES.has(validated.name)) {
      throw new Error(
        `Plugin "${validated.name}" validation failed: name is reserved (conflicts with built-in CLI command). Reserved names: ${[...RESERVED_NAMES].join(', ')}`,
      );
    }

    if (seenNames.has(validated.name)) {
      throw new Error(
        `Plugin validation failed: duplicate plugin name "${validated.name}". Each plugin must have a unique name.`,
      );
    }
    seenNames.add(validated.name);

    // Validate workflow constraints
    const workflows = (validated as Record<string, unknown>).workflows as Array<Record<string, unknown>> | undefined;
    if (workflows) {
      for (const wf of workflows) {
        if (wf.kind === 'collection' && wf.localQuery && !wf.cache) {
          throw new Error(
            `Plugin "${validated.name}" workflow "${wf.name}" declares localQuery without cache. localQuery requires cache for freshness decisions.`,
          );
        }
      }
    }
  }
}

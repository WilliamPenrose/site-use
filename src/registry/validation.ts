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
      params: z.unknown(),
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
  }
}

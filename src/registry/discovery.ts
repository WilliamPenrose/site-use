import type { SitePlugin } from './types.js';
import { validatePlugins } from './validation.js';
import { getConfig, getPluginsConfig } from '../config.js';

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

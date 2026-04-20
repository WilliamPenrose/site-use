import type { SitePlugin } from '../registry/types.js';
import type { SiteRuntime } from './types.js';
import { toRuntimeSiteDefinition } from './site-definition.js';
import { createSiteUseRuntime } from './runtime-factory.js';

export interface SiteRuntimeAccess {
  has(siteName: string): boolean;
  getSiteRuntime(siteName: string): Promise<SiteRuntime>;
  clearSite(siteName: string): Promise<void>;
  clearAll(): Promise<void>;
}

export function createSiteRuntimeAccess(plugins: SitePlugin[]): SiteRuntimeAccess {
  const pluginsByName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  const runtime = createSiteUseRuntime();

  return {
    has(siteName: string): boolean {
      return runtime.hasSite(siteName);
    },

    async getSiteRuntime(siteName: string): Promise<SiteRuntime> {
      const plugin = pluginsByName.get(siteName);
      if (!plugin) {
        throw new Error(
          `Unknown site "${siteName}". Available sites: ${[...pluginsByName.keys()].join(', ')}`,
        );
      }

      const session = await runtime.openSite(toRuntimeSiteDefinition(plugin));
      return Object.assign(session, { plugin }) as SiteRuntime;
    },

    async clearSite(siteName: string): Promise<void> {
      await runtime.clearSite(siteName);
    },

    async clearAll(): Promise<void> {
      await runtime.clearAll();
    },
  };
}

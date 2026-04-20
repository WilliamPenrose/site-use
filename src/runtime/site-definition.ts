import type { RuntimeSiteDefinition } from '@site-use/runtime';
import type { SitePlugin } from '../registry/types.js';
import type { Primitives } from '../primitives/types.js';

export function toRuntimeSiteDefinition(
  plugin: SitePlugin,
): RuntimeSiteDefinition<Primitives> {
  return {
    name: plugin.name,
    domains: [...plugin.domains],
    auth: plugin.auth
      ? {
          check: plugin.auth.check,
          guard: plugin.auth.guard,
          guardNavigate: plugin.auth.guardNavigate,
        }
      : undefined,
    detect: plugin.detect,
  };
}

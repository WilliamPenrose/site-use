import type { SiteSession } from '@site-use/runtime';
import type { RateLimitDetector } from '@site-use/runtime/internal/primitives';
import type { Primitives } from '../primitives/types.js';
import type { SitePlugin } from '../registry/types.js';

export interface SiteRuntime extends SiteSession<Primitives, RateLimitDetector> {
  plugin: SitePlugin;
}

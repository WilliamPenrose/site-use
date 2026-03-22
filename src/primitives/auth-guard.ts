import type { Primitives } from './types.js';
import { SessionExpired } from '../errors.js';

export interface AuthGuardConfig {
  site: string;
  domains: string[];
  check: (innerPrimitives: Primitives) => Promise<boolean>;
}

function urlMatchesDomain(url: string, domains: string[]): boolean {
  try {
    if (url.startsWith('data:') || url === 'about:blank') return false;
    const hostname = new URL(url).hostname;
    return domains.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

export function createAuthGuardedPrimitives(
  inner: Primitives,
  configs: AuthGuardConfig[],
): Primitives {
  return {
    navigate: async (url: string, site?: string) => {
      await inner.navigate(url, site);

      // Check if this URL belongs to a protected site
      for (const config of configs) {
        if (urlMatchesDomain(url, config.domains)) {
          const isLoggedIn = await config.check(inner);
          if (!isLoggedIn) {
            throw new SessionExpired(
              `${config.site} login required`,
              {
                url,
                step: 'authGuard',
              },
            );
          }
          break;
        }
      }
    },

    // All other operations pass through unchanged
    takeSnapshot: (site?) => inner.takeSnapshot(site),
    click: (uid, site?) => inner.click(uid, site),
    type: (uid, text, site?) => inner.type(uid, text, site),
    scroll: (options, site?) => inner.scroll(options, site),
    scrollIntoView: (uid, site?) => inner.scrollIntoView(uid, site),
    evaluate: <T = unknown>(expression: string, site?: string) =>
      inner.evaluate<T>(expression, site),
    screenshot: (site?) => inner.screenshot(site),
    interceptRequest: (pattern, handler, site?) =>
      inner.interceptRequest(pattern, handler, site),
    getRawPage: (site?) => inner.getRawPage(site),
  };
}

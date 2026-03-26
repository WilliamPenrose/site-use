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
    navigate: async (url: string) => {
      await inner.navigate(url);

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
    takeSnapshot: () => inner.takeSnapshot(),
    click: (uid) => inner.click(uid),
    type: (uid, text) => inner.type(uid, text),
    scroll: (options) => inner.scroll(options),
    scrollIntoView: (uid) => inner.scrollIntoView(uid),
    evaluate: <T = unknown>(expression: string) =>
      inner.evaluate<T>(expression),
    screenshot: () => inner.screenshot(),
    interceptRequest: (pattern, handler) =>
      inner.interceptRequest(pattern, handler),
    getRawPage: () => inner.getRawPage(),
  };
}

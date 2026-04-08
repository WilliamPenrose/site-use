import type { Primitives } from './types.js';
import { SessionExpired } from '../errors.js';

export interface AuthGuardCheckResult {
  loggedIn: boolean;
  diagnostics?: unknown;
}

export interface AuthGuardConfig {
  site: string;
  domains: string[];
  check: (innerPrimitives: Primitives) => Promise<AuthGuardCheckResult>;
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

const AUTH_CACHE_MS = 30_000; // 30s — skip re-check within this window

export function createAuthGuardedPrimitives(
  inner: Primitives,
  configs: AuthGuardConfig[],
): Primitives {
  // Per-site timestamp of last successful auth check
  const lastAuthOk = new Map<string, number>();

  return {
    navigate: async (url: string) => {
      const navStart = Date.now();
      await inner.navigate(url);
      const navMs = Date.now() - navStart;

      // Check if this URL belongs to a protected site
      for (const config of configs) {
        if (urlMatchesDomain(url, config.domains)) {
          // Skip check if recently verified
          const lastOk = lastAuthOk.get(config.site) ?? 0;
          if (Date.now() - lastOk < AUTH_CACHE_MS) {
            break;
          }

          const authStart = Date.now();
          const result = await config.check(inner);
          const authCheckMs = Date.now() - authStart;
          if (!result.loggedIn) {
            lastAuthOk.delete(config.site);
            throw new SessionExpired(
              `${config.site} login required`,
              {
                url,
                step: 'authGuard',
                diagnostics: {
                  site: config.site,
                  navigateMs: navMs,
                  authCheckMs,
                  authDetail: result.diagnostics,
                },
              },
            );
          }
          lastAuthOk.set(config.site, Date.now());
          break;
        }
      }
    },

    // All other operations pass through unchanged
    takeSnapshot: () => inner.takeSnapshot(),
    click: (uid) => inner.click(uid),
    type: (uid, text, options) => inner.type(uid, text, options),
    pressKey: (key) => inner.pressKey(key),
    scroll: (options) => inner.scroll(options),
    scrollIntoView: (uid) => inner.scrollIntoView(uid),
    evaluate: <T = unknown>(expression: string) =>
      inner.evaluate<T>(expression),
    screenshot: () => inner.screenshot(),
    interceptRequest: (pattern, handler) =>
      inner.interceptRequest(pattern, handler),
    interceptRequestWithControl: (pattern, handler) =>
      inner.interceptRequestWithControl(pattern, handler),
    getRawPage: () => inner.getRawPage(),
  };
}

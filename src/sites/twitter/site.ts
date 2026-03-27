/** Twitter site definition — single source of truth for site identity. */
import type { DetectFn } from '../../primitives/rate-limit-detect.js';
import type { SiteConfig } from '../../primitives/factory.js';
import type { Primitives } from '../../primitives/types.js';
import { matchByRule } from '../../ops/matchers.js';
import type { MatcherRule } from '../../ops/matchers.js';

export interface AuthCheckDiagnostic {
  step: string;
  elapsed: number;
  [key: string]: unknown;
}

export interface AuthCheckResult {
  loggedIn: boolean;
  diagnostics: AuthCheckDiagnostic[];
}

export const twitterSite = {
  name: 'twitter',
  domains: ['x.com', 'twitter.com'],
} as const;

/**
 * Twitter-specific rate-limit detection.
 *
 * Priority order:
 * 1. HTTP 429 + x-rate-limit-remaining > 0 → account suspended (not a quota limit)
 * 2. HTTP 429 (standard rate limit)
 * 3. Error code 88 in body (may arrive with HTTP 200 on GraphQL endpoints)
 * 4. No match → null
 */
export const twitterDetect: DetectFn = (response) => {
  const resetHeader = response.headers['x-rate-limit-reset'];
  let resetAt: Date | undefined;
  if (resetHeader !== undefined && resetHeader !== '') {
    const epochSeconds = parseInt(resetHeader, 10);
    if (!isNaN(epochSeconds)) {
      resetAt = new Date(epochSeconds * 1000);
    }
  }

  if (response.status === 429) {
    const remainingHeader = response.headers['x-rate-limit-remaining'];
    const remaining =
      remainingHeader !== undefined && remainingHeader !== ''
        ? parseInt(remainingHeader, 10)
        : 0;

    if (!isNaN(remaining) && remaining > 0) {
      // Remaining quota > 0 but still getting 429 → account suspended
      return {
        url: response.url,
        reason: `Account suspended (429 with x-rate-limit-remaining=${remaining})`,
        ...(resetAt !== undefined ? { resetAt } : {}),
      };
    }

    // Standard 429 rate limit
    return {
      url: response.url,
      reason: `HTTP 429 rate limit response from ${response.url}`,
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  }

  // Error code 88 may appear in the body even on HTTP 200 (GraphQL)
  if (response.body.includes('"code":88') || response.body.includes('"code": 88')) {
    return {
      url: response.url,
      reason: `Twitter error code 88 (rate limit exceeded) from ${response.url}`,
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  }

  return null;
};

const homeNavLink: MatcherRule = { role: 'link', name: /^Home$/i };

export async function isLoggedIn(primitives: Primitives): Promise<AuthCheckResult> {
  const diag: AuthCheckDiagnostic[] = [];
  const t0 = Date.now();

  // Phase 1: URL check
  const currentUrl = await primitives.evaluate<string>('window.location.href');
  const urlCheckMs = Date.now() - t0;
  if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
    diag.push({ step: 'urlCheck', elapsed: urlCheckMs, url: currentUrl, result: 'login_redirect' });
    return { loggedIn: false, diagnostics: diag };
  }
  diag.push({ step: 'urlCheck', elapsed: urlCheckMs, url: currentUrl, result: 'ok' });

  // Phase 2: Poll for Home link
  // Twitter SPA: 'load' event fires before React mounts the nav tree.
  // Poll for the Home link up to 10 seconds before concluding not logged in.
  const pollStart = Date.now();
  const deadline = pollStart + 10_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const snapshot = await primitives.takeSnapshot();
    if (matchByRule(snapshot, homeNavLink)) {
      diag.push({ step: 'snapshotPoll', elapsed: Date.now() - pollStart, attempts, foundHome: true });
      return { loggedIn: true, diagnostics: diag };
    }
    const url = await primitives.evaluate<string>('window.location.href');
    if (url.includes('/login') || url.includes('/i/flow/login')) {
      diag.push({ step: 'snapshotPoll', elapsed: Date.now() - pollStart, attempts, foundHome: false, reason: 'login_redirect', url });
      return { loggedIn: false, diagnostics: diag };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  diag.push({ step: 'snapshotPoll', elapsed: Date.now() - pollStart, attempts, foundHome: false, reason: 'timeout' });
  return { loggedIn: false, diagnostics: diag };
}

export const twitterSiteConfig: SiteConfig = {
  name: twitterSite.name,
  domains: [...twitterSite.domains],
  detect: twitterDetect,
  authCheck: async (inner) => {
    const { loggedIn } = await isLoggedIn(inner);
    return loggedIn;
  },
};

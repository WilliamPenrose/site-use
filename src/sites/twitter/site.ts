/** Twitter site definition — single source of truth for site identity. */
import type { DetectFn } from '../../primitives/rate-limit-detect.js';

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

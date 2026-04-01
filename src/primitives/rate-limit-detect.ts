import { RateLimited } from '../errors.js';

export interface RateLimitSignal {
  url: string;
  resetAt?: Date;
  reason: string;
}

export type DetectFn = (response: {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}) => RateLimitSignal | null;

/**
 * Default detect function: treats HTTP 429 as a rate-limit signal.
 * Reads `x-rate-limit-reset` (Unix epoch seconds) for reset time if present.
 */
export const defaultDetect: DetectFn = (response) => {
  if (response.status !== 429) {
    return null;
  }

  const resetHeader = response.headers['x-rate-limit-reset'];
  let resetAt: Date | undefined;
  if (resetHeader !== undefined && resetHeader !== '') {
    const epochSeconds = parseInt(resetHeader, 10);
    if (!isNaN(epochSeconds)) {
      resetAt = new Date(epochSeconds * 1000);
    }
  }

  return {
    url: response.url,
    reason: `HTTP 429 rate limit response from ${response.url}`,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
};

export class RateLimitDetector {
  readonly signals: Map<string, RateLimitSignal> = new Map();
  readonly siteDetectors: Map<string, DetectFn> = new Map();

  constructor(siteDetectors?: Record<string, DetectFn>) {
    if (siteDetectors) {
      for (const [site, fn] of Object.entries(siteDetectors)) {
        this.siteDetectors.set(site, fn);
      }
    }
  }

  /**
   * Run detection on a response. Stores signal per-site.
   * Skips if a signal already exists for the site.
   */
  onResponse(
    response: { url: string; status: number; headers: Record<string, string>; body: string },
    site: string,
  ): void {
    // Do not overwrite an existing signal
    if (this.signals.has(site)) {
      return;
    }

    const detectFn = this.siteDetectors.get(site) ?? defaultDetect;
    const signal = detectFn(response);
    if (signal !== null) {
      this.signals.set(site, signal);
    }
  }

  /**
   * Checks for a rate-limit signal for the given site (falls back to `_default`).
   * Throws `RateLimited` if a signal is found.
   */
  checkAndThrow(step: string, site?: string): void {
    const signal = (site !== undefined ? this.signals.get(site) : undefined)
      ?? this.signals.get('_default');

    if (signal === undefined) {
      return;
    }

    const resetEpoch = signal.resetAt !== undefined
      ? Math.floor(signal.resetAt.getTime() / 1000)
      : undefined;

    const hint = resetEpoch !== undefined
      ? `Rate limit detected. Reset at epoch ${resetEpoch}. Wait until then before retrying.`
      : 'Rate limit detected. Wait before retrying.';

    throw new RateLimited(`Rate limited at step "${step}": ${signal.reason}`, {
      url: signal.url,
      step,
      hint,
    });
  }

  /**
   * Clears the signal for one site, or all signals if no site is given.
   */
  clear(site?: string): void {
    if (site !== undefined) {
      this.signals.delete(site);
    } else {
      this.signals.clear();
    }
  }
}

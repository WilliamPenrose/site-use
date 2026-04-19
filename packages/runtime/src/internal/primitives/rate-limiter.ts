export interface RateLimitConfig {
  /** Time window in ms. Default: 60_000 (1 minute) */
  window: number;
  /** Max operations within window. Default: 10 */
  maxOps: number;
}

export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  /** Record an operation timestamp. */
  record(): void {
    this.timestamps.push(Date.now());
  }

  /**
   * Get the time to wait before the next operation is allowed.
   * Returns 0 if under the limit.
   */
  getWaitTime(): number {
    const now = Date.now();
    const cutoff = now - this.config.window;

    // Evict expired entries
    this.timestamps = this.timestamps.filter(t => t > cutoff);

    if (this.timestamps.length < this.config.maxOps) {
      return 0;
    }

    // Must wait until the oldest entry expires
    const oldest = this.timestamps[0];
    return oldest + this.config.window - now;
  }
}

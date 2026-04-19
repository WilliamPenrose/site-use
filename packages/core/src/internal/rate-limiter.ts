export interface RateLimitConfig {
  window: number;
  maxOps: number;
}

export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }

  getWaitTime(): number {
    const now = Date.now();
    const cutoff = now - this.config.window;
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);

    if (this.timestamps.length < this.config.maxOps) {
      return 0;
    }

    const oldest = this.timestamps[0];
    return oldest + this.config.window - now;
  }
}

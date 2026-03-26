export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

/**
 * Per-site three-state circuit breaker.
 *
 * - closed:    normal operation, counting consecutive errors
 * - open:      tripped, rejecting all requests for cooldownMs
 * - half-open: cooldown expired, allowing one probe request
 *
 * Transitions:
 *   closed  + threshold errors  → open
 *   open    + cooldown expires  → half-open (checked lazily via isTripped)
 *   half-open + success         → closed
 *   half-open + error           → open (cooldown restarts)
 */
export class CircuitBreaker {
  private errorCount = 0;
  private _state: CircuitBreakerState = 'closed';
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold = 5, cooldownMs = 60_000) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  get state(): CircuitBreakerState {
    // Lazy transition: open → half-open when cooldown expires
    if (this._state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this._state = 'half-open';
    }
    return this._state;
  }

  /** Whether requests should be blocked. */
  get isTripped(): boolean {
    return this.state === 'open';
  }

  /** Current consecutive error count. */
  get streak(): number {
    return this.errorCount;
  }

  /** Record a successful operation. */
  recordSuccess(): void {
    if (this._state === 'half-open') {
      this._state = 'closed';
    }
    this.errorCount = 0;
  }

  /** Record a failed operation. */
  recordError(): void {
    if (this._state === 'half-open') {
      this._state = 'open';
      this.openedAt = Date.now();
      return;
    }
    this.errorCount++;
    if (this.errorCount >= this.threshold) {
      this._state = 'open';
      this.openedAt = Date.now();
    }
  }

  /** Force reset to closed state. */
  reset(): void {
    this._state = 'closed';
    this.errorCount = 0;
    this.openedAt = 0;
  }
}

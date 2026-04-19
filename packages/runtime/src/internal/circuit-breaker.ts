export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private errorCount = 0;
  private stateValue: CircuitBreakerState = 'closed';
  private openedAt = 0;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 60_000,
  ) {}

  get state(): CircuitBreakerState {
    if (this.stateValue === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.stateValue = 'half-open';
    }
    return this.stateValue;
  }

  get isTripped(): boolean {
    return this.state === 'open';
  }

  get streak(): number {
    return this.errorCount;
  }

  recordSuccess(): void {
    if (this.stateValue === 'half-open') {
      this.stateValue = 'closed';
    }
    this.errorCount = 0;
  }

  recordError(): void {
    if (this.stateValue === 'half-open') {
      this.stateValue = 'open';
      this.openedAt = Date.now();
      return;
    }
    this.errorCount += 1;
    if (this.errorCount >= this.threshold) {
      this.stateValue = 'open';
      this.openedAt = Date.now();
    }
  }

  reset(): void {
    this.stateValue = 'closed';
    this.errorCount = 0;
    this.openedAt = 0;
  }
}

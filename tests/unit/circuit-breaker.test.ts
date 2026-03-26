import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../src/runtime/circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // ── closed state ───────────────────────────────────────────
  it('starts in closed state', () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe('closed');
    expect(cb.isTripped).toBe(false);
  });

  it('stays closed below threshold', () => {
    const cb = new CircuitBreaker(5);
    for (let i = 0; i < 4; i++) cb.recordError();
    expect(cb.state).toBe('closed');
    expect(cb.isTripped).toBe(false);
  });

  it('resets streak on success in closed state', () => {
    const cb = new CircuitBreaker(5);
    cb.recordError();
    cb.recordError();
    cb.recordError();
    cb.recordSuccess();
    expect(cb.streak).toBe(0);
    expect(cb.state).toBe('closed');
  });

  // ── closed → open transition ───────────────────────────────
  it('transitions to open at threshold', () => {
    const cb = new CircuitBreaker(5);
    for (let i = 0; i < 5; i++) cb.recordError();
    expect(cb.state).toBe('open');
    expect(cb.isTripped).toBe(true);
  });

  it('blocks requests while open (within cooldown)', () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) cb.recordError();
    expect(cb.isTripped).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(cb.isTripped).toBe(true);
    expect(cb.state).toBe('open');
  });

  // ── open → half-open transition ────────────────────────────
  it('transitions to half-open after cooldown expires', () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) cb.recordError();
    expect(cb.state).toBe('open');
    vi.advanceTimersByTime(60_001);
    expect(cb.isTripped).toBe(false);
    expect(cb.state).toBe('half-open');
  });

  // ── half-open → closed (probe success) ─────────────────────
  it('transitions to closed on success in half-open', () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) cb.recordError();
    vi.advanceTimersByTime(60_001);
    expect(cb.state).toBe('half-open');
    cb.recordSuccess();
    expect(cb.state).toBe('closed');
    expect(cb.streak).toBe(0);
    expect(cb.isTripped).toBe(false);
  });

  // ── half-open → open (probe failure) ───────────────────────
  it('transitions back to open on error in half-open', () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) cb.recordError();
    vi.advanceTimersByTime(60_001);
    expect(cb.state).toBe('half-open');
    cb.recordError();
    expect(cb.state).toBe('open');
    expect(cb.isTripped).toBe(true);
    // Cooldown restarts from now
    vi.advanceTimersByTime(59_999);
    expect(cb.isTripped).toBe(true);
    vi.advanceTimersByTime(2);
    expect(cb.isTripped).toBe(false);
  });

  // ── reset ──────────────────────────────────────────────────
  it('reset() returns to closed regardless of state', () => {
    const cb = new CircuitBreaker(3);
    for (let i = 0; i < 3; i++) cb.recordError();
    expect(cb.state).toBe('open');
    cb.reset();
    expect(cb.state).toBe('closed');
    expect(cb.streak).toBe(0);
  });

  // ── defaults ───────────────────────────────────────────────
  it('uses default threshold of 5 and cooldown of 60s', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 5; i++) cb.recordError();
    expect(cb.state).toBe('open');
    vi.advanceTimersByTime(59_999);
    expect(cb.isTripped).toBe(true);
    vi.advanceTimersByTime(2);
    expect(cb.isTripped).toBe(false);
  });

  it('exposes current streak count', () => {
    const cb = new CircuitBreaker(3);
    expect(cb.streak).toBe(0);
    cb.recordError();
    expect(cb.streak).toBe(1);
    cb.recordError();
    expect(cb.streak).toBe(2);
  });
});

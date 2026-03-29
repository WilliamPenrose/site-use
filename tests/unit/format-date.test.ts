import { describe, it, expect } from 'vitest';
import { utcToLocalIso, localizeTimestamps } from '../../src/format-date.js';

describe('utcToLocalIso', () => {
  it('converts UTC ISO to local timezone ISO with offset', () => {
    const result = utcToLocalIso('2026-03-29T02:03:00.000Z');
    // Should NOT end with Z
    expect(result).not.toMatch(/Z$/);
    // Should contain timezone offset like +08:00 or -05:00
    expect(result).toMatch(/[+-]\d{2}:\d{2}$/);
    // Should be a valid date that round-trips to same UTC instant
    expect(new Date(result).toISOString()).toBe('2026-03-29T02:03:00.000Z');
  });

  it('returns empty string for empty input', () => {
    expect(utcToLocalIso('')).toBe('');
  });

  it('returns original string for invalid date', () => {
    expect(utcToLocalIso('not-a-date')).toBe('not-a-date');
  });
});

describe('localizeTimestamps', () => {
  it('converts timestamp fields in nested objects', () => {
    const input = {
      items: [
        { id: '1', timestamp: '2026-03-29T02:03:00.000Z', text: 'hello' },
      ],
      meta: { timeRange: { from: '2026-03-29T00:00:00.000Z', to: '2026-03-29T23:59:59.000Z' } },
    };
    const result = localizeTimestamps(input) as any;
    expect(result.items[0].timestamp).not.toMatch(/Z$/);
    expect(result.items[0].timestamp).toMatch(/[+-]\d{2}:\d{2}$/);
    // Non-timestamp strings are preserved
    expect(result.items[0].text).toBe('hello');
    expect(result.items[0].id).toBe('1');
  });

  it('handles nested siteMeta with quotedTweet timestamp', () => {
    const input = {
      siteMeta: {
        quotedTweet: { timestamp: '2026-01-01T00:00:00.000Z' },
      },
    };
    const result = localizeTimestamps(input) as any;
    expect(result.siteMeta.quotedTweet.timestamp).not.toMatch(/Z$/);
  });

  it('returns primitives unchanged', () => {
    expect(localizeTimestamps(42)).toBe(42);
    expect(localizeTimestamps(null)).toBe(null);
    expect(localizeTimestamps('hello')).toBe('hello');
  });
});

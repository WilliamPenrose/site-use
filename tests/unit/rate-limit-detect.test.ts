import { describe, it, expect, vi } from 'vitest';
import { defaultDetect, RateLimitDetector } from '../../src/primitives/rate-limit-detect.js';
import { RateLimited } from '../../src/errors.js';

// Helper to build a minimal response object
function makeResponse(overrides: {
  url?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}) {
  return {
    url: overrides.url ?? 'https://api.twitter.com/something',
    status: overrides.status ?? 200,
    headers: overrides.headers ?? {},
    body: overrides.body ?? '',
  };
}

describe('defaultDetect', () => {
  it('returns a signal for HTTP 429', () => {
    const signal = defaultDetect(makeResponse({ status: 429 }));
    expect(signal).not.toBeNull();
    expect(signal?.reason).toMatch(/429/);
    expect(signal?.url).toBe('https://api.twitter.com/something');
  });

  it('returns null for non-429 responses', () => {
    expect(defaultDetect(makeResponse({ status: 200 }))).toBeNull();
    expect(defaultDetect(makeResponse({ status: 403 }))).toBeNull();
    expect(defaultDetect(makeResponse({ status: 500 }))).toBeNull();
  });

  it('handles missing x-rate-limit-reset header gracefully', () => {
    const signal = defaultDetect(makeResponse({ status: 429, headers: {} }));
    expect(signal).not.toBeNull();
    expect(signal?.resetAt).toBeUndefined();
  });

  it('reads x-rate-limit-reset header as reset time', () => {
    const epoch = 1700000000; // seconds
    const signal = defaultDetect(
      makeResponse({ status: 429, headers: { 'x-rate-limit-reset': String(epoch) } }),
    );
    expect(signal).not.toBeNull();
    expect(signal?.resetAt).toBeInstanceOf(Date);
    expect(signal?.resetAt?.getTime()).toBe(epoch * 1000);
  });
});

describe('RateLimitDetector', () => {
  it('checkAndThrow does nothing when no signal exists', () => {
    const detector = new RateLimitDetector();
    expect(() => detector.checkAndThrow('navigate', 'twitter')).not.toThrow();
  });

  it('throws RateLimited after a 429 response', () => {
    const detector = new RateLimitDetector();
    detector.onResponse(makeResponse({ status: 429 }), 'twitter');
    expect(() => detector.checkAndThrow('navigate', 'twitter')).toThrow(RateLimited);
  });

  it('includes reset time (epoch seconds) in error hint when resetAt is present', () => {
    const epoch = 1700000000;
    const detector = new RateLimitDetector();
    detector.onResponse(
      makeResponse({ status: 429, headers: { 'x-rate-limit-reset': String(epoch) } }),
      'twitter',
    );
    let thrown: unknown;
    try {
      detector.checkAndThrow('navigate', 'twitter');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RateLimited);
    const err = thrown as RateLimited;
    expect(err.context.hint).toContain(String(epoch));
  });

  it('uses site-specific detect function when configured', () => {
    const customDetect = vi.fn().mockReturnValue({
      url: 'https://custom.example.com',
      reason: 'custom-detect-fired',
    });
    const detector = new RateLimitDetector({ mysite: customDetect });
    detector.onResponse(makeResponse({ status: 200, url: 'https://custom.example.com' }), 'mysite');
    expect(customDetect).toHaveBeenCalledOnce();
    expect(() => detector.checkAndThrow('step', 'mysite')).toThrow(RateLimited);
  });

  it('falls back to defaultDetect when site has no custom detect', () => {
    const detector = new RateLimitDetector({ othersite: () => null });
    detector.onResponse(makeResponse({ status: 429 }), 'twitter');
    expect(() => detector.checkAndThrow('step', 'twitter')).toThrow(RateLimited);
  });

  it('per-site isolation: twitter 429 does not block other sites', () => {
    const detector = new RateLimitDetector();
    detector.onResponse(makeResponse({ status: 429, url: 'https://api.twitter.com/x' }), 'twitter');
    // A 200 from reddit should not trigger anything
    detector.onResponse(makeResponse({ status: 200, url: 'https://reddit.com/y' }), 'reddit');
    expect(() => detector.checkAndThrow('step', 'reddit')).not.toThrow();
    expect(() => detector.checkAndThrow('step', 'twitter')).toThrow(RateLimited);
  });

  it('clear(site) only clears that site', () => {
    const detector = new RateLimitDetector();
    detector.onResponse(makeResponse({ status: 429, url: 'https://api.twitter.com' }), 'twitter');
    detector.onResponse(makeResponse({ status: 429, url: 'https://reddit.com' }), 'reddit');
    detector.clear('twitter');
    expect(() => detector.checkAndThrow('step', 'twitter')).not.toThrow();
    expect(() => detector.checkAndThrow('step', 'reddit')).toThrow(RateLimited);
  });

  it('clear() without arg clears all sites', () => {
    const detector = new RateLimitDetector();
    detector.onResponse(makeResponse({ status: 429, url: 'https://api.twitter.com' }), 'twitter');
    detector.onResponse(makeResponse({ status: 429, url: 'https://reddit.com' }), 'reddit');
    detector.clear();
    expect(() => detector.checkAndThrow('step', 'twitter')).not.toThrow();
    expect(() => detector.checkAndThrow('step', 'reddit')).not.toThrow();
  });

  it('ignores non-matching responses (does not store signal)', () => {
    const detector = new RateLimitDetector();
    detector.onResponse(makeResponse({ status: 200 }), 'twitter');
    detector.onResponse(makeResponse({ status: 404 }), 'twitter');
    expect(() => detector.checkAndThrow('step', 'twitter')).not.toThrow();
  });

  it('skips storing a second signal if one already exists for the site', () => {
    const detector = new RateLimitDetector();
    const first = makeResponse({ status: 429, url: 'https://api.twitter.com/first' });
    const second = makeResponse({ status: 429, url: 'https://api.twitter.com/second' });
    detector.onResponse(first, 'twitter');
    detector.onResponse(second, 'twitter');
    // Should have stored the first one, not overwritten
    let thrown: unknown;
    try {
      detector.checkAndThrow('step', 'twitter');
    } catch (e) {
      thrown = e;
    }
    const err = thrown as RateLimited;
    expect(err.context.url).toBe('https://api.twitter.com/first');
  });
});

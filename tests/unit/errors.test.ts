import { describe, it, expect } from 'vitest';
import {
  SiteUseError,
  BrowserDisconnected,
  BrowserNotRunning,
  SessionExpired,
  ElementNotFound,
  RateLimited,
  NavigationFailed,
  CdpThrottled,
} from '../../src/errors.js';

describe('SiteUseError', () => {
  it('is an instance of Error', () => {
    const err = new SiteUseError('test', 'something failed');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('something failed');
    expect(err.type).toBe('test');
  });

  it('carries error context', () => {
    const err = new SiteUseError('test', 'failed', {
      url: 'https://x.com/home',
      step: 'navigate',
    });
    expect(err.context.url).toBe('https://x.com/home');
    expect(err.context.step).toBe('navigate');
  });
});

describe('BrowserDisconnected', () => {
  it('has correct type', () => {
    const err = new BrowserDisconnected('Chrome crashed');
    expect(err.type).toBe('BrowserDisconnected');
    expect(err.message).toBe('Chrome crashed');
    expect(err).toBeInstanceOf(SiteUseError);
  });
});

describe('SessionExpired', () => {
  it('has correct type and carries URL context', () => {
    const err = new SessionExpired('Not logged in', {
      url: 'https://x.com/login',
    });
    expect(err.type).toBe('SessionExpired');
    expect(err.context.url).toBe('https://x.com/login');
    expect(err).toBeInstanceOf(SiteUseError);
  });
});

describe('ElementNotFound', () => {
  it('has correct type and carries step context', () => {
    const err = new ElementNotFound('Follow button not found', {
      url: 'https://x.com/someuser',
      step: 'followUser',
    });
    expect(err.type).toBe('ElementNotFound');
    expect(err.context.step).toBe('followUser');
    expect(err).toBeInstanceOf(SiteUseError);
  });
});

describe('RateLimited', () => {
  it('has type RateLimited and retryable false', () => {
    const err = new RateLimited('Too many requests');
    expect(err.type).toBe('RateLimited');
    expect(err.name).toBe('RateLimited');
    expect(err.context.retryable).toBe(false);
    expect(err.context.hint).toContain('Wait');
    expect(err instanceof SiteUseError).toBe(true);
  });
});

describe('NavigationFailed', () => {
  it('has type NavigationFailed and retryable based on status', () => {
    const transient = new NavigationFailed('Timeout', { url: 'https://x.com', retryable: true });
    expect(transient.type).toBe('NavigationFailed');
    expect(transient.context.retryable).toBe(true);

    const permanent = new NavigationFailed('Not found', { url: 'https://x.com/bad', retryable: false });
    expect(permanent.context.retryable).toBe(false);
  });
});

describe('existing errors get retryable and hint defaults', () => {
  it('SessionExpired defaults to retryable: false with hint', () => {
    const err = new SessionExpired('Login required');
    expect(err.context.retryable).toBe(false);
    expect(err.context.hint).toContain('log in');
  });

  it('ElementNotFound defaults to retryable: true with hint', () => {
    const err = new ElementNotFound('uid "5" not found');
    expect(err.context.retryable).toBe(true);
    expect(err.context.hint).toContain('screenshot');
  });

  it('BrowserDisconnected defaults to retryable: true with hint', () => {
    const err = new BrowserDisconnected('Chrome closed');
    expect(err.context.retryable).toBe(true);
    expect(err.context.hint).toContain('relaunch');
  });

  it('allows overriding retryable and hint via context', () => {
    const err = new SessionExpired('Custom', {
      retryable: true,
      hint: 'Custom hint',
    });
    expect(err.context.retryable).toBe(true);
    expect(err.context.hint).toBe('Custom hint');
  });
});

describe('BrowserNotRunning', () => {
  it('has correct name and type', () => {
    const err = new BrowserNotRunning('Chrome not running');
    expect(err.name).toBe('BrowserNotRunning');
    expect(err.type).toBe('BrowserNotRunning');
    expect(err.context.retryable).toBe(false);
    expect(err).toBeInstanceOf(SiteUseError);
  });
});

describe('CdpThrottled', () => {
  it('has correct type and defaults to retryable: true', () => {
    const err = new CdpThrottled('CDP input throttled during click', {
      step: 'click',
    });
    expect(err.type).toBe('CdpThrottled');
    expect(err.name).toBe('CdpThrottled');
    expect(err.context.retryable).toBe(true);
    expect(err.context.step).toBe('click');
    expect(err.context.hint).toBeDefined();
    expect(err.context.hint!.length).toBeGreaterThan(0);
    expect(err).toBeInstanceOf(SiteUseError);
    expect(err).toBeInstanceOf(CdpThrottled);
  });

  it('works for scroll step', () => {
    const err = new CdpThrottled('CDP input throttled during scroll', {
      step: 'scroll',
    });
    expect(err.context.step).toBe('scroll');
    expect(err.context.retryable).toBe(true);
  });
});

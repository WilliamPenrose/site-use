import { describe, it, expect } from 'vitest';
import {
  SiteUseError,
  BrowserDisconnected,
  SessionExpired,
  ElementNotFound,
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

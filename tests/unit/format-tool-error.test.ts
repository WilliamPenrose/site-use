import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/browser/browser.js', () => ({
  ensureBrowser: vi.fn(),
  isBrowserConnected: vi.fn().mockReturnValue(true),
}));

import { formatToolError, _setPrimitivesForTest } from '../../src/server.js';
import {
  BrowserDisconnected,
  SessionExpired,
  ElementNotFound,
} from '../../src/errors.js';

beforeEach(() => {
  _setPrimitivesForTest(null);
});

describe('formatToolError', () => {
  it('formats SiteUseError with type, message, context', () => {
    const err = new SessionExpired('Login required', { url: 'https://x.com' });
    const result = formatToolError(err);

    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('SessionExpired');
    expect(payload.message).toBe('Login required');
    expect(payload.context.url).toBe('https://x.com');
  });

  it('formats ElementNotFound', () => {
    const err = new ElementNotFound('uid "5" missing', { step: 'click' });
    const result = formatToolError(err);

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('ElementNotFound');
    expect(payload.context.step).toBe('click');
  });

  it('formats unknown Error as InternalError', () => {
    const result = formatToolError(new Error('something broke'));

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('InternalError');
    expect(payload.message).toBe('something broke');
  });

  it('formats non-Error thrown values as InternalError', () => {
    const result = formatToolError('string error');

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('InternalError');
    expect(payload.message).toBe('string error');
  });

  it('clears primitives singleton on BrowserDisconnected', () => {
    _setPrimitivesForTest({} as any);

    const err = new BrowserDisconnected('Chrome crashed');
    const result = formatToolError(err);

    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('BrowserDisconnected');
  });
});

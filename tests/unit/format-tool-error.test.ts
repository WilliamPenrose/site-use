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
  it('formats SiteUseError with type, message, context', async () => {
    const err = new SessionExpired('Login required', { url: 'https://x.com' });
    const result = await formatToolError(err);

    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('SessionExpired');
    expect(payload.message).toBe('Login required');
    expect(payload.context.url).toBe('https://x.com');
  });

  it('formats ElementNotFound', async () => {
    const err = new ElementNotFound('uid "5" missing', { step: 'click' });
    const result = await formatToolError(err);

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('ElementNotFound');
    expect(payload.context.step).toBe('click');
  });

  it('formats unknown Error as InternalError', async () => {
    const result = await formatToolError(new Error('something broke'));

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('InternalError');
    expect(payload.message).toBe('something broke');
  });

  it('formats non-Error thrown values as InternalError', async () => {
    const result = await formatToolError('string error');

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('InternalError');
    expect(payload.message).toBe('string error');
  });

  it('clears primitives singleton on BrowserDisconnected', async () => {
    _setPrimitivesForTest({} as any);

    const err = new BrowserDisconnected('Chrome crashed');
    const result = await formatToolError(err);

    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('BrowserDisconnected');
  });
});

describe('auto-screenshot on error', () => {
  it('captures screenshot and includes in context when primitives provided', async () => {
    const mockPrimitives = {
      screenshot: vi.fn().mockResolvedValue('fakescreenshot'),
    } as any;

    const err = new SessionExpired('Login required', { url: 'https://x.com' });
    const result = await formatToolError(err, mockPrimitives);

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.context.screenshotBase64).toBe('fakescreenshot');
    expect(payload.context.retryable).toBe(false);
    expect(payload.context.hint).toContain('log in');
  });

  it('skips screenshot for BrowserDisconnected', async () => {
    const mockPrimitives = {
      screenshot: vi.fn().mockResolvedValue('fakescreenshot'),
    } as any;

    const err = new BrowserDisconnected('Chrome crashed');
    const result = await formatToolError(err, mockPrimitives);

    expect(mockPrimitives.screenshot).not.toHaveBeenCalled();
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.context.screenshotBase64).toBeUndefined();
  });

  it('silently skips screenshot when capture fails', async () => {
    const mockPrimitives = {
      screenshot: vi.fn().mockRejectedValue(new Error('Page crashed')),
    } as any;

    const err = new ElementNotFound('uid not found');
    const result = await formatToolError(err, mockPrimitives);

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.context.screenshotBase64).toBeUndefined();
    expect(payload.type).toBe('ElementNotFound');
  });

  it('works without primitives parameter (backward compatible)', async () => {
    const err = new SessionExpired('Login required');
    const result = await formatToolError(err);

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('SessionExpired');
    expect(payload.context.screenshotBase64).toBeUndefined();
  });
});

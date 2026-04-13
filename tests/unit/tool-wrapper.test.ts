import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { wrapToolHandler } from '../../src/registry/tool-wrapper.js';
import type { SiteRuntime } from '../../src/runtime/types.js';
import { CircuitBreaker } from '../../src/runtime/circuit-breaker.js';
import { Mutex } from '../../src/mutex.js';
import { SessionExpired, RateLimited } from '../../src/errors.js';

function fakeRuntime(overrides: Partial<SiteRuntime> = {}): SiteRuntime {
  return {
    plugin: { apiVersion: 1, name: 'test', domains: ['test.com'] },
    primitives: {
      screenshot: vi.fn(async () => 'base64png'),
      navigate: vi.fn(),
      takeSnapshot: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      scroll: vi.fn(),
      scrollIntoView: vi.fn(),
      evaluate: vi.fn(),
      interceptRequest: vi.fn(),
      getRawPage: vi.fn(),
    } as never,
    page: { isClosed: () => false, close: vi.fn() } as never,
    mutex: new Mutex(),
    circuitBreaker: new CircuitBreaker(5),
    rateLimitDetector: { signals: new Map(), checkAndThrow: vi.fn(), clear: vi.fn() } as never,
    authState: { loggedIn: null, lastCheckedAt: null },
    ...overrides,
  };
}

describe('wrapToolHandler', () => {
  it('calls the handler and returns structured result', async () => {
    const handler = vi.fn(async () => ({ data: 'ok' }));
    const wrapped = wrapToolHandler({
      siteName: 'test',
      toolName: 'test_tool',
      handler,
      getRuntime: async () => fakeRuntime(),
    });

    const result = await wrapped({});
    expect(handler).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ data: 'ok' }),
    });
  });

  it('validates params with Zod schema when provided', async () => {
    const handler = vi.fn(async () => ({}));
    const wrapped = wrapToolHandler({
      siteName: 'test',
      toolName: 'test_tool',
      handler,
      getRuntime: async () => fakeRuntime(),
      paramsSchema: z.object({ count: z.number().min(1) }),
    });

    const result = await wrapped({ count: 0 });
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('wraps SiteUseError with site field and hint', async () => {
    const runtime = fakeRuntime();
    runtime.plugin.hints = { sessionExpired: 'Log in to test please' };
    const handler = vi.fn(async () => { throw new SessionExpired('not logged in'); });
    const wrapped = wrapToolHandler({
      siteName: 'test',
      toolName: 'test_tool',
      handler,
      getRuntime: async () => runtime,
    });

    const result = await wrapped({});
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.type).toBe('SessionExpired');
    expect(body.site).toBe('test');
    expect(body.context.hint).toBe('Log in to test please');
  });

  it('wraps unknown errors as PluginError', async () => {
    const handler = vi.fn(async () => { throw new TypeError('oops'); });
    const wrapped = wrapToolHandler({
      siteName: 'test',
      toolName: 'test_tool',
      handler,
      getRuntime: async () => fakeRuntime(),
    });

    const result = await wrapped({});
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.type).toBe('PluginError');
    expect(body.site).toBe('test');
  });

  it('records success on circuit breaker after successful call', async () => {
    const runtime = fakeRuntime();
    const spy = vi.spyOn(runtime.circuitBreaker, 'recordSuccess');
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler: async () => ({}),
      getRuntime: async () => runtime,
    });

    await wrapped({});
    expect(spy).toHaveBeenCalled();
  });

  it('records error on circuit breaker after failure', async () => {
    const runtime = fakeRuntime();
    const spy = vi.spyOn(runtime.circuitBreaker, 'recordError');
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler: async () => { throw new Error('fail'); },
      getRuntime: async () => runtime,
    });

    await wrapped({});
    expect(spy).toHaveBeenCalled();
  });

  it('returns circuit breaker error when tripped (open state, within cooldown)', async () => {
    const runtime = fakeRuntime();
    for (let i = 0; i < 5; i++) runtime.circuitBreaker.recordError();
    expect(runtime.circuitBreaker.state).toBe('open');

    const handler = vi.fn(async () => ({}));
    const wrapped = wrapToolHandler({
      siteName: 'test',
      toolName: 'test_tool',
      handler,
      getRuntime: async () => runtime,
    });

    const result = await wrapped({});
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.type).toBe('RateLimited');
  });

  it('captures auto-screenshot as image content block on SiteUseError', async () => {
    const runtime = fakeRuntime();
    const handler = async () => { throw new SessionExpired('test'); };
    const wrapped = wrapToolHandler({
      siteName: 'test',
      toolName: 'test_tool',
      handler,
      getRuntime: async () => runtime,
    });

    const result = await wrapped({});
    // Screenshot should be an image content block, not in JSON body
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('text');
    expect(result.content[1]).toEqual({
      type: 'image',
      data: 'base64png',
      mimeType: 'image/png',
    });
    // JSON body should NOT have screenshotBase64
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.context).not.toHaveProperty('screenshotBase64');
    // But should have trace
    expect(body.trace).toBeDefined();
    expect(body.trace.tool).toBe('test_tool');
  });

});

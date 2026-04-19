import { beforeEach, describe, expect, it, vi } from 'vitest';

const backendInstance = { navigate: vi.fn() };
const throttledInstance = { takeSnapshot: vi.fn() };
const guardedInstance = { click: vi.fn() };
const detectorInstance = { checkAndThrow: vi.fn() };

const PuppeteerBackend = vi.fn(() => backendInstance);
const createThrottledPrimitives = vi.fn(() => throttledInstance);
const createAuthGuardedPrimitives = vi.fn(() => guardedInstance);
const RateLimitDetector = vi.fn(() => detectorInstance);

vi.mock('../../src/primitives/puppeteer-backend.js', () => ({ PuppeteerBackend }));
vi.mock('../../src/primitives/throttle.js', () => ({ createThrottledPrimitives }));
vi.mock('../../src/primitives/auth-guard.js', () => ({ createAuthGuardedPrimitives }));
vi.mock('../../src/primitives/rate-limit-detect.js', () => ({ RateLimitDetector }));

let buildPrimitivesStack: typeof import('../../src/primitives/factory.js').buildPrimitivesStack;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ buildPrimitivesStack } = await import('../../src/primitives/factory.js'));
});

describe('buildPrimitivesStack', () => {
  it('builds detector, backend, throttle, and auth layers from site configs', () => {
    const browser = { newPage: vi.fn() } as never;
    const sites = [
      {
        name: 'twitter',
        domains: ['x.com', 'twitter.com'],
        detect: vi.fn(),
        authCheck: vi.fn().mockResolvedValue(true),
      },
    ];

    const result = buildPrimitivesStack(browser, sites);

    expect(RateLimitDetector).toHaveBeenCalledWith({ twitter: sites[0].detect });
    expect(PuppeteerBackend).toHaveBeenCalledWith(browser, {
      twitter: ['x.com', 'twitter.com'],
    }, detectorInstance);
    expect(createThrottledPrimitives).toHaveBeenCalledWith(backendInstance);
    expect(result).toEqual({
      guarded: guardedInstance,
      throttled: throttledInstance,
    });
  });

  it('adapts legacy boolean auth checks to structured auth results', async () => {
    const browser = { newPage: vi.fn() } as never;
    const authCheck = vi.fn().mockResolvedValue(true);

    buildPrimitivesStack(browser, [{
      name: 'twitter',
      domains: ['x.com', 'twitter.com'],
      detect: vi.fn(),
      authCheck,
    }]);

    const configs = vi.mocked(createAuthGuardedPrimitives).mock.calls[0][1];
    await expect(configs[0].check(throttledInstance as never)).resolves.toEqual({
      loggedIn: true,
    });
    expect(authCheck).toHaveBeenCalledWith(throttledInstance);
  });
});

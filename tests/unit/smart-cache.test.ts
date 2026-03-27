import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { withSmartCache, stripFrameworkFlags } from '../../src/cli/smart-cache.js';

vi.mock('../../src/cli/freshness.js', () => ({
  checkFreshness: vi.fn(),
}));

vi.mock('../../src/fetch-timestamps.js', () => ({
  setLastFetchTime: vi.fn(),
}));

import { checkFreshness } from '../../src/cli/freshness.js';
import { setLastFetchTime } from '../../src/fetch-timestamps.js';

const mockCheckFreshness = vi.mocked(checkFreshness);
const mockSetLastFetchTime = vi.mocked(setLastFetchTime);

const baseOpts = {
  siteName: 'twitter',
  variant: 'for_you',
  maxAge: 120,
  forceLocal: false,
  forceFetch: false,
  dataDir: '/tmp/data',
};

function makeHandlers<T>(opts: {
  localResult?: T;
  remoteResult?: T;
  hasLocal?: boolean;
}) {
  return {
    localQuery: vi.fn().mockResolvedValue(opts.localResult ?? []),
    remoteFetch: vi.fn().mockResolvedValue(opts.remoteResult ?? []),
    hasLocalData: vi.fn().mockResolvedValue(opts.hasLocal ?? true),
  };
}

describe('withSmartCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('forceLocal mode', () => {
    it('calls localQuery when data exists', async () => {
      mockCheckFreshness.mockReturnValue({ shouldFetch: false, reason: 'fresh', ageMinutes: 10 });
      const handlers = makeHandlers({ localResult: ['tweet1'], hasLocal: true });

      const res = await withSmartCache({ ...baseOpts, forceLocal: true }, handlers);

      expect(handlers.hasLocalData).toHaveBeenCalled();
      expect(handlers.localQuery).toHaveBeenCalled();
      expect(handlers.remoteFetch).not.toHaveBeenCalled();
      expect(res.source).toBe('local');
      expect(res.result).toEqual(['tweet1']);
      expect(res.ageMinutes).toBe(10);
    });

    it('throws when no local data exists', async () => {
      const handlers = makeHandlers({ hasLocal: false });

      await expect(
        withSmartCache({ ...baseOpts, forceLocal: true }, handlers),
      ).rejects.toThrow('No local data found for "twitter"');

      expect(handlers.localQuery).not.toHaveBeenCalled();
      expect(handlers.remoteFetch).not.toHaveBeenCalled();
    });
  });

  describe('forceFetch mode', () => {
    it('calls remoteFetch and updates timestamp', async () => {
      const handlers = makeHandlers({ remoteResult: ['tweet2'] });

      const res = await withSmartCache({ ...baseOpts, forceFetch: true }, handlers);

      expect(handlers.remoteFetch).toHaveBeenCalled();
      expect(handlers.localQuery).not.toHaveBeenCalled();
      expect(mockSetLastFetchTime).toHaveBeenCalledWith(
        path.join('/tmp/data', 'fetch-timestamps.json'),
        'twitter',
        'for_you',
      );
      expect(res.source).toBe('remote');
      expect(res.result).toEqual(['tweet2']);
      expect(res.ageMinutes).toBeUndefined();
    });
  });

  describe('auto mode', () => {
    it('triggers remoteFetch when freshness returns no_data', async () => {
      mockCheckFreshness.mockReturnValue({ shouldFetch: true, reason: 'no_data' });
      const handlers = makeHandlers({ remoteResult: ['tweet3'], hasLocal: true });

      const res = await withSmartCache(baseOpts, handlers);

      expect(handlers.remoteFetch).toHaveBeenCalled();
      expect(handlers.localQuery).not.toHaveBeenCalled();
      expect(mockSetLastFetchTime).toHaveBeenCalled();
      expect(res.source).toBe('remote');
    });

    it('triggers remoteFetch when data is stale', async () => {
      mockCheckFreshness.mockReturnValue({ shouldFetch: true, reason: 'stale', ageMinutes: 180 });
      const handlers = makeHandlers({ remoteResult: ['tweet4'], hasLocal: true });

      const res = await withSmartCache(baseOpts, handlers);

      expect(handlers.remoteFetch).toHaveBeenCalled();
      expect(res.source).toBe('remote');
      expect(mockSetLastFetchTime).toHaveBeenCalled();
    });

    it('triggers remoteFetch when fresh but no local data', async () => {
      mockCheckFreshness.mockReturnValue({ shouldFetch: false, reason: 'fresh', ageMinutes: 5 });
      const handlers = makeHandlers({ remoteResult: ['tweet5'], hasLocal: false });

      const res = await withSmartCache(baseOpts, handlers);

      expect(handlers.hasLocalData).toHaveBeenCalled();
      expect(handlers.remoteFetch).toHaveBeenCalled();
      expect(handlers.localQuery).not.toHaveBeenCalled();
      expect(res.source).toBe('remote');
    });

    it('calls localQuery and returns ageMinutes when fresh with local data', async () => {
      mockCheckFreshness.mockReturnValue({ shouldFetch: false, reason: 'fresh', ageMinutes: 15 });
      const handlers = makeHandlers({ localResult: ['tweet6'], hasLocal: true });

      const res = await withSmartCache(baseOpts, handlers);

      expect(handlers.localQuery).toHaveBeenCalled();
      expect(handlers.remoteFetch).not.toHaveBeenCalled();
      expect(mockSetLastFetchTime).not.toHaveBeenCalled();
      expect(res.source).toBe('local');
      expect(res.result).toEqual(['tweet6']);
      expect(res.ageMinutes).toBe(15);
    });

    it('remoteFetch always updates fetch timestamp', async () => {
      mockCheckFreshness.mockReturnValue({ shouldFetch: true, reason: 'stale', ageMinutes: 200 });
      const handlers = makeHandlers({ hasLocal: true });

      await withSmartCache(baseOpts, handlers);

      expect(mockSetLastFetchTime).toHaveBeenCalledOnce();
    });
  });
});

describe('stripFrameworkFlags', () => {
  it('strips --local flag', () => {
    const { cacheFlags, pluginArgs } = stripFrameworkFlags(['--local', '--tab', 'for_you'], 120);
    expect(cacheFlags.forceLocal).toBe(true);
    expect(cacheFlags.forceFetch).toBe(false);
    expect(pluginArgs).toEqual(['--tab', 'for_you']);
  });

  it('strips --fetch flag', () => {
    const { cacheFlags, pluginArgs } = stripFrameworkFlags(['--fetch', '--limit', '10'], 120);
    expect(cacheFlags.forceFetch).toBe(true);
    expect(cacheFlags.forceLocal).toBe(false);
    expect(pluginArgs).toEqual(['--limit', '10']);
  });

  it('strips --max-age with its value', () => {
    const { cacheFlags, pluginArgs } = stripFrameworkFlags(['--max-age', '60', '--limit', '5'], 120);
    expect(cacheFlags.maxAge).toBe(60);
    expect(pluginArgs).toEqual(['--limit', '5']);
  });

  it('uses defaultMaxAge when --max-age not specified', () => {
    const { cacheFlags } = stripFrameworkFlags(['--limit', '5'], 90);
    expect(cacheFlags.maxAge).toBe(90);
  });

  it('throws when --local and --fetch are both specified', () => {
    expect(() => stripFrameworkFlags(['--local', '--fetch'], 120)).toThrow(
      '--fetch and --local are mutually exclusive.',
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wrapToolHandler } from '../../src/registry/tool-wrapper.js';
import { z } from 'zod';
import type { SiteRuntime } from '../../src/runtime/types.js';
import { Mutex } from '../../src/mutex.js';

function createMockRuntime(): SiteRuntime {
  return {
    primitives: {} as any,
    mutex: new Mutex(),
    plugin: { apiVersion: 1, name: 'test', domains: [] },
    circuitBreaker: {
      isTripped: false,
      streak: 0,
      recordSuccess: vi.fn(),
      recordError: vi.fn(),
    },
  } as any;
}

describe('action workflow pipeline', () => {
  it('action workflow with autoIngest passed does not call it', async () => {
    const mockRuntime = createMockRuntime();
    const toIngestItems = vi.fn().mockReturnValue([]);
    const handler = vi.fn().mockResolvedValue({ action: 'follow', target: 'user1', success: true });

    // Pass autoIngest to verify it is NOT called for action results (no .items)
    const wrapped = wrapToolHandler({
      siteName: 'test',
      toolName: 'test_follow',
      getRuntime: async () => mockRuntime,
      handler,
      autoIngest: { storeAdapter: { toIngestItems }, siteName: 'test' },
    });

    const result = await wrapped({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.action).toBe('follow');
    // autoIngest should not be called — action result has no .items
    expect(toIngestItems).not.toHaveBeenCalled();
  });

  it('action workflow with dailyLimit throws when limit exceeded', async () => {
    // vi.resetModules ensures dynamic import() inside tool-wrapper gets our mocks
    vi.resetModules();

    vi.doMock('../../src/storage/action-log.js', () => ({
      getDailyActionCount: vi.fn().mockReturnValue(50),
      logAction: vi.fn(),
    }));
    vi.doMock('../../src/config.js', () => ({
      getConfig: () => ({ dataDir: '/tmp/test' }),
      getKnowledgeDbPath: () => '/tmp/test/knowledge.db',
    }));
    vi.doMock('../../src/storage/schema.js', () => ({
      initializeDatabase: () => ({
        close: vi.fn(),
      }),
    }));

    // Re-import after mocks are set so dynamic import() picks them up
    const { wrapToolHandler: wrappedFn } = await import('../../src/registry/tool-wrapper.js');

    const mockRuntime = createMockRuntime();
    const handler = vi.fn();

    const wrapped = wrappedFn({
      siteName: 'test',
      toolName: 'test_follow',
      getRuntime: async () => mockRuntime,
      handler,
      actionOpts: {
        dailyLimit: 50,
        dailyLimitKey: 'follow,unfollow',
      },
    });

    const result = await wrapped({});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.type).toBe('DailyLimitExceeded');
    expect(handler).not.toHaveBeenCalled();

    vi.doUnmock('../../src/storage/action-log.js');
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('../../src/storage/schema.js');
  });

  it('idempotent noop (previousState === resultState) does not call logAction', async () => {
    vi.resetModules();

    const mockLogAction = vi.fn();
    vi.doMock('../../src/storage/action-log.js', () => ({
      getDailyActionCount: vi.fn().mockReturnValue(0),
      logAction: mockLogAction,
    }));
    vi.doMock('../../src/config.js', () => ({
      getConfig: () => ({ dataDir: '/tmp/test' }),
      getKnowledgeDbPath: () => '/tmp/test/knowledge.db',
    }));
    vi.doMock('../../src/storage/schema.js', () => ({
      initializeDatabase: () => ({
        close: vi.fn(),
      }),
    }));

    const { wrapToolHandler: wrappedFn } = await import('../../src/registry/tool-wrapper.js');

    const mockRuntime = createMockRuntime();
    // Handler returns noop: previousState === resultState
    const handler = vi.fn().mockResolvedValue({
      action: 'follow',
      handle: 'user1',
      success: true,
      previousState: 'following',
      resultState: 'following',
    });

    const wrapped = wrappedFn({
      siteName: 'test',
      toolName: 'test_follow',
      getRuntime: async () => mockRuntime,
      handler,
      actionOpts: { dailyLimit: 50 },
    });

    const result = await wrapped({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.previousState).toBe('following');
    expect(parsed.resultState).toBe('following');
    // logAction should NOT be called for noop
    expect(mockLogAction).not.toHaveBeenCalled();

    vi.doUnmock('../../src/storage/action-log.js');
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('../../src/storage/schema.js');
  });

  it('state-changing action calls logAction', async () => {
    vi.resetModules();

    const mockLogAction = vi.fn();
    vi.doMock('../../src/storage/action-log.js', () => ({
      getDailyActionCount: vi.fn().mockReturnValue(0),
      logAction: mockLogAction,
    }));
    vi.doMock('../../src/config.js', () => ({
      getConfig: () => ({ dataDir: '/tmp/test' }),
      getKnowledgeDbPath: () => '/tmp/test/knowledge.db',
    }));
    vi.doMock('../../src/storage/schema.js', () => ({
      initializeDatabase: () => ({
        close: vi.fn(),
      }),
    }));

    const { wrapToolHandler: wrappedFn } = await import('../../src/registry/tool-wrapper.js');

    const mockRuntime = createMockRuntime();
    const handler = vi.fn().mockResolvedValue({
      action: 'follow',
      handle: 'user1',
      success: true,
      previousState: 'not_following',
      resultState: 'following',
    });

    const wrapped = wrappedFn({
      siteName: 'test',
      toolName: 'test_follow',
      getRuntime: async () => mockRuntime,
      handler,
      actionOpts: { dailyLimit: 50 },
    });

    const result = await wrapped({});
    expect(result.isError).toBeUndefined();
    // logAction SHOULD be called for state-changing action
    expect(mockLogAction).toHaveBeenCalledOnce();

    vi.doUnmock('../../src/storage/action-log.js');
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('../../src/storage/schema.js');
  });
});

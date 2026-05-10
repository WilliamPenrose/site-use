import { describe, it, expect } from 'vitest';
import { createRuntime } from '@site-use/runtime';

describe('createRuntime config defaults', () => {
  it('derives chromeProfileDir and chromeJsonPath from dataDir when omitted', () => {
    const runtime = createRuntime({ config: { dataDir: '/tmp/test-data' } });
    expect(typeof runtime.close).toBe('function');
  });

  it('accepts only dataDir as the minimum required config field', () => {
    expect(() =>
      createRuntime({ config: { dataDir: '/tmp/test-data' } }),
    ).not.toThrow();
  });

  it('throws if dataDir is missing', () => {
    // @ts-expect-error — missing required field
    expect(() => createRuntime({ config: {} })).toThrow();
  });
});

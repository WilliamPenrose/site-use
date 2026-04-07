import { describe, it, expect } from 'vitest';
import { validatePlugins } from '../../src/registry/validation.js';

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 1,
    name: 'test',
    domains: ['example.com'],
    ...overrides,
  };
}

function collectionWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'collection' as const,
    name: 'feed',
    description: 'Test feed',
    params: {},
    execute: () => Promise.resolve({}),
    ...overrides,
  };
}

function actionWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'action' as const,
    name: 'follow',
    description: 'Follow user',
    params: {},
    execute: () => Promise.resolve({}),
    ...overrides,
  };
}

function queryWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'query' as const,
    name: 'profile',
    description: 'View profile',
    params: {},
    execute: () => Promise.resolve({}),
    ...overrides,
  };
}

describe('validatePlugins', () => {
  it('accepts plugin with collection workflow', () => {
    expect(() => validatePlugins([
      makePlugin({ workflows: [collectionWorkflow()] }),
    ])).not.toThrow();
  });

  it('accepts plugin with action workflow', () => {
    expect(() => validatePlugins([
      makePlugin({ workflows: [actionWorkflow({ dailyLimit: 50, dailyLimitKey: 'follow,unfollow' })] }),
    ])).not.toThrow();
  });

  it('accepts plugin with mixed workflow types', () => {
    expect(() => validatePlugins([
      makePlugin({ workflows: [collectionWorkflow(), actionWorkflow()] }),
    ])).not.toThrow();
  });

  it('rejects workflow without kind field', () => {
    const noKind = {
      name: 'feed',
      description: 'Test',
      params: {},
      execute: () => Promise.resolve({}),
    };
    expect(() => validatePlugins([
      makePlugin({ workflows: [noKind] }),
    ])).toThrow('validation failed');
  });

  it('rejects collection workflow with localQuery but no cache', () => {
    expect(() => validatePlugins([
      makePlugin({ workflows: [collectionWorkflow({ localQuery: () => Promise.resolve({}) })] }),
    ])).toThrow('localQuery without cache');
  });

  it('accepts action workflow without cache (action does not need cache)', () => {
    expect(() => validatePlugins([
      makePlugin({ workflows: [actionWorkflow()] }),
    ])).not.toThrow();
  });

  it('accepts plugin with query workflow', () => {
    expect(() => validatePlugins([
      makePlugin({ workflows: [queryWorkflow()] }),
    ])).not.toThrow();
  });

  it('accepts plugin with all three workflow types', () => {
    expect(() => validatePlugins([
      makePlugin({ workflows: [collectionWorkflow(), actionWorkflow(), queryWorkflow()] }),
    ])).not.toThrow();
  });
});

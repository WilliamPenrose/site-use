import { describe, it, expect } from 'vitest';
import {
  createMockPrimitives,
  buildSnapshot,
  createMockStore,
  assertIngestItems,
} from '../../src/testing/index.js';

describe('createMockPrimitives', () => {
  it('returns a Primitives object with all methods as spies', () => {
    const p = createMockPrimitives();
    expect(typeof p.navigate).toBe('function');
    expect(typeof p.takeSnapshot).toBe('function');
    expect(typeof p.click).toBe('function');
    expect(typeof p.type).toBe('function');
    expect(typeof p.scroll).toBe('function');
    expect(typeof p.scrollIntoView).toBe('function');
    expect(typeof p.evaluate).toBe('function');
    expect(typeof p.screenshot).toBe('function');
    expect(typeof p.interceptRequest).toBe('function');
    expect(typeof p.getRawPage).toBe('function');
  });

  it('allows overriding specific methods', async () => {
    const p = createMockPrimitives({
      evaluate: async () => 'https://x.com/home',
    });
    await expect(p.evaluate('window.location.href')).resolves.toBe('https://x.com/home');
  });
});

describe('buildSnapshot', () => {
  it('returns a Snapshot with uid-keyed nodes', () => {
    const snap = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '2', role: 'button', name: 'Tweet' },
    ]);
    expect(snap.idToNode.get('1')).toEqual({ uid: '1', role: 'link', name: 'Home' });
    expect(snap.idToNode.get('2')).toEqual({ uid: '2', role: 'button', name: 'Tweet' });
  });

  it('returns empty snapshot for empty input', () => {
    const snap = buildSnapshot([]);
    expect(snap.idToNode.size).toBe(0);
  });
});

describe('createMockStore', () => {
  it('returns a store with spyable methods', () => {
    const store = createMockStore();
    expect(typeof store.ingest).toBe('function');
    expect(typeof store.search).toBe('function');
    expect(typeof store.statsBySite).toBe('function');
  });
});

describe('assertIngestItems', () => {
  it('passes for valid IngestItem array', () => {
    const items = [{
      site: 'test',
      id: '1',
      text: 'hello',
      author: 'alice',
      timestamp: '2026-01-01T00:00:00Z',
      url: 'https://test.com/1',
      rawJson: '{}',
    }];
    expect(() => assertIngestItems(items)).not.toThrow();
  });

  it('throws for invalid IngestItem (missing id)', () => {
    const items = [{ site: 'test', text: 'hello' }];
    expect(() => assertIngestItems(items as never)).toThrow();
  });
});

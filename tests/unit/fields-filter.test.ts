import { describe, it, expect } from 'vitest';
import { applyFieldsFilter } from '../../src/storage/fields.js';

describe('applyFieldsFilter', () => {
  const makeItem = (overrides = {}) => ({
    id: '1',
    site: 'twitter',
    text: 'hello world',
    author: 'alice',
    timestamp: '2026-03-29T10:00:00Z',
    url: 'https://x.com/alice/status/1',
    links: ['https://example.com'],
    mentions: ['bob'],
    media: [{ type: 'photo', url: 'https://img.com/1.jpg', width: 100, height: 100 }],
    siteMeta: { likes: 42, retweets: 5, following: true },
    ...overrides,
  });

  it('returns all fields when fields is undefined', () => {
    const items = [makeItem()];
    const result = applyFieldsFilter(items, undefined);
    expect(result[0].text).toBe('hello world');
    expect(result[0].author).toBe('alice');
    expect(result[0].siteMeta).toBeDefined();
  });

  it('returns all fields when fields is empty array', () => {
    const items = [makeItem()];
    const result = applyFieldsFilter(items, []);
    expect(result[0].text).toBe('hello world');
  });

  it('keeps only requested fields', () => {
    const items = [makeItem()];
    const result = applyFieldsFilter(items, ['author', 'url']);
    expect(result[0].author).toBe('alice');
    expect(result[0].url).toContain('x.com');
    expect(result[0].text).toBeUndefined();
    expect(result[0].links).toBeUndefined();
    expect(result[0].mentions).toBeUndefined();
    expect(result[0].media).toBeUndefined();
  });

  it('strips siteMeta when text is not requested', () => {
    const items = [makeItem()];
    const result = applyFieldsFilter(items, ['author']);
    expect(result[0].siteMeta).toBeUndefined();
  });

  it('preserves siteMeta when text is requested', () => {
    const items = [makeItem()];
    const result = applyFieldsFilter(items, ['text']);
    expect(result[0].siteMeta).toBeDefined();
    expect(result[0].text).toBe('hello world');
  });

  it('preserves following=false in siteMeta for author-only request', () => {
    const items = [makeItem({ siteMeta: { likes: 10, following: false } })];
    const result = applyFieldsFilter(items, ['author']);
    expect(result[0].siteMeta).toEqual({ following: false });
  });

  it('filters out empty items after field removal', () => {
    const items = [{ id: '1', site: 'twitter' }];
    const result = applyFieldsFilter(items, ['text']);
    expect(result).toHaveLength(0);
  });
});

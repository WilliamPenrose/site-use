import { describe, it, expect } from 'vitest';
import { resolveItem, type DisplaySchema } from '../../src/display/resolve.js';

const schema: DisplaySchema = {
  author:     { path: 'author.handle' },
  authorName: { path: 'author.name' },
  following:  { path: 'author.following' },
  authorTag:  { path: 'author.following', format: (v) => v === false ? '[not following]' : undefined },
  text:       { path: 'text' },
  likes:      { path: 'metrics.likes' },
  isRetweet:  { path: 'isRetweet' },
  media:      { path: 'media' },
  links:      { path: 'links' },
};

const doc = {
  author: { handle: 'karpathy', name: 'Andrej Karpathy', following: false },
  text: 'Hello world',
  metrics: { likes: 1500, retweets: 83 },
  isRetweet: false,
  media: [{ type: 'photo', url: 'https://img.com/a.jpg', width: 1200, height: 800 }],
  links: ['https://arxiv.org/abs/2401.00001'],
};

describe('resolveItem', () => {
  it('resolves nested paths', () => {
    const result = resolveItem(doc, schema, ['author', 'likes']);
    expect(result.author).toBe('karpathy');
    expect(result.likes).toBe(1500);
  });

  it('applies format function', () => {
    const result = resolveItem(doc, schema, ['authorTag']);
    expect(result.authorTag).toBe('[not following]');
  });

  it('returns undefined for format that returns undefined', () => {
    const followingDoc = { ...doc, author: { ...doc.author, following: true } };
    const result = resolveItem(followingDoc, schema, ['authorTag']);
    expect(result.authorTag).toBeUndefined();
  });

  it('skips fields not in schema', () => {
    const result = resolveItem(doc, schema, ['nonexistent']);
    expect(result).toEqual({});
  });

  it('resolves array values (media, links)', () => {
    const result = resolveItem(doc, schema, ['media', 'links']);
    expect(result.media).toHaveLength(1);
    expect(result.links).toEqual(['https://arxiv.org/abs/2401.00001']);
  });

  it('resolves boolean values', () => {
    const result = resolveItem(doc, schema, ['isRetweet', 'following']);
    expect(result.isRetweet).toBe(false);
    expect(result.following).toBe(false);
  });
});

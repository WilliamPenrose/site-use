import { describe, it, expect } from 'vitest';
import { formatTweetText } from '../../src/sites/twitter/format.js';
import type { SearchResultItem } from '../../src/storage/types.js';

describe('formatTweetText', () => {
  it('formats original tweet', () => {
    const item: SearchResultItem = {
      id: '123', site: 'twitter',
      author: 'karpathy',
      text: 'Training a new model today',
      timestamp: '2026-03-20T14:09:00.000Z',
      url: 'https://x.com/karpathy/status/123',
      siteMeta: {
        likes: 1500, retweets: 83, replies: 42, views: 120000,
        surfaceReason: 'original',
      },
    };
    const output = formatTweetText(item);
    expect(output).toContain('@karpathy');
    expect(output).toContain('2026-03-20');
    expect(output).toContain('Training a new model today');
    expect(output).toContain('1.5k');
    expect(output).toContain('https://x.com/karpathy/status/123');
    expect(output).not.toContain('retweeted by');
    expect(output).not.toContain('reply to');
  });

  it('formats retweet with surfacedBy', () => {
    const item: SearchResultItem = {
      id: '456', site: 'twitter',
      author: 'pushmeet',
      text: 'Our AlphaProof paper is in Nature',
      timestamp: '2026-03-20T14:09:00.000Z',
      url: 'https://x.com/pushmeet/status/456',
      siteMeta: {
        likes: 663, retweets: 89, replies: 17, views: 66000,
        surfaceReason: 'retweet',
        surfacedBy: 'GoogleDeepMind',
      },
    };
    const output = formatTweetText(item);
    expect(output).toContain('@pushmeet');
    expect(output).toContain('retweeted by GoogleDeepMind');
    expect(output).toContain('Our AlphaProof paper is in Nature');
  });

  it('formats quote tweet with quoted content', () => {
    const item: SearchResultItem = {
      id: '789', site: 'twitter',
      author: 'peter',
      text: 'This is exactly the direction we need',
      timestamp: '2026-03-21T09:30:00.000Z',
      url: 'https://x.com/peter/status/789',
      siteMeta: {
        likes: 45, retweets: 12, replies: 3,
        surfaceReason: 'quote',
        quotedTweet: {
          author: { handle: 'dimillian', name: 'Dimillian' },
          text: 'SwiftUI performance tips that actually work',
          metrics: { likes: 1200, retweets: 230 },
        },
      },
    };
    const output = formatTweetText(item);
    expect(output).toContain('@peter');
    expect(output).toContain('This is exactly the direction we need');
    expect(output).toContain('@dimillian');
    expect(output).toContain('SwiftUI performance tips');
  });

  it('formats reply with inReplyTo', () => {
    const item: SearchResultItem = {
      id: '555', site: 'twitter',
      author: 'peter',
      text: 'Totally agree, structured concurrency is the way to go',
      timestamp: '2026-03-21T10:15:00.000Z',
      url: 'https://x.com/peter/status/555',
      siteMeta: {
        likes: 8, retweets: 1, replies: 0,
        surfaceReason: 'reply',
        inReplyTo: { handle: 'dimillian', tweetId: '444' },
      },
    };
    const output = formatTweetText(item);
    expect(output).toContain('@peter');
    expect(output).toContain('reply to @dimillian');
    expect(output).toContain('Totally agree');
  });

  it('displays local time with timezone annotation', () => {
    const item: SearchResultItem = {
      id: '100', site: 'twitter',
      author: 'test',
      text: 'timezone check',
      timestamp: '2026-03-20T14:09:00.000Z',
      url: 'https://x.com/test/status/100',
      siteMeta: { likes: 0, surfaceReason: 'original' },
    };
    const output = formatTweetText(item);
    // Must contain timezone annotation like (UTC+8) or (UTC-5)
    expect(output).toMatch(/\(UTC[+-]\d{1,2}(:\d{2})?\)/);
    // Must use local time, not UTC — verify by computing expected local values
    const d = new Date('2026-03-20T14:09:00.000Z');
    const localHours = String(d.getHours()).padStart(2, '0');
    const localMinutes = String(d.getMinutes()).padStart(2, '0');
    expect(output).toContain(`${localHours}:${localMinutes}`);
  });

  it('formats large view counts with k suffix', () => {
    const item: SearchResultItem = {
      id: '1', site: 'twitter',
      author: 'a', text: 'hi', timestamp: '2026-01-01T00:00:00Z',
      url: 'https://x.com/a/status/1',
      siteMeta: { likes: 0, views: 66004, surfaceReason: 'original' },
    };
    const output = formatTweetText(item);
    expect(output).toContain('66k');
  });
});

import { describe, it, expect } from 'vitest';
import {
  parseTweet,
  buildTimelineMeta,
  parseGraphQLTimeline,
} from '../../src/sites/twitter/extractors.js';
import type { RawTweetData } from '../../src/sites/twitter/types.js';

const RAW_TWEET: RawTweetData = {
  authorHandle: 'karpathy',
  authorName: 'Andrej Karpathy',
  text: 'Training a new model today',
  timestamp: '2026-03-18T23:49:31.000Z',
  url: 'https://x.com/karpathy/status/2034416944074613174',
  likes: 1500,
  retweets: 83,
  replies: 42,
  isRetweet: false,
  isAd: false,
};

describe('parseTweet', () => {
  it('converts RawTweetData to Tweet', () => {
    const tweet = parseTweet(RAW_TWEET);
    expect(tweet.id).toBe('2034416944074613174');
    expect(tweet.author.handle).toBe('karpathy');
    expect(tweet.author.name).toBe('Andrej Karpathy');
    expect(tweet.text).toBe('Training a new model today');
    expect(tweet.timestamp).toBe('2026-03-18T23:49:31.000Z');
    expect(tweet.url).toBe('https://x.com/karpathy/status/2034416944074613174');
    expect(tweet.metrics).toEqual({ likes: 1500, retweets: 83, replies: 42 });
    expect(tweet.isRetweet).toBe(false);
    expect(tweet.isAd).toBe(false);
  });

  it('extracts tweet ID from URL path', () => {
    const tweet = parseTweet({
      ...RAW_TWEET,
      url: 'https://x.com/someone/status/9999',
    });
    expect(tweet.id).toBe('9999');
  });

  it('uses full URL as id when path does not contain status ID', () => {
    const tweet = parseTweet({
      ...RAW_TWEET,
      url: 'https://x.com/explore',
    });
    expect(tweet.id).toBe('https://x.com/explore');
  });
});

describe('buildTimelineMeta', () => {
  it('computes meta from tweet array', () => {
    const tweets = [
      parseTweet(RAW_TWEET),
      parseTweet({
        ...RAW_TWEET,
        authorHandle: 'steipete',
        authorName: 'Peter Steinberger',
        timestamp: '2026-03-18T20:00:00.000Z',
        url: 'https://x.com/steipete/status/111',
      }),
    ];

    const meta = buildTimelineMeta(tweets);
    expect(meta.tweetCount).toBe(2);
    expect(meta.coveredUsers).toContain('karpathy');
    expect(meta.coveredUsers).toContain('steipete');
    expect(meta.coveredUserCount).toBe(2);
    expect(meta.timeRange.from).toBe('2026-03-18T20:00:00.000Z');
    expect(meta.timeRange.to).toBe('2026-03-18T23:49:31.000Z');
  });

  it('handles empty tweet array', () => {
    const meta = buildTimelineMeta([]);
    expect(meta.tweetCount).toBe(0);
    expect(meta.coveredUsers).toEqual([]);
    expect(meta.coveredUserCount).toBe(0);
    expect(meta.timeRange.from).toBe('');
    expect(meta.timeRange.to).toBe('');
  });

  it('deduplicates covered users', () => {
    const tweets = [
      parseTweet(RAW_TWEET),
      parseTweet({ ...RAW_TWEET, url: 'https://x.com/karpathy/status/222' }),
    ];
    const meta = buildTimelineMeta(tweets);
    expect(meta.coveredUserCount).toBe(1);
    expect(meta.coveredUsers).toEqual(['karpathy']);
  });
});

describe('parseGraphQLTimeline', () => {
  it('parses a timeline response with one tweet', () => {
    const body = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{
              entries: [{
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: 'Tweet',
                        rest_id: '123456',
                        legacy: {
                          id_str: '123456',
                          full_text: 'Hello world',
                          created_at: 'Mon Mar 18 23:49:31 +0000 2026',
                          favorite_count: 10,
                          retweet_count: 2,
                          reply_count: 1,
                          retweeted_status_result: null,
                        },
                        core: {
                          user_results: {
                            result: {
                              legacy: {
                                screen_name: 'testuser',
                                name: 'Test User',
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              }],
            }],
          },
        },
      },
    });

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].authorHandle).toBe('testuser');
    expect(results[0].text).toBe('Hello world');
    expect(results[0].likes).toBe(10);
    expect(results[0].isAd).toBe(false);
  });

  it('skips promoted tweets', () => {
    const body = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{
              entries: [{
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: {
                    promotedMetadata: { advertiser_results: {} },
                    tweet_results: {
                      result: {
                        __typename: 'Tweet',
                        rest_id: '789',
                        legacy: { id_str: '789', full_text: 'Ad', created_at: '', favorite_count: 0, retweet_count: 0, reply_count: 0 },
                        core: { user_results: { result: { legacy: { screen_name: 'ad', name: 'Ad' } } } },
                      },
                    },
                  },
                },
              }],
            }],
          },
        },
      },
    });

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(0);
  });

  it('handles TweetWithVisibilityResults wrapper', () => {
    const body = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{
              entries: [{
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: 'TweetWithVisibilityResults',
                        tweet: {
                          rest_id: '555',
                          legacy: { id_str: '555', full_text: 'Visible', created_at: '', favorite_count: 5, retweet_count: 0, reply_count: 0 },
                          core: { user_results: { result: { legacy: { screen_name: 'vis', name: 'Visible User' } } } },
                        },
                      },
                    },
                  },
                },
              }],
            }],
          },
        },
      },
    });

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].authorHandle).toBe('vis');
  });

  it('decodes HTML entities in tweet text', () => {
    const body = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{
              entries: [{
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: 'Tweet',
                        rest_id: '888',
                        legacy: {
                          id_str: '888',
                          full_text: 'R&amp;D is &lt;important&gt; &amp; so is &#39;testing&#39;',
                          created_at: '',
                          favorite_count: 0,
                          retweet_count: 0,
                          reply_count: 0,
                        },
                        core: { user_results: { result: { legacy: { screen_name: 'dev', name: 'Dev' } } } },
                      },
                    },
                  },
                },
              }],
            }],
          },
        },
      },
    });

    const results = parseGraphQLTimeline(body);
    expect(results[0].text).toBe("R&D is <important> & so is 'testing'");
  });

  it('returns empty array for empty response', () => {
    const body = JSON.stringify({ data: { home: { home_timeline_urt: { instructions: [] } } } });
    expect(parseGraphQLTimeline(body)).toEqual([]);
  });
});

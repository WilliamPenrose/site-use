import { describe, it, expect } from 'vitest';
import {
  parseTweet,
  buildFeedMeta,
  parseGraphQLTimeline,
  processFullText,
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
  media: [],
  links: [],
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
    expect(tweet.metrics).toEqual({
      likes: 1500, retweets: 83, replies: 42,
      views: undefined, bookmarks: undefined, quotes: undefined,
    });
    expect(tweet.media).toEqual([]);
    expect(tweet.links).toEqual([]);
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

  it('maps photo media with ?name=orig URL', () => {
    const tweet = parseTweet({
      ...RAW_TWEET,
      media: [{
        type: 'photo',
        mediaUrl: 'https://pbs.twimg.com/media/xxx.jpg',
        width: 1080,
        height: 720,
      }],
    });
    expect(tweet.media).toHaveLength(1);
    expect(tweet.media[0].type).toBe('photo');
    expect(tweet.media[0].url).toBe('https://pbs.twimg.com/media/xxx.jpg?name=orig');
    expect(tweet.media[0].width).toBe(1080);
    expect(tweet.media[0].height).toBe(720);
    expect(tweet.media[0].thumbnailUrl).toBeUndefined();
    expect(tweet.media[0].duration).toBeUndefined();
  });

  it('maps video media with highest bitrate URL and thumbnail', () => {
    const tweet = parseTweet({
      ...RAW_TWEET,
      media: [{
        type: 'video',
        mediaUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/xxx/pu/img/thumb.jpg',
        width: 1920,
        height: 1080,
        durationMs: 15000,
        videoUrl: 'https://video.twimg.com/ext_tw_video/xxx/pu/vid/1920x1080/best.mp4',
      }],
    });
    expect(tweet.media[0].type).toBe('video');
    expect(tweet.media[0].url).toBe('https://video.twimg.com/ext_tw_video/xxx/pu/vid/1920x1080/best.mp4');
    expect(tweet.media[0].thumbnailUrl).toBe('https://pbs.twimg.com/ext_tw_video_thumb/xxx/pu/img/thumb.jpg');
    expect(tweet.media[0].duration).toBe(15000);
  });

  it('maps animated_gif to gif type', () => {
    const tweet = parseTweet({
      ...RAW_TWEET,
      media: [{
        type: 'animated_gif',
        mediaUrl: 'https://pbs.twimg.com/tweet_video_thumb/xxx.jpg',
        width: 480,
        height: 270,
        videoUrl: 'https://video.twimg.com/tweet_video/xxx.mp4',
      }],
    });
    expect(tweet.media[0].type).toBe('gif');
    expect(tweet.media[0].thumbnailUrl).toBe('https://pbs.twimg.com/tweet_video_thumb/xxx.jpg');
  });
});

describe('buildFeedMeta', () => {
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

    const meta = buildFeedMeta(tweets);
    expect(meta.coveredUsers).toContain('karpathy');
    expect(meta.coveredUsers).toContain('steipete');
    expect(meta.timeRange.from).toBe('2026-03-18T20:00:00.000Z');
    expect(meta.timeRange.to).toBe('2026-03-18T23:49:31.000Z');
  });

  it('handles empty tweet array', () => {
    const meta = buildFeedMeta([]);
    expect(meta.coveredUsers).toEqual([]);
    expect(meta.timeRange.from).toBe('');
    expect(meta.timeRange.to).toBe('');
  });

  it('deduplicates covered users', () => {
    const tweets = [
      parseTweet(RAW_TWEET),
      parseTweet({ ...RAW_TWEET, url: 'https://x.com/karpathy/status/222' }),
    ];
    const meta = buildFeedMeta(tweets);
    expect(meta.coveredUsers).toEqual(['karpathy']);
  });
});

describe('processFullText', () => {
  it('expands external t.co URLs to expanded_url', () => {
    //            0123456789...
    const text = 'Check out https://t.co/abc123 for details';
    //            indices:  [10, 29] = "https://t.co/abc123"
    const entities = {
      urls: [{
        url: 'https://t.co/abc123',
        expanded_url: 'https://example.com/article',
        indices: [10, 29],
      }],
    };
    expect(processFullText(text, entities)).toBe(
      'Check out https://example.com/article for details',
    );
  });

  it('strips media t.co URLs from text', () => {
    const text = 'Beautiful sunset https://t.co/img123';
    // 'https://t.co/img123' starts at 17, length 19 → [17, 36]
    const entities = {
      media: [{
        url: 'https://t.co/img123',
        indices: [17, 36],
      }],
    };
    expect(processFullText(text, entities)).toBe('Beautiful sunset');
  });

  it('handles both external URLs and media URLs together', () => {
    const text = 'Read https://t.co/link1 and see https://t.co/pic1';
    // 'https://t.co/link1' at [5, 23], 'https://t.co/pic1' at [32, 49]
    const entities = {
      urls: [{
        url: 'https://t.co/link1',
        expanded_url: 'https://blog.com/post',
        indices: [5, 23],
      }],
      media: [{
        url: 'https://t.co/pic1',
        indices: [32, 49],
      }],
    };
    expect(processFullText(text, entities)).toBe(
      'Read https://blog.com/post and see',
    );
  });

  it('decodes HTML entities', () => {
    const text = 'R&amp;D &lt;3';
    expect(processFullText(text, {})).toBe('R&D <3');
  });

  it('handles empty entities gracefully', () => {
    const text = 'Plain text tweet';
    expect(processFullText(text, {})).toBe('Plain text tweet');
  });
});

describe('parseGraphQLTimeline', () => {
  function makeTweetEntry(legacy: any, core?: any, extras?: Record<string, unknown>) {
    return {
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'Tweet',
              rest_id: legacy.id_str,
              legacy,
              core: core ?? {
                user_results: {
                  result: {
                    legacy: { screen_name: 'testuser', name: 'Test User' },
                  },
                },
              },
              ...extras,
            },
          },
        },
      },
    };
  }

  function wrapTimeline(entries: any[]) {
    return JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{ entries }],
          },
        },
      },
    });
  }

  it('parses a timeline response with one tweet', () => {
    const body = wrapTimeline([makeTweetEntry({
      id_str: '123456',
      full_text: 'Hello world',
      created_at: 'Mon Mar 18 23:49:31 +0000 2026',
      favorite_count: 10,
      retweet_count: 2,
      reply_count: 1,
      retweeted_status_result: null,
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].authorHandle).toBe('testuser');
    expect(results[0].text).toBe('Hello world');
    expect(results[0].likes).toBe(10);
    expect(results[0].media).toEqual([]);
    expect(results[0].isAd).toBe(false);
  });

  it('extracts views, bookmarks, and quotes', () => {
    const body = wrapTimeline([makeTweetEntry({
      id_str: '999',
      full_text: 'Popular tweet',
      created_at: 'Mon Mar 18 23:49:31 +0000 2026',
      favorite_count: 500,
      retweet_count: 50,
      reply_count: 30,
      bookmark_count: 12,
      quote_count: 8,
      retweeted_status_result: null,
    }, undefined, { views: { count: '98765', state: 'EnabledWithCount' } })]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].views).toBe(98765);
    expect(results[0].bookmarks).toBe(12);
    expect(results[0].quotes).toBe(8);
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
    const body = wrapTimeline([makeTweetEntry({
      id_str: '888',
      full_text: 'R&amp;D is &lt;important&gt; &amp; so is &#39;testing&#39;',
      created_at: '',
      favorite_count: 0,
      retweet_count: 0,
      reply_count: 0,
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results[0].text).toBe("R&D is <important> & so is 'testing'");
  });

  it('extracts photo media from extended_entities', () => {
    // 'https://t.co/img1' at [13, 30]
    const body = wrapTimeline([makeTweetEntry({
      id_str: '900',
      full_text: 'Look at this https://t.co/img1',
      created_at: '',
      favorite_count: 0,
      retweet_count: 0,
      reply_count: 0,
      entities: {
        media: [{
          url: 'https://t.co/img1',
          indices: [13, 30],
        }],
      },
      extended_entities: {
        media: [{
          type: 'photo',
          media_url_https: 'https://pbs.twimg.com/media/test.jpg',
          original_info: { width: 1080, height: 720 },
          ext_alt_text: 'A beautiful landscape',
          indices: [13, 30],
        }],
      },
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results[0].text).toBe('Look at this');
    expect(results[0].media).toHaveLength(1);
    expect(results[0].media[0].type).toBe('photo');
    expect(results[0].media[0].mediaUrl).toBe('https://pbs.twimg.com/media/test.jpg');
    expect(results[0].media[0].width).toBe(1080);
    expect(results[0].media[0].height).toBe(720);
  });

  it('extracts video media with highest bitrate mp4', () => {
    const body = wrapTimeline([makeTweetEntry({
      id_str: '901',
      full_text: 'Watch this https://t.co/vid1',
      created_at: '',
      favorite_count: 0,
      retweet_count: 0,
      reply_count: 0,
      entities: {
        media: [{ url: 'https://t.co/vid1', indices: [11, 28] }],
      },
      extended_entities: {
        media: [{
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/xxx/thumb.jpg',
          original_info: { width: 1920, height: 1080 },
          video_info: {
            duration_millis: 30000,
            variants: [
              { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/xxx.m3u8' },
              { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/xxx_low.mp4' },
              { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/xxx_high.mp4' },
              { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/xxx_med.mp4' },
            ],
          },
          indices: [11, 28],
        }],
      },
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results[0].text).toBe('Watch this');
    expect(results[0].media).toHaveLength(1);
    const vid = results[0].media[0];
    expect(vid.type).toBe('video');
    expect(vid.videoUrl).toBe('https://video.twimg.com/xxx_high.mp4');
    expect(vid.durationMs).toBe(30000);
    expect(vid.mediaUrl).toBe('https://pbs.twimg.com/ext_tw_video_thumb/xxx/thumb.jpg');
  });

  it('extracts expanded URLs into links array', () => {
    const body = wrapTimeline([makeTweetEntry({
      id_str: '903',
      full_text: 'Read this https://t.co/link1 and https://t.co/link2',
      created_at: '',
      favorite_count: 0,
      retweet_count: 0,
      reply_count: 0,
      entities: {
        urls: [
          { url: 'https://t.co/link1', expanded_url: 'https://arxiv.org/abs/123', indices: [10, 28] },
          { url: 'https://t.co/link2', expanded_url: 'https://github.com/repo', indices: [33, 51] },
        ],
      },
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results[0].links).toEqual([
      'https://arxiv.org/abs/123',
      'https://github.com/repo',
    ]);
  });

  it('returns empty links when no URLs in entities', () => {
    const body = wrapTimeline([makeTweetEntry({
      id_str: '904',
      full_text: 'No links here',
      created_at: '',
      favorite_count: 0,
      retweet_count: 0,
      reply_count: 0,
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results[0].links).toEqual([]);
  });

  it('expands external t.co URLs in tweet text', () => {
    // 'https://t.co/link1' at [10, 28]
    const body = wrapTimeline([makeTweetEntry({
      id_str: '902',
      full_text: 'Read this https://t.co/link1 great article',
      created_at: '',
      favorite_count: 0,
      retweet_count: 0,
      reply_count: 0,
      entities: {
        urls: [{
          url: 'https://t.co/link1',
          expanded_url: 'https://blog.example.com/post',
          indices: [10, 28],
        }],
      },
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results[0].text).toBe('Read this https://blog.example.com/post great article');
  });

  it('returns empty array for empty response', () => {
    const body = JSON.stringify({ data: { home: { home_timeline_urt: { instructions: [] } } } });
    expect(parseGraphQLTimeline(body)).toEqual([]);
  });

  it('skips TweetTombstone and TweetUnavailable entries', () => {
    const body = wrapTimeline([
      // Normal tweet — should be included
      makeTweetEntry({
        id_str: '100',
        full_text: 'Normal tweet',
        created_at: 'Mon Mar 18 23:49:31 +0000 2026',
        favorite_count: 1,
        retweet_count: 0,
        reply_count: 0,
        retweeted_status_result: null,
      }),
      // TweetTombstone — should be skipped
      {
        content: {
          entryType: 'TimelineTimelineItem',
          itemContent: {
            tweet_results: {
              result: {
                __typename: 'TweetTombstone',
                tombstone: { text: { text: 'This Tweet is from a suspended account.' } },
              },
            },
          },
        },
      },
      // TweetUnavailable — should be skipped
      {
        content: {
          entryType: 'TimelineTimelineItem',
          itemContent: {
            tweet_results: {
              result: {
                __typename: 'TweetUnavailable',
                reason: 'NsfwLoggedOut',
              },
            },
          },
        },
      },
    ]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('Normal tweet');
  });
});

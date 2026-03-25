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
  following: true,
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
  surfaceReason: 'original',
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

  it('includes surfacedBy handles in coveredUsers', () => {
    const tweets = [
      parseTweet({
        ...RAW_TWEET,
        authorHandle: 'pushmeet',
        surfaceReason: 'retweet',
        surfacedBy: 'GoogleDeepMind',
        url: 'https://x.com/pushmeet/status/111',
      }),
    ];
    const meta = buildFeedMeta(tweets);
    expect(meta.coveredUsers).toContain('pushmeet');
    expect(meta.coveredUsers).toContain('GoogleDeepMind');
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

  it('extracts inner tweet from retweet with surfacedBy', () => {
    const body = wrapTimeline([{
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'Tweet',
              rest_id: 'outer-999',
              legacy: {
                id_str: 'outer-999',
                full_text: 'RT @pushmeet: Our AlphaProof paper...',
                created_at: 'Fri Mar 20 14:15:28 +0000 2026',
                favorite_count: 0, retweet_count: 89, reply_count: 0,
                retweeted_status_result: {
                  result: {
                    __typename: 'Tweet',
                    rest_id: 'inner-777',
                    legacy: {
                      id_str: 'inner-777',
                      full_text: 'Our AlphaProof paper is in this week issue of @Nature!',
                      created_at: 'Fri Mar 20 14:09:30 +0000 2026',
                      favorite_count: 663, retweet_count: 89, reply_count: 17,
                      bookmark_count: 196, quote_count: 5,
                      entities: { urls: [] },
                    },
                    core: { user_results: { result: { core: { screen_name: 'pushmeet', name: 'Pushmeet Kohli' } } } },
                    views: { count: '66004', state: 'EnabledWithCount' },
                  },
                },
              },
              core: { user_results: { result: { core: { screen_name: 'GoogleDeepMind', name: 'Google DeepMind' } } } },
            },
          },
        },
      },
    }]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    const rt = results[0];
    expect(rt.authorHandle).toBe('pushmeet');
    expect(rt.text).toBe('Our AlphaProof paper is in this week issue of @Nature!');
    expect(rt.likes).toBe(663);
    expect(rt.views).toBe(66004);
    expect(rt.bookmarks).toBe(196);
    expect(rt.surfaceReason).toBe('retweet');
    expect(rt.surfacedBy).toBe('GoogleDeepMind');
    expect(rt.url).toBe('https://x.com/pushmeet/status/inner-777');
  });

  it('prefers note_tweet text over legacy full_text', () => {
    const body = wrapTimeline([makeTweetEntry({
      id_str: '800',
      full_text: 'Truncated version of the tweet...',
      created_at: 'Mon Mar 18 23:49:31 +0000 2026',
      favorite_count: 100, retweet_count: 10, reply_count: 5,
      entities: { urls: [] },
    }, undefined, {
      note_tweet: {
        note_tweet_results: {
          result: {
            text: 'Full long version of the tweet that exceeds 280 characters and contains the complete content',
            entity_set: { urls: [], user_mentions: [], hashtags: [] },
          },
        },
      },
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('Full long version of the tweet that exceeds 280 characters and contains the complete content');
  });

  it('expands URLs using note_tweet entity_set when note_tweet is present', () => {
    const body = wrapTimeline([makeTweetEntry({
      id_str: '801',
      full_text: 'Short https://t.co/abc',
      created_at: '', favorite_count: 0, retweet_count: 0, reply_count: 0,
      entities: {
        urls: [{ url: 'https://t.co/abc', expanded_url: 'https://wrong.com', indices: [6, 22] }],
      },
    }, undefined, {
      note_tweet: {
        note_tweet_results: {
          result: {
            text: 'Long form text with link https://t.co/xyz here',
            entity_set: {
              urls: [{ url: 'https://t.co/xyz', expanded_url: 'https://correct.com/article', indices: [25, 41] }],
            },
          },
        },
      },
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results[0].text).toBe('Long form text with link https://correct.com/article here');
  });

  it('falls back to legacy.full_text when note_tweet is absent', () => {
    const body = wrapTimeline([makeTweetEntry({
      id_str: '802',
      full_text: 'Regular short tweet',
      created_at: '', favorite_count: 0, retweet_count: 0, reply_count: 0,
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results[0].text).toBe('Regular short tweet');
  });

  it('extracts note_tweet from inner tweet of a retweet', () => {
    const body = wrapTimeline([{
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'Tweet',
              rest_id: 'rt-outer-nt',
              legacy: {
                id_str: 'rt-outer-nt',
                full_text: 'RT @author: Short version...',
                created_at: '', favorite_count: 0, retweet_count: 5, reply_count: 0,
                retweeted_status_result: {
                  result: {
                    __typename: 'Tweet',
                    rest_id: 'inner-nt',
                    legacy: {
                      id_str: 'inner-nt',
                      full_text: 'Short version...',
                      created_at: '', favorite_count: 100, retweet_count: 5, reply_count: 2,
                      entities: { urls: [] },
                    },
                    core: { user_results: { result: { core: { screen_name: 'author', name: 'Author' } } } },
                    note_tweet: {
                      note_tweet_results: {
                        result: {
                          text: 'This is the full long-form text that exceeds 280 characters and should be used instead of the truncated legacy.full_text',
                          entity_set: { urls: [], user_mentions: [], hashtags: [] },
                        },
                      },
                    },
                  },
                },
              },
              core: { user_results: { result: { core: { screen_name: 'retweeter', name: 'RT' } } } },
            },
          },
        },
      },
    }]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].surfaceReason).toBe('retweet');
    expect(results[0].surfacedBy).toBe('retweeter');
    expect(results[0].text).toBe('This is the full long-form text that exceeds 280 characters and should be used instead of the truncated legacy.full_text');
  });

  it('extracts quotedTweet for quote tweets', () => {
    const body = wrapTimeline([{
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'Tweet',
              rest_id: 'qt-100',
              legacy: {
                id_str: 'qt-100',
                full_text: 'This is my commentary',
                created_at: 'Mon Mar 18 23:49:31 +0000 2026',
                favorite_count: 45, retweet_count: 12, reply_count: 3,
                is_quote_status: true,
                entities: {},
              },
              core: { user_results: { result: { core: { screen_name: 'peter', name: 'Peter' } } } },
              quoted_status_result: {
                result: {
                  __typename: 'Tweet',
                  rest_id: 'orig-200',
                  legacy: {
                    id_str: 'orig-200',
                    full_text: 'Original insightful tweet',
                    created_at: 'Sun Mar 17 10:00:00 +0000 2026',
                    favorite_count: 1200, retweet_count: 230, reply_count: 50,
                    entities: {},
                  },
                  core: { user_results: { result: { core: { screen_name: 'dimillian', name: 'Dimillian' } } } },
                  views: { count: '45000' },
                },
              },
            },
          },
        },
      },
    }]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    const qt = results[0];
    expect(qt.authorHandle).toBe('peter');
    expect(qt.text).toBe('This is my commentary');
    expect(qt.surfaceReason).toBe('quote');
    expect(qt.quotedTweet).toBeDefined();
    expect(qt.quotedTweet!.authorHandle).toBe('dimillian');
    expect(qt.quotedTweet!.text).toBe('Original insightful tweet');
    expect(qt.quotedTweet!.likes).toBe(1200);
  });

  it('sets quotedTweet to undefined when quoted tweet is TweetTombstone', () => {
    const body = wrapTimeline([{
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'Tweet',
              rest_id: 'qt-300',
              legacy: {
                id_str: 'qt-300',
                full_text: 'Quoting a deleted tweet',
                created_at: '', favorite_count: 0, retweet_count: 0, reply_count: 0,
                is_quote_status: true,
                entities: {},
              },
              core: { user_results: { result: { core: { screen_name: 'user1', name: 'User' } } } },
              quoted_status_result: {
                result: { __typename: 'TweetTombstone' },
              },
            },
          },
        },
      },
    }]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].surfaceReason).toBe('quote');
    expect(results[0].quotedTweet).toBeUndefined();
  });

  it('extracts inReplyTo for replies', () => {
    const body = wrapTimeline([makeTweetEntry({
      id_str: 'reply-400',
      full_text: 'Totally agree with this take',
      created_at: 'Mon Mar 18 23:49:31 +0000 2026',
      favorite_count: 8, retweet_count: 1, reply_count: 0,
      in_reply_to_status_id_str: 'orig-500',
      in_reply_to_screen_name: 'dimillian',
      entities: {},
    })]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].surfaceReason).toBe('reply');
    expect(results[0].inReplyTo).toEqual({ handle: 'dimillian', tweetId: 'orig-500' });
  });

  it('assigns surfaceReason quote when tweet is both reply and quote', () => {
    const body = wrapTimeline([{
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'Tweet',
              rest_id: 'both-600',
              legacy: {
                id_str: 'both-600',
                full_text: 'Replying with a quote',
                created_at: '', favorite_count: 0, retweet_count: 0, reply_count: 0,
                is_quote_status: true,
                in_reply_to_status_id_str: 'other-700',
                in_reply_to_screen_name: 'someone',
                entities: {},
              },
              core: { user_results: { result: { core: { screen_name: 'user2', name: 'User2' } } } },
              quoted_status_result: {
                result: {
                  __typename: 'Tweet',
                  rest_id: 'quoted-800',
                  legacy: {
                    id_str: 'quoted-800', full_text: 'Quoted content',
                    created_at: '', favorite_count: 0, retweet_count: 0, reply_count: 0,
                    entities: {},
                  },
                  core: { user_results: { result: { core: { screen_name: 'author3', name: 'A3' } } } },
                },
              },
            },
          },
        },
      },
    }]);

    const results = parseGraphQLTimeline(body);
    expect(results[0].surfaceReason).toBe('quote');
    expect(results[0].inReplyTo).toEqual({ handle: 'someone', tweetId: 'other-700' });
    expect(results[0].quotedTweet).toBeDefined();
  });

  it('handles retweet of quote tweet (recursive)', () => {
    const body = wrapTimeline([{
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'Tweet',
              rest_id: 'rt-outer',
              legacy: {
                id_str: 'rt-outer',
                full_text: 'RT @peter: My commentary on this...',
                created_at: '', favorite_count: 0, retweet_count: 5, reply_count: 0,
                retweeted_status_result: {
                  result: {
                    __typename: 'Tweet',
                    rest_id: 'qt-inner',
                    legacy: {
                      id_str: 'qt-inner',
                      full_text: 'My commentary on this',
                      created_at: '', favorite_count: 50, retweet_count: 5, reply_count: 2,
                      is_quote_status: true,
                      entities: {},
                    },
                    core: { user_results: { result: { core: { screen_name: 'peter', name: 'Peter' } } } },
                    quoted_status_result: {
                      result: {
                        __typename: 'Tweet',
                        rest_id: 'orig-deep',
                        legacy: {
                          id_str: 'orig-deep',
                          full_text: 'Deep original content',
                          created_at: '', favorite_count: 1000, retweet_count: 100, reply_count: 50,
                          entities: {},
                        },
                        core: { user_results: { result: { core: { screen_name: 'dimillian', name: 'Dimillian' } } } },
                      },
                    },
                  },
                },
              },
              core: { user_results: { result: { core: { screen_name: 'alice', name: 'Alice' } } } },
            },
          },
        },
      },
    }]);

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    const rt = results[0];
    expect(rt.surfaceReason).toBe('retweet');
    expect(rt.surfacedBy).toBe('alice');
    expect(rt.authorHandle).toBe('peter');
    expect(rt.text).toBe('My commentary on this');
    expect(rt.quotedTweet).toBeDefined();
    expect(rt.quotedTweet!.authorHandle).toBe('dimillian');
  });

  it('extracts tweets from TimelineTimelineModule (conversation thread)', () => {
    const body = JSON.stringify({
      data: { home: { home_timeline_urt: { instructions: [{
        type: 'TimelineAddEntries',
        entries: [{
          entryId: 'conversationthread-123',
          content: {
            entryType: 'TimelineTimelineModule',
            items: [
              { item: { itemContent: {
                __typename: 'TimelineTweet',
                tweet_results: { result: {
                  __typename: 'Tweet', rest_id: 'mod-1',
                  legacy: { id_str: 'mod-1', full_text: 'First in thread', created_at: '', favorite_count: 10, retweet_count: 0, reply_count: 2, entities: {} },
                  core: { user_results: { result: { core: { screen_name: 'threadauthor', name: 'Thread' } } } },
                } },
              } } },
              { item: { itemContent: {
                __typename: 'TimelineTweet',
                tweet_results: { result: {
                  __typename: 'Tweet', rest_id: 'mod-2',
                  legacy: { id_str: 'mod-2', full_text: 'Reply in thread', created_at: '', favorite_count: 5, retweet_count: 0, reply_count: 0, entities: {} },
                  core: { user_results: { result: { core: { screen_name: 'replier', name: 'Replier' } } } },
                } },
              } } },
            ],
          },
        }],
      }] } } },
    });

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(2);
    expect(results[0].authorHandle).toBe('threadauthor');
    expect(results[1].authorHandle).toBe('replier');
  });

  it('skips non-TimelineTweet items in modules (who-to-follow)', () => {
    const body = JSON.stringify({
      data: { home: { home_timeline_urt: { instructions: [{
        type: 'TimelineAddEntries',
        entries: [{
          entryId: 'who-to-follow-123',
          content: {
            entryType: 'TimelineTimelineModule',
            items: [{ item: { itemContent: {
              __typename: 'TimelineUser',
              user_results: { result: { legacy: { screen_name: 'suggested' } } },
            } } }],
          },
        }],
      }] } } },
    });

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(0);
  });

  it('extracts tweets from TimelineAddToModule instruction', () => {
    const body = JSON.stringify({
      data: { home: { home_timeline_urt: { instructions: [
        { type: 'TimelineAddEntries', entries: [] },
        { type: 'TimelineAddToModule', moduleItems: [{ item: { itemContent: {
          __typename: 'TimelineTweet',
          tweet_results: { result: {
            __typename: 'Tweet', rest_id: 'atm-1',
            legacy: { id_str: 'atm-1', full_text: 'Added to module', created_at: '', favorite_count: 0, retweet_count: 0, reply_count: 0, entities: {} },
            core: { user_results: { result: { core: { screen_name: 'moduser', name: 'Mod' } } } },
          } },
        } } }] },
      ] } } },
    });

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].authorHandle).toBe('moduser');
  });

  it('extracts tweet from TimelinePinEntry instruction', () => {
    const body = JSON.stringify({
      data: { home: { home_timeline_urt: { instructions: [
        { type: 'TimelineAddEntries', entries: [] },
        { type: 'TimelinePinEntry', entry: { content: {
          entryType: 'TimelineTimelineItem',
          itemContent: {
            tweet_results: { result: {
              __typename: 'Tweet', rest_id: 'pin-1',
              legacy: { id_str: 'pin-1', full_text: 'Pinned tweet', created_at: '', favorite_count: 0, retweet_count: 0, reply_count: 0, entities: {} },
              core: { user_results: { result: { core: { screen_name: 'pinner', name: 'Pinner' } } } },
            } },
          },
        } } },
      ] } } },
    });

    const results = parseGraphQLTimeline(body);
    expect(results).toHaveLength(1);
    expect(results[0].authorHandle).toBe('pinner');
  });
});

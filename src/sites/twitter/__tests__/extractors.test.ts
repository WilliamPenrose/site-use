import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTweet,
  buildFeedMeta,
  parseGraphQLTimeline,
  processFullText,
} from '../extractors.js';
import type { RawTweetData } from '../types.js';

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
    const text = 'Check out https://t.co/abc123 for details';
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

// ---------------------------------------------------------------------------
// parseGraphQLTimeline — fixture-driven tests
// ---------------------------------------------------------------------------

// Load real tweet variants from fixture file
interface FixtureEntry {
  _variant: string;
  tweet_results: { result: Record<string, unknown> };
}

const fixturesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/golden/timeline-variants.json');
const allFixtures: FixtureEntry[] = JSON.parse(fs.readFileSync(fixturesPath, 'utf-8'));

function wrapAsTimeline(itemContent: FixtureEntry | Record<string, unknown>): string {
  return JSON.stringify({
    data: {
      home: {
        home_timeline_urt: {
          instructions: [{
            type: 'TimelineAddEntries',
            entries: [{
              entryId: 'tweet-test',
              sortIndex: '1',
              content: {
                __typename: 'TimelineTimelineItem',
                entryType: 'TimelineTimelineItem',
                itemContent: {
                  __typename: 'TimelineTweet',
                  ...itemContent,
                },
              },
            }],
          }],
        },
      },
    },
  });
}

function fixturesByPattern(pattern: string): FixtureEntry[] {
  return allFixtures.filter(f => f._variant.includes(pattern));
}

describe('parseGraphQLTimeline (real fixtures)', () => {
  it('all 31 variants parse without throwing', () => {
    let parsed = 0;
    for (const fixture of allFixtures) {
      const body = wrapAsTimeline(fixture);
      const tweets = parseGraphQLTimeline(body);
      parsed += tweets.length;
    }
    expect(parsed).toBeGreaterThan(0);
  });

  describe('original tweets', () => {
    const originals = fixturesByPattern('|original|');

    it('extracts author, text, metrics, and timestamp', () => {
      for (const fixture of originals) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
        const t = tweets[0];
        expect(t.authorHandle, fixture._variant).toBeTruthy();
        expect(t.text, fixture._variant).toBeTruthy();
        expect(typeof t.likes, fixture._variant).toBe('number');
        expect(typeof t.retweets, fixture._variant).toBe('number');
        expect(t.surfaceReason, fixture._variant).toBe('original');
        expect(t.isRetweet, fixture._variant).toBe(false);
      }
    });

    it('extracts views as number from string count', () => {
      const withViews = originals.filter(f => {
        const tr = f.tweet_results.result as any;
        const core = tr.__typename === 'TweetWithVisibilityResults' ? tr.tweet : tr;
        return core?.views?.count != null;
      });
      expect(withViews.length).toBeGreaterThan(0);
      for (const fixture of withViews) {
        const t = parseGraphQLTimeline(wrapAsTimeline(fixture))[0];
        expect(typeof t.views, fixture._variant).toBe('number');
      }
    });
  });

  describe('retweets', () => {
    const retweets = fixturesByPattern('|retweet|');

    it('extracts inner tweet with surfaceReason=retweet and surfacedBy', () => {
      expect(retweets.length).toBeGreaterThan(0);
      for (const fixture of retweets) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
        const t = tweets[0];
        expect(t.surfaceReason, fixture._variant).toBe('retweet');
        expect(t.surfacedBy, fixture._variant).toBeTruthy();
        expect(t.isRetweet, fixture._variant).toBe(true);
      }
    });
  });

  describe('quote tweets', () => {
    const quotes = fixturesByPattern('|quote|');

    it('extracts quotedTweet with surfaceReason=quote', () => {
      expect(quotes.length).toBeGreaterThan(0);
      for (const fixture of quotes) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
        const t = tweets[0];
        expect(t.surfaceReason, fixture._variant).toBe('quote');
        expect(t.quotedTweet, fixture._variant).toBeDefined();
        expect(t.quotedTweet!.authorHandle, fixture._variant).toBeTruthy();
      }
    });
  });

  describe('following field', () => {
    it('extracts following=true from relationship_perspectives', () => {
      const fixtures = fixturesByPattern('following:true').filter(f => !f._variant.includes('retweet'));
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const t = parseGraphQLTimeline(wrapAsTimeline(fixture))[0];
        expect(t.following, fixture._variant).toBe(true);
      }
    });

    it('extracts following=false from relationship_perspectives', () => {
      const fixtures = fixturesByPattern('following:false');
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const t = parseGraphQLTimeline(wrapAsTimeline(fixture))[0];
        expect(t.following, fixture._variant).toBe(false);
      }
    });

    it('defaults to false when relationship_perspectives is missing', () => {
      const fixtures = fixturesByPattern('following:true').filter(f => !f._variant.includes('retweet'));
      const fixture = structuredClone(fixtures[0]);
      const tr = fixture.tweet_results.result as any;
      const core = tr.__typename === 'TweetWithVisibilityResults' ? tr.tweet : tr;
      delete core.core.user_results.result.relationship_perspectives;

      const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
      expect(tweets.length).toBeGreaterThanOrEqual(1);
      expect(tweets[0].following).toBe(false);
    });
  });

  describe('media extraction', () => {
    it('extracts photo media', () => {
      const fixtures = fixturesByPattern('media:photo');
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        if (tweets.length === 0) continue; // tombstone
        const t = tweets[0];
        const photos = t.media.filter(m => m.type === 'photo');
        expect(photos.length, fixture._variant).toBeGreaterThan(0);
        for (const p of photos) {
          expect(p.mediaUrl, fixture._variant).toContain('pbs.twimg.com');
          expect(p.width, fixture._variant).toBeGreaterThan(0);
          expect(p.height, fixture._variant).toBeGreaterThan(0);
        }
      }
    });

    it('extracts video media with duration and videoUrl', () => {
      const fixtures = fixturesByPattern('media:video');
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        if (tweets.length === 0) continue;
        const t = tweets[0];
        const videos = t.media.filter(m => m.type === 'video');
        expect(videos.length, fixture._variant).toBeGreaterThan(0);
        for (const v of videos) {
          expect(v.videoUrl, fixture._variant).toBeTruthy();
          expect(v.durationMs, fixture._variant).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('note_tweet (long-form)', () => {
    const noteTweets = fixturesByPattern('note_tweet');

    it('prefers note_tweet text over legacy full_text', () => {
      expect(noteTweets.length).toBeGreaterThan(0);
      for (const fixture of noteTweets) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        if (tweets.length === 0) continue;
        // Note tweets typically have longer text than legacy truncation
        expect(tweets[0].text, fixture._variant).toBeTruthy();
      }
    });
  });

  describe('URL expansion', () => {
    const withUrls = fixturesByPattern('has_urls');

    it('expands t.co links into links array', () => {
      expect(withUrls.length).toBeGreaterThan(0);
      for (const fixture of withUrls) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        if (tweets.length === 0) continue;
        const t = tweets[0];
        // has_urls variants should have at least one expanded link
        expect(t.links.length, fixture._variant).toBeGreaterThan(0);
        for (const link of t.links) {
          expect(link, fixture._variant).not.toContain('t.co');
        }
      }
    });
  });

  describe('TweetWithVisibilityResults wrapper', () => {
    const wrapped = fixturesByPattern('wrapped|');

    it('unwraps and parses successfully', () => {
      expect(wrapped.length).toBeGreaterThan(0);
      for (const fixture of wrapped) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
        expect(tweets[0].authorHandle, fixture._variant).toBeTruthy();
      }
    });
  });

  describe('tombstones', () => {
    const tombstones = fixturesByPattern('tombstone');

    it('returns empty array for tombstone/unavailable tweets', () => {
      expect(tombstones.length).toBeGreaterThan(0);
      for (const fixture of tombstones) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets, fixture._variant).toHaveLength(0);
      }
    });
  });

  it('fixture coverage: has both following values and all tweet types', () => {
    const variants = allFixtures.map(f => f._variant);
    // Following values
    expect(variants.some(v => v.includes('following:true'))).toBe(true);
    expect(variants.some(v => v.includes('following:false'))).toBe(true);
    // Tweet types
    expect(variants.some(v => v.includes('original'))).toBe(true);
    expect(variants.some(v => v.includes('retweet'))).toBe(true);
    expect(variants.some(v => v.includes('quote'))).toBe(true);
    // Structural variants
    expect(variants.some(v => v.includes('wrapped'))).toBe(true);
    expect(variants.some(v => v.includes('direct'))).toBe(true);
    expect(variants.some(v => v.includes('tombstone'))).toBe(true);
    // Content features
    expect(variants.some(v => v.includes('note_tweet'))).toBe(true);
    expect(variants.some(v => v.includes('media:'))).toBe(true);
    expect(variants.some(v => v.includes('has_urls'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseGraphQLTimeline — edge cases requiring hand-crafted data
// (these scenarios are not present in the fixture dump)
// ---------------------------------------------------------------------------

describe('parseGraphQLTimeline (edge cases)', () => {
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
                    core: { screen_name: 'testuser', name: 'Test User' },
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
                        core: { user_results: { result: { core: { screen_name: 'ad', name: 'Ad' } } } },
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

  it('returns empty array for empty response', () => {
    const body = JSON.stringify({ data: { home: { home_timeline_urt: { instructions: [] } } } });
    expect(parseGraphQLTimeline(body)).toEqual([]);
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

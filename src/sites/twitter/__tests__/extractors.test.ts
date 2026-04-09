import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTweet,
  buildFeedMeta,
  parseGraphQLTimeline,
  parseTweetDetail,
  processFullText,
  findInstructions,
  extractUserProfile,
  parseProfileResponse,
  GRAPHQL_PROFILE_PATTERN,
  parseFollowListResponse,
  GRAPHQL_FOLLOW_LIST_PATTERN,
} from '../extractors.js';
import type { RawTweetData, UserProfile, ProfileResult } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
// findInstructions — recursive search for timeline instructions
// ---------------------------------------------------------------------------

describe('findInstructions', () => {
  it('finds instructions in Home timeline response', () => {
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{ type: 'TimelineAddEntries', entries: [] }],
          },
        },
      },
    };
    const result = findInstructions(data);
    expect(result).toEqual([{ type: 'TimelineAddEntries', entries: [] }]);
  });

  it('finds instructions in List timeline response', () => {
    const data = {
      data: {
        list: {
          tweets_timeline: {
            timeline: {
              instructions: [{ type: 'TimelineAddEntries', entries: [] }],
            },
          },
        },
      },
    };
    const result = findInstructions(data);
    expect(result).toEqual([{ type: 'TimelineAddEntries', entries: [] }]);
  });

  it('finds instructions in Community timeline response', () => {
    const data = {
      data: {
        communityResults: {
          result: {
            ranked_community_timeline: {
              timeline: {
                instructions: [
                  { type: 'TimelineClearCache' },
                  { type: 'TimelineAddEntries', entries: [] },
                ],
              },
            },
          },
        },
      },
    };
    const result = findInstructions(data);
    expect(result).toHaveLength(2);
    expect(result![0].type).toBe('TimelineClearCache');
  });

  it('skips instructions arrays without Timeline-typed elements', () => {
    const data = {
      instructions: [{ type: 'SomethingElse' }],
      nested: {
        instructions: [{ type: 'TimelineAddEntries', entries: [] }],
      },
    };
    const result = findInstructions(data);
    expect(result).toEqual([{ type: 'TimelineAddEntries', entries: [] }]);
  });

  it('returns null when no instructions found', () => {
    expect(findInstructions({ data: { empty: {} } })).toBeNull();
    expect(findInstructions(null)).toBeNull();
    expect(findInstructions('string')).toBeNull();
  });

  it('respects maxDepth', () => {
    let obj: any = { instructions: [{ type: 'TimelineAddEntries' }] };
    for (let i = 0; i < 4; i++) obj = { nested: obj };
    expect(findInstructions(obj)).toBeTruthy();

    let deep: any = { instructions: [{ type: 'TimelineAddEntries' }] };
    for (let i = 0; i < 9; i++) deep = { nested: deep };
    expect(findInstructions(deep)).toBeNull();
  });

  it('handles extra data wrapper (real response has data.data.xxx)', () => {
    const data = {
      data: {
        data: {
          home: {
            home_timeline_urt: {
              instructions: [{ type: 'TimelineAddEntries', entries: [] }],
            },
          },
        },
      },
    };
    const result = findInstructions(data);
    expect(result).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// parseGraphQLTimeline — fixture-driven tests
// ---------------------------------------------------------------------------

// Load real tweet variants from fixture file
interface FixtureEntry {
  _variant: string;
  tweet_results: { result: Record<string, unknown> };
  promotedMetadata?: unknown;
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

function wrapAsListTimeline(itemContent: FixtureEntry | Record<string, unknown>): string {
  return JSON.stringify({
    data: {
      list: {
        tweets_timeline: {
          timeline: {
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
    },
  });
}

function wrapAsCommunityTimeline(itemContent: FixtureEntry | Record<string, unknown>): string {
  return JSON.stringify({
    data: {
      communityResults: {
        result: {
          ranked_community_timeline: {
            timeline: {
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
      },
    },
  });
}

function fixturesByPattern(pattern: string): FixtureEntry[] {
  return allFixtures.filter(f => f._variant.includes(pattern));
}

/** Filter out fixtures that are expected to produce 0 tweets (promoted ads, tombstones). */
function parseable(fixtures: FixtureEntry[]): FixtureEntry[] {
  return fixtures.filter(f => !f.promotedMetadata && !f._variant.startsWith('tombstone'));
}

describe('parseGraphQLTimeline (real fixtures)', () => {
  it('all variants parse without throwing', () => {
    let parsed = 0;
    for (const fixture of allFixtures) {
      const body = wrapAsTimeline(fixture);
      const tweets = parseGraphQLTimeline(body);
      parsed += tweets.length;
    }
    expect(parsed).toBeGreaterThan(0);
  });

  describe('original tweets', () => {
    const originals = parseable(fixturesByPattern('|original|'));

    it('extracts author, text, metrics, and timestamp', () => {
      expect(originals.length).toBeGreaterThan(0);
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
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
        expect(typeof tweets[0].views, fixture._variant).toBe('number');
      }
    });
  });

  describe('retweets', () => {
    const retweets = parseable(fixturesByPattern('|retweet|'));

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
    const quotes = parseable(fixturesByPattern('|quote|'));

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
      const fixtures = parseable(fixturesByPattern('following:true')).filter(f => !f._variant.includes('retweet'));
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
        expect(tweets[0].following, fixture._variant).toBe(true);
      }
    });

    it('extracts following=false from relationship_perspectives', () => {
      const fixtures = parseable(fixturesByPattern('following:false'));
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
        expect(tweets[0].following, fixture._variant).toBe(false);
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
      const fixtures = parseable(fixturesByPattern('media:photo'));
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
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
      const fixtures = parseable(fixturesByPattern('media:video'));
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
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
    const noteTweets = parseable(fixturesByPattern('note_tweet'));

    it('prefers note_tweet text over legacy full_text', () => {
      expect(noteTweets.length).toBeGreaterThan(0);
      for (const fixture of noteTweets) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
        // Note tweets typically have longer text than legacy truncation
        expect(tweets[0].text, fixture._variant).toBeTruthy();
      }
    });
  });

  describe('URL expansion', () => {
    const withUrls = parseable(fixturesByPattern('has_urls'));

    it('expands t.co links into links array', () => {
      expect(withUrls.length).toBeGreaterThan(0);
      for (const fixture of withUrls) {
        const tweets = parseGraphQLTimeline(wrapAsTimeline(fixture));
        expect(tweets.length, fixture._variant).toBe(1);
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
    const wrapped = parseable(fixturesByPattern('wrapped|'));

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

  describe('promoted tweets', () => {
    const promoted = allFixtures.filter(f => !!f.promotedMetadata);

    it('skips promoted tweets (returns empty array)', () => {
      if (promoted.length === 0) return; // no promoted fixtures captured yet
      for (const fixture of promoted) {
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
// parseGraphQLTimeline — cross response shapes
// ---------------------------------------------------------------------------

describe('parseGraphQLTimeline across response shapes', () => {
  const fixture = allFixtures.find(f => f._variant.includes('original'));

  it('parses Home timeline response', () => {
    const body = wrapAsTimeline(fixture!);
    const result = parseGraphQLTimeline(body);
    expect(result.length).toBeGreaterThan(0);
  });

  it('parses List timeline response', () => {
    const body = wrapAsListTimeline(fixture!);
    const result = parseGraphQLTimeline(body);
    expect(result.length).toBeGreaterThan(0);
  });

  it('parses Community timeline response', () => {
    const body = wrapAsCommunityTimeline(fixture!);
    const result = parseGraphQLTimeline(body);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty array for non-timeline response', () => {
    const body = JSON.stringify({ data: { viewer: {} } });
    expect(parseGraphQLTimeline(body)).toEqual([]);
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
            instructions: [{ type: 'TimelineAddEntries', entries }],
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
              type: 'TimelineAddEntries',
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

describe('parseTweetDetail', () => {

  it('extracts anchor and replies from initial response', () => {
    const body = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-initial.json'), 'utf-8',
    );
    const result = parseTweetDetail(body);

    expect(result.anchor).not.toBeNull();
    expect(result.anchor!.authorHandle).toBe('shawn_pana');
    expect(result.replies.length).toBeGreaterThan(0);
    // Replies should not include the anchor tweet
    expect(result.replies.every(r => r.url !== result.anchor!.url)).toBe(true);
    // No recommended tweets (tweetdetailrelatedtweets) in replies
    expect(result.hasCursor).toBe(true);
  });

  it('returns null anchor for incremental response', () => {
    const body = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-incremental.json'), 'utf-8',
    );
    const result = parseTweetDetail(body);

    expect(result.anchor).toBeNull();
    expect(result.replies.length).toBeGreaterThan(0);
  });

  it('extracts replies with inReplyTo field', () => {
    const body = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-initial.json'), 'utf-8',
    );
    const result = parseTweetDetail(body);

    // At least some replies should have inReplyTo
    const withInReplyTo = result.replies.filter(r => r.inReplyTo != null);
    expect(withInReplyTo.length).toBeGreaterThan(0);
    expect(withInReplyTo[0].inReplyTo!.handle).toBe('shawn_pana');
  });

  it('returns empty result for malformed body', () => {
    const result = parseTweetDetail('{}');
    expect(result.anchor).toBeNull();
    expect(result.replies).toEqual([]);
    expect(result.hasCursor).toBe(false);
  });
});

describe('GRAPHQL_PROFILE_PATTERN', () => {
  it('matches UserByScreenName URL', () => {
    const url = '/i/api/graphql/IGgvgiOx4QZndDHuD3x9TQ/UserByScreenName?variables=...';
    expect(GRAPHQL_PROFILE_PATTERN.test(url)).toBe(true);
  });

  it('does not match timeline URL', () => {
    const url = '/i/api/graphql/abc123/HomeTimeline?variables=...';
    expect(GRAPHQL_PROFILE_PATTERN.test(url)).toBe(false);
  });
});

describe('extractUserProfile', () => {
  it('extracts all fields from a GraphQL user result object', () => {
    const goldenPath = path.join(__dirname, 'fixtures/golden/profile-sample.json');
    const raw = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));
    const result = raw.data.user.result;

    const profile: UserProfile = extractUserProfile(result);

    expect(profile.userId).toBe('1590927428');
    expect(profile.handle).toBe('hwwaanng');
    expect(profile.displayName).toBe('Hwang');
    expect(profile.bio).toContain('AI Startup');
    expect(profile.website).toBe('https://hwang.fun');
    expect(profile.location).toBe('Shanghai');
    expect(profile.avatarUrl).toBe('https://pbs.twimg.com/profile_images/1361512556930600969/LBwP2_YZ.jpg');
    expect(profile.followersCount).toBe(20458);
    expect(profile.followingCount).toBe(3785);
    expect(profile.tweetsCount).toBe(8120);
    expect(profile.likesCount).toBe(23244);
    expect(profile.verified).toBe(true);
    expect(profile.createdAt).toBe('Sat Jul 13 12:35:29 +0000 2013');
    expect(profile.bannerUrl).toContain('profile_banners');
  });

  it('handles missing optional fields gracefully', () => {
    const minimal = {
      rest_id: '999',
      core: { screen_name: 'minimal', name: 'Min', created_at: 'Mon Jan 01 00:00:00 +0000 2024' },
      legacy: {
        description: '',
        followers_count: 0,
        friends_count: 0,
        statuses_count: 0,
        favourites_count: 0,
      },
    };
    const profile = extractUserProfile(minimal);
    expect(profile.avatarUrl).toBeUndefined();
    expect(profile.website).toBeUndefined();
    expect(profile.location).toBeUndefined();
    expect(profile.bannerUrl).toBeUndefined();
    expect(profile.verified).toBe(false);
    expect(profile.handle).toBe('minimal');
  });
});

describe('parseProfileResponse', () => {
  const goldenPath = path.join(__dirname, 'fixtures/golden/profile-sample.json');
  const goldenBody = fs.readFileSync(goldenPath, 'utf-8');

  it('parses full profile with relationship', () => {
    const result: ProfileResult = parseProfileResponse(goldenBody);

    expect(result.user.handle).toBe('hwwaanng');
    expect(result.relationship).not.toBeNull();
    expect(result.relationship!.youFollowThem).toBe(false);
    expect(result.relationship!.theyFollowYou).toBe(false);
    expect(result.relationship!.blocking).toBe(false);
    expect(result.relationship!.muting).toBe(false);
  });

  it('returns null relationship for self-profile', () => {
    const result = parseProfileResponse(goldenBody, 'hwwaanng');
    expect(result.relationship).toBeNull();
  });

  it('self-profile detection is case-insensitive', () => {
    const result = parseProfileResponse(goldenBody, 'HWWAANNG');
    expect(result.relationship).toBeNull();
  });

  it('throws on empty response', () => {
    expect(() => parseProfileResponse('{}')).toThrow('No user data');
  });
});

describe('GRAPHQL_FOLLOW_LIST_PATTERN', () => {
  it('matches Following URL', () => {
    const url = '/i/api/graphql/vWCjN9gcTJiXzzMPR5Oxzw/Following?variables=...';
    expect(GRAPHQL_FOLLOW_LIST_PATTERN.test(url)).toBe(true);
  });

  it('matches Followers URL', () => {
    const url = '/i/api/graphql/abc123/Followers?variables=...';
    expect(GRAPHQL_FOLLOW_LIST_PATTERN.test(url)).toBe(true);
  });

  it('does not match timeline URL', () => {
    const url = '/i/api/graphql/abc123/HomeTimeline?variables=...';
    expect(GRAPHQL_FOLLOW_LIST_PATTERN.test(url)).toBe(false);
  });

  it('does not match UserByScreenName URL', () => {
    const url = '/i/api/graphql/abc/UserByScreenName?variables=...';
    expect(GRAPHQL_FOLLOW_LIST_PATTERN.test(url)).toBe(false);
  });
});

describe('parseFollowListResponse', () => {
  const goldenPath = path.join(__dirname, 'fixtures/golden/following-sample.json');
  const goldenBody = fs.readFileSync(goldenPath, 'utf-8');

  it('extracts all users from a Following response', () => {
    const users = parseFollowListResponse(goldenBody);
    expect(users.length).toBe(5);
    expect(users[0].handle).toBe('Oracle');
    expect(users[0].followersCount).toBe(825903);
    expect(users[0].verified).toBe(false);
  });

  it('each user has all UserProfile fields', () => {
    const users = parseFollowListResponse(goldenBody);
    for (const u of users) {
      expect(u.userId).toBeDefined();
      expect(u.handle).toBeDefined();
      expect(u.displayName).toBeDefined();
      expect(typeof u.followersCount).toBe('number');
      expect(typeof u.followingCount).toBe('number');
      expect(typeof u.tweetsCount).toBe('number');
      expect(typeof u.verified).toBe('boolean');
      expect(u.createdAt).toBeDefined();
    }
  });

  it('returns empty array when no user entries', () => {
    const emptyBody = JSON.stringify({
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [
                  { type: 'TimelineClearCache' },
                  { type: 'TimelineAddEntries', entries: [
                    { content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'abc' } },
                    { content: { entryType: 'TimelineTimelineCursor', cursorType: 'Top', value: 'xyz' } },
                  ]},
                ],
              },
            },
          },
        },
      },
    });
    const users = parseFollowListResponse(emptyBody);
    expect(users).toEqual([]);
  });

  it('throws on missing timeline data', () => {
    expect(() => parseFollowListResponse('{}')).toThrow('No timeline data');
  });

  it('skips entries without user_results', () => {
    const body = JSON.stringify({
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [
                  { type: 'TimelineAddEntries', entries: [
                    { content: { entryType: 'TimelineTimelineItem', itemContent: {} } },
                    { content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'abc' } },
                  ]},
                ],
              },
            },
          },
        },
      },
    });
    const users = parseFollowListResponse(body);
    expect(users).toEqual([]);
  });
});

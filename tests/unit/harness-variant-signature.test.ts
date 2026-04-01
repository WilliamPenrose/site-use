import { describe, it, expect } from 'vitest';
import { computeTimelineVariantSignature } from '../../src/sites/twitter/variant-signature.js';

describe('computeTimelineVariantSignature', () => {
  it('produces direct|original for a basic tweet', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          core: { user_results: { result: { relationship_perspectives: { following: false } } } },
          legacy: { full_text: 'hello' },
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toBe('direct|original|following:false');
  });

  it('detects wrapped tweets', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'TweetWithVisibilityResults',
          tweet: {
            core: { user_results: { result: { relationship_perspectives: { following: true } } } },
            legacy: { full_text: 'hi' },
          },
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toBe('wrapped|original|following:true');
  });

  it('detects retweet', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          core: { user_results: { result: { relationship_perspectives: { following: true } } } },
          legacy: {
            full_text: 'RT @other: hi',
            retweeted_status_result: { result: {} },
          },
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toContain('retweet');
  });

  it('detects quote tweet', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          core: { user_results: { result: { relationship_perspectives: { following: false } } } },
          legacy: { full_text: 'my take', is_quote_status: true },
          quoted_status_result: { result: {} },
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toContain('quote');
  });

  it('detects media:photo', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          core: { user_results: { result: { relationship_perspectives: { following: true } } } },
          legacy: {
            full_text: 'pic',
            extended_entities: { media: [{ type: 'photo' }] },
          },
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toContain('media:photo');
  });

  it('detects media:video', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          core: { user_results: { result: { relationship_perspectives: { following: false } } } },
          legacy: {
            full_text: 'vid',
            extended_entities: { media: [{ type: 'video' }] },
          },
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toContain('media:video');
  });

  it('detects media:gif for animated_gif', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          core: { user_results: { result: { relationship_perspectives: { following: false } } } },
          legacy: {
            full_text: 'gif',
            extended_entities: { media: [{ type: 'animated_gif' }] },
          },
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toContain('media:gif');
  });

  it('detects note_tweet', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          core: { user_results: { result: { relationship_perspectives: { following: true } } } },
          legacy: { full_text: 'long' },
          note_tweet: { note_tweet_results: { result: { text: 'very long text' } } },
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toContain('note_tweet');
  });

  it('detects has_urls', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          core: { user_results: { result: { relationship_perspectives: { following: false } } } },
          legacy: {
            full_text: 'check this',
            entities: { urls: [{ expanded_url: 'https://example.com' }] },
          },
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toContain('has_urls');
  });

  it('detects tombstone', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'TweetTombstone',
        },
      },
    };
    expect(computeTimelineVariantSignature(entry)).toBe('tombstone');
  });

  it('produces combined signature with pipe separators', () => {
    const entry = {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          core: { user_results: { result: { relationship_perspectives: { following: false } } } },
          legacy: {
            full_text: 'hey',
            entities: { urls: [{ expanded_url: 'https://example.com' }] },
            extended_entities: { media: [{ type: 'photo' }] },
          },
          note_tweet: { note_tweet_results: { result: { text: 'long' } } },
        },
      },
    };
    const sig = computeTimelineVariantSignature(entry);
    expect(sig).toBe('direct|original|following:false|media:photo|note_tweet|has_urls');
  });
});

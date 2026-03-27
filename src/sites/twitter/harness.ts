// src/sites/twitter/harness.ts
import type { SiteHarnessDescriptor } from '../../harness/types.js';
import type { RawTweetData } from './types.js';
import { extractTweetFromItemContent, parseTweet } from './extractors.js';
import { tweetToFeedItem } from './feed-item.js';
import { feedItemsToIngestItems } from './store-adapter.js';
import { twitterDisplaySchema } from './display.js';
import { formatTweetText } from './format.js';
import { computeTimelineVariantSignature } from './variant-signature.js';
import {
  surfacedByNotEmpty,
  quotedTweetExists,
  hasPhotoMedia,
  photoHasDimensions,
  photoUrlValid,
  hasVideoMedia,
  videoHasDuration,
  videoUrlNotEmpty,
  linksArrayNotEmpty,
  noTcoInLinks,
  textTcoReplaced,
  followingIsTrue,
  followingIsFalse,
  textLongerThanLegacyLimit,
  layer1ReturnsEmpty,
  outputMatchesDirectEquivalent,
  formatContainsRetweetLine,
  formatContainsQuoteBlock,
  formatContainsAuthor,
  formatContainsTimestamp,
  formatContainsMetrics,
} from './harness-assertions.js';

// ---------------------------------------------------------------------------
// Entry extraction — mirrors parseGraphQLTimeline but only extracts itemContent
// objects without parsing them into RawTweetData.
// ---------------------------------------------------------------------------

function extractTimelineEntries(responseBody: string): unknown[] {
  const data = JSON.parse(responseBody);
  const instructions = data?.data?.home?.home_timeline_urt?.instructions ?? [];
  const entries: unknown[] = [];

  for (const instruction of instructions) {
    if (instruction.type === 'TimelineAddToModule') {
      for (const moduleItem of instruction.moduleItems ?? []) {
        const itemContent = moduleItem?.item?.itemContent;
        if (itemContent?.__typename === 'TimelineTweet') {
          entries.push(itemContent);
        }
      }
    } else if (instruction.type === 'TimelinePinEntry') {
      const content = instruction.entry?.content;
      if (content?.entryType === 'TimelineTimelineItem' && content.itemContent) {
        entries.push(content.itemContent);
      }
    } else {
      for (const entry of instruction.entries ?? []) {
        const content = entry.content;
        if (!content) continue;
        if (content.entryType === 'TimelineTimelineItem' && content.itemContent) {
          entries.push(content.itemContent);
        } else if (content.entryType === 'TimelineTimelineModule') {
          for (const moduleItem of content.items ?? []) {
            const itemContent = moduleItem?.item?.itemContent;
            if (itemContent?.__typename === 'TimelineTweet') {
              entries.push(itemContent);
            }
          }
        }
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

export const twitterHarness: SiteHarnessDescriptor = {
  domains: {
    timeline: {
      extractEntries: extractTimelineEntries,
      parseEntry: (rawEntry: unknown) => {
        const results: RawTweetData[] = [];
        extractTweetFromItemContent(rawEntry as any, results);
        return results[0] ?? null;
      },
      toFeedItem: (parsed: unknown) => {
        const raw = parsed as RawTweetData;
        return tweetToFeedItem(parseTweet(raw));
      },
      variantSignature: computeTimelineVariantSignature,
      assertions: {
        'retweet': [surfacedByNotEmpty],
        'quote': [quotedTweetExists],
        'media:photo': [hasPhotoMedia, photoHasDimensions, photoUrlValid],
        'media:video': [hasVideoMedia, videoHasDuration, videoUrlNotEmpty],
        'has_urls': [linksArrayNotEmpty, noTcoInLinks, textTcoReplaced],
        'following:true': [followingIsTrue],
        'following:false': [followingIsFalse],
        'note_tweet': [textLongerThanLegacyLimit],
        'wrapped': [outputMatchesDirectEquivalent],
        'tombstone': [layer1ReturnsEmpty],
      },
    },
  },
  storeAdapter: feedItemsToIngestItems,
  displaySchema: twitterDisplaySchema,
  formatFn: formatTweetText,
  formatAssertions: {
    'retweet': [formatContainsRetweetLine],
    'quote': [formatContainsQuoteBlock],
    '*': [formatContainsAuthor, formatContainsTimestamp, formatContainsMetrics],
  },
};

// src/sites/twitter/store-adapter.ts
import type { FeedItem } from '../../registry/types.js';
import type { IngestItem, MetricEntry } from '../../storage/types.js';
import { canonicalizeTab } from './canonicalize.js';

export function feedItemsToIngestItems(
  items: FeedItem[],
  context?: Record<string, unknown>,
): IngestItem[] {
  return items.map((item) => {
    const meta = item.siteMeta as Record<string, unknown>;
    const mentions = extractMentions(item.text);
    if (typeof meta.surfacedBy === 'string') mentions.push(meta.surfacedBy);
    const qt = meta.quotedTweet as Record<string, unknown> | undefined;
    if (qt) {
      const qtAuthor = qt.author as Record<string, unknown> | undefined;
      if (qtAuthor && typeof qtAuthor.handle === 'string') mentions.push(qtAuthor.handle);
    }
    const inReplyTo = meta.inReplyTo as { handle: string; tweetId: string } | undefined;
    if (inReplyTo?.handle) mentions.push(inReplyTo.handle);
    const uniqueMentions = [...new Set(mentions)];

    const metrics = extractMetricsFromSiteMeta(meta);
    if (typeof meta.surfaceReason === 'string') {
      metrics.push({ metric: 'surface_reason', strValue: meta.surfaceReason });
    }
    if (typeof meta.following === 'boolean') {
      metrics.push({ metric: 'following', numValue: meta.following ? 1 : 0 });
    }
    return {
      site: 'twitter',
      id: item.id,
      text: item.text,
      author: item.author.handle,
      timestamp: item.timestamp,
      url: item.url,
      rawJson: JSON.stringify(item),
      mentions: uniqueMentions,
      hashtags: extractHashtags(item.text),
      metrics,
      sourceTabs:
        typeof context?.tab === 'string' && context.tab.length > 0
          ? [canonicalizeTab(context.tab)]
          : undefined,
    };
  });
}

function extractMetricsFromSiteMeta(meta: Record<string, unknown>): MetricEntry[] {
  const keys = ['likes', 'retweets', 'replies', 'views', 'bookmarks', 'quotes'];
  const entries: MetricEntry[] = [];
  for (const key of keys) {
    const val = meta[key];
    if (typeof val === 'number') {
      entries.push({ metric: key, numValue: val });
    }
  }
  return entries;
}

function extractMentions(text: string): string[] {
  const matches = text.matchAll(/@(\w+)/g);
  return [...matches].map((m) => m[1]);
}

function extractHashtags(text: string): string[] {
  const matches = text.matchAll(/#(\w+)/g);
  return [...matches].map((m) => m[1].toLowerCase());
}

import { z } from 'zod';
import type { Tweet } from './types.js';
import type { FeedItem } from '../../registry/types.js';

export const TwitterSiteMetaSchema = z.object({
  likes: z.number().optional(),
  retweets: z.number().optional(),
  replies: z.number().optional(),
  views: z.number().optional(),
  bookmarks: z.number().optional(),
  quotes: z.number().optional(),
  following: z.boolean(),
  isRetweet: z.boolean(),
  isAd: z.boolean(),
  surfaceReason: z.enum(['original', 'retweet', 'quote', 'reply']),
  surfacedBy: z.string().optional(),
  quotedTweet: z.unknown().optional(),
  inReplyTo: z.object({ handle: z.string(), tweetId: z.string() }).optional(),
});

export type TwitterSiteMeta = z.infer<typeof TwitterSiteMetaSchema>;

export function tweetToFeedItem(tweet: Tweet): FeedItem {
  const siteMeta: TwitterSiteMeta = {
    likes: tweet.metrics.likes,
    retweets: tweet.metrics.retweets,
    replies: tweet.metrics.replies,
    views: tweet.metrics.views,
    bookmarks: tweet.metrics.bookmarks,
    quotes: tweet.metrics.quotes,
    following: tweet.author.following,
    isRetweet: tweet.isRetweet,
    isAd: tweet.isAd,
    surfaceReason: tweet.surfaceReason,
    surfacedBy: tweet.surfacedBy,
    quotedTweet: tweet.quotedTweet,
    inReplyTo: tweet.inReplyTo,
  };

  TwitterSiteMetaSchema.parse(siteMeta);

  return {
    id: tweet.id,
    author: { handle: tweet.author.handle, name: tweet.author.name },
    text: tweet.text,
    timestamp: tweet.timestamp,
    url: tweet.url,
    media: tweet.media,
    links: tweet.links,
    siteMeta,
  };
}

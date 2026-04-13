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
  inReplyTo: z.object({ handle: z.string(), tweetId: z.string(), text: z.string().optional() }).optional(),
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
    ...(tweet.surfacedBy !== undefined && { surfacedBy: tweet.surfacedBy }),
    ...(tweet.quotedTweet !== undefined && { quotedTweet: tweet.quotedTweet }),
    ...(tweet.inReplyTo !== undefined && { inReplyTo: tweet.inReplyTo }),
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
    ...(tweet.inReplyTo !== undefined && {
      inReplyTo: {
        handle: tweet.inReplyTo.handle,
        id: tweet.inReplyTo.tweetId,
        ...(tweet.inReplyTo.text !== undefined && { text: tweet.inReplyTo.text }),
      },
    }),
  };
}

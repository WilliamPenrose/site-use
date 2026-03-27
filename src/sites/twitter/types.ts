import { z } from 'zod';

// --- TweetAuthor ---

export const TweetAuthorSchema = z.object({
  handle: z.string(),
  name: z.string(),
  following: z.boolean(),
});

export type TweetAuthor = z.infer<typeof TweetAuthorSchema>;

// --- TweetMedia ---

export const TweetMediaSchema = z.object({
  type: z.enum(['photo', 'video', 'gif']),
  url: z.string(),
  width: z.number(),
  height: z.number(),
  duration: z.number().optional(),
  thumbnailUrl: z.string().optional(),
});

export type TweetMedia = z.infer<typeof TweetMediaSchema>;

// --- Shared enums ---

export const SurfaceReasonSchema = z.enum(['original', 'retweet', 'quote', 'reply']);

export const InReplyToSchema = z.object({
  handle: z.string(),
  tweetId: z.string(),
});

// --- Tweet ---

export const TweetMetricsSchema = z.object({
  likes: z.number().optional(),
  retweets: z.number().optional(),
  replies: z.number().optional(),
  views: z.number().optional(),
  bookmarks: z.number().optional(),
  quotes: z.number().optional(),
});

export interface Tweet {
  id: string;
  author: TweetAuthor;
  text: string;
  timestamp: string;
  url: string;
  metrics: z.infer<typeof TweetMetricsSchema>;
  media: TweetMedia[];
  links: string[];
  isRetweet: boolean;
  isAd: boolean;
  surfaceReason: 'original' | 'retweet' | 'quote' | 'reply';
  surfacedBy?: string;
  quotedTweet?: Tweet;
  inReplyTo?: { handle: string; tweetId: string };
}

export const TweetSchema: z.ZodType<Tweet> = z.object({
  id: z.string(),
  author: TweetAuthorSchema,
  text: z.string(),
  timestamp: z.string(),
  url: z.string(),
  metrics: TweetMetricsSchema,
  media: z.array(TweetMediaSchema),
  links: z.array(z.string()),
  isRetweet: z.boolean(),
  isAd: z.boolean(),
  surfaceReason: SurfaceReasonSchema,
  surfacedBy: z.string().optional(),
  quotedTweet: z.lazy((): z.ZodType<Tweet> => TweetSchema).optional(),
  inReplyTo: InReplyToSchema.optional(),
});

// --- RawTweetData (browser-side extraction output) ---

export const RawTweetMediaSchema = z.object({
  type: z.enum(['photo', 'video', 'animated_gif']),
  mediaUrl: z.string(),
  width: z.number(),
  height: z.number(),
  durationMs: z.number().optional(),
  videoUrl: z.string().optional(),
});

export type RawTweetMedia = z.infer<typeof RawTweetMediaSchema>;

export interface RawTweetData {
  authorHandle: string;
  authorName: string;
  following: boolean;
  text: string;
  timestamp: string;
  url: string;
  likes: number;
  retweets: number;
  replies: number;
  views?: number;
  bookmarks?: number;
  quotes?: number;
  media: RawTweetMedia[];
  links: string[];
  isRetweet: boolean;
  isAd: boolean;
  surfaceReason: 'original' | 'retweet' | 'quote' | 'reply';
  surfacedBy?: string;
  quotedTweet?: RawTweetData;
  inReplyTo?: { handle: string; tweetId: string };
}

export const RawTweetDataSchema: z.ZodType<RawTweetData> = z.object({
  authorHandle: z.string(),
  authorName: z.string(),
  following: z.boolean(),
  text: z.string(),
  timestamp: z.string(),
  url: z.string(),
  likes: z.number(),
  retweets: z.number(),
  replies: z.number(),
  views: z.number().optional(),
  bookmarks: z.number().optional(),
  quotes: z.number().optional(),
  media: z.array(RawTweetMediaSchema),
  links: z.array(z.string()),
  isRetweet: z.boolean(),
  isAd: z.boolean(),
  surfaceReason: SurfaceReasonSchema,
  surfacedBy: z.string().optional(),
  quotedTweet: z.lazy((): z.ZodType<RawTweetData> => RawTweetDataSchema).optional(),
  inReplyTo: InReplyToSchema.optional(),
});

// --- FeedMeta ---

export const FeedMetaSchema = z.object({
  coveredUsers: z.array(z.string()),
  timeRange: z.object({
    from: z.string(),
    to: z.string(),
  }),
});

export type FeedMeta = z.infer<typeof FeedMetaSchema>;

// --- FeedDebug ---

export interface FeedDebug {
  tabRequested: string;
  navAction: string;
  tabAction: string;
  reloadFallback: boolean;
  graphqlResponseCount: number;
  rawBeforeFilter: number;
  elapsedMs: number;
}

// --- FeedResult ---

export const FeedResultSchema = z.object({
  tweets: z.array(TweetSchema),
  meta: FeedMetaSchema,
});

export interface FeedResult {
  tweets: Tweet[];
  meta: FeedMeta;
  debug?: FeedDebug;
}

// --- TwitterFeedParams (plugin-level params schema) ---

export const TwitterFeedParamsSchema = z.object({
  count: z.number().min(1).max(100).default(20)
    .describe('Number of tweets to collect'),
  tab: z.enum(['following', 'for_you']).default('for_you')
    .describe('Which feed tab to read: "following" (chronological) or "for_you" (algorithmic)'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info (tab action, reload fallback, GraphQL counts, timing)'),
});

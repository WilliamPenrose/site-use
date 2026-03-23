import { z } from 'zod';

// --- TweetAuthor ---

export const TweetAuthorSchema = z.object({
  handle: z.string(),
  name: z.string(),
});

export type TweetAuthor = z.infer<typeof TweetAuthorSchema>;

// --- TweetMedia ---

export const TweetMediaSchema = z.object({
  type: z.enum(['photo', 'video', 'gif']),
  url: z.string(),
  width: z.number(),
  height: z.number(),
  altText: z.string().optional(),
  duration: z.number().optional(),
  thumbnailUrl: z.string().optional(),
});

export type TweetMedia = z.infer<typeof TweetMediaSchema>;

// --- Tweet ---

export const TweetMetricsSchema = z.object({
  likes: z.number().optional(),
  retweets: z.number().optional(),
  replies: z.number().optional(),
});

export const TweetSchema = z.object({
  id: z.string(),
  author: TweetAuthorSchema,
  text: z.string(),
  timestamp: z.string(),
  url: z.string(),
  metrics: TweetMetricsSchema,
  media: z.array(TweetMediaSchema),
  isRetweet: z.boolean(),
  isAd: z.boolean(),
});

export type Tweet = z.infer<typeof TweetSchema>;

// --- RawTweetData (browser-side extraction output) ---

export const RawTweetMediaSchema = z.object({
  type: z.enum(['photo', 'video', 'animated_gif']),
  mediaUrl: z.string(),
  width: z.number(),
  height: z.number(),
  altText: z.string().optional(),
  durationMs: z.number().optional(),
  videoUrl: z.string().optional(),
});

export type RawTweetMedia = z.infer<typeof RawTweetMediaSchema>;

export const RawTweetDataSchema = z.object({
  authorHandle: z.string(),
  authorName: z.string(),
  text: z.string(),
  timestamp: z.string(),
  url: z.string(),
  likes: z.number(),
  retweets: z.number(),
  replies: z.number(),
  media: z.array(RawTweetMediaSchema),
  isRetweet: z.boolean(),
  isAd: z.boolean(),
});

export type RawTweetData = z.infer<typeof RawTweetDataSchema>;

// --- TimelineMeta ---

export const TimelineMetaSchema = z.object({
  coveredUsers: z.array(z.string()),
  timeRange: z.object({
    from: z.string(),
    to: z.string(),
  }),
});

export type TimelineMeta = z.infer<typeof TimelineMetaSchema>;

// --- TimelineDebug ---

export interface TimelineDebug {
  feedRequested: string;
  navAction: string;
  tabAction: string;
  reloadFallback: boolean;
  graphqlResponseCount: number;
  rawBeforeFilter: number;
  elapsedMs: number;
}

// --- TimelineResult ---

export const TimelineResultSchema = z.object({
  tweets: z.array(TweetSchema),
  meta: TimelineMetaSchema,
});

export type TimelineResult = z.infer<typeof TimelineResultSchema> & {
  debug?: TimelineDebug;
};

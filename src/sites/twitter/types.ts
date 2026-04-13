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
  text: z.string().optional()
    .describe('Text of the replied-to tweet. Available when the API provides conversation context (e.g. profile --replies). May be absent in other contexts.'),
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
  inReplyTo?: { handle: string; tweetId: string; text?: string };
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
  inReplyTo?: { handle: string; tweetId: string; text?: string };
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
  availableTabs: z.array(z.string()).optional(),
});

export type FeedMeta = z.infer<typeof FeedMetaSchema>;

// --- FeedResult ---

export const FeedResultSchema = z.object({
  tweets: z.array(TweetSchema),
  meta: FeedMetaSchema,
});

export interface FeedResult {
  tweets: Tweet[];
  meta: FeedMeta;
}

// --- TwitterFeedParams (plugin-level params schema) ---

export const TwitterFeedParamsSchema = z.object({
  count: z.number().min(1).max(100).default(20)
    .describe('Number of tweets to collect'),
  tab: z.string().min(1).default('for_you')
    .describe('Feed tab name. "for_you" and "following" always work regardless of UI language. For pinned Lists/Communities, use the tab name as shown on the page.'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info (tab action, reload fallback, GraphQL counts, timing)'),
});

// --- TweetDetailParams ---

const TWEET_URL_PATTERN = /^https:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/;

export const TweetDetailParamsSchema = z.object({
  url: z.string()
    .regex(TWEET_URL_PATTERN, 'Must be a tweet URL (https://x.com/{handle}/status/{id})')
    .describe('Tweet URL (https://x.com/{handle}/status/{id})'),
  count: z.number().min(1).max(100).default(20)
    .describe('Maximum number of replies to return'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info'),
  dumpRaw: z.string().optional()
    .describe('Directory path to dump raw GraphQL responses'),
});

// --- TwitterSearchParams ---

export type SearchTab = 'top' | 'latest';

export const TwitterSearchParamsSchema = z.object({
  query: z.string().min(1)
    .describe('Search query (supports Twitter search operators like from:user, min_faves:100, since:2026-01-01)'),
  tab: z.enum(['top', 'latest']).default('top')
    .describe('Search tab: "top" (relevance) or "latest" (chronological)'),
  count: z.number().min(1).max(100).default(20)
    .describe('Number of tweets to collect'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info'),
  dumpRaw: z.string().optional()
    .describe('Directory path to dump raw GraphQL responses'),
});

// --- TweetDetailParsed (extractor output) ---

export interface TweetDetailParsed {
  ancestors: RawTweetData[];
  anchor: RawTweetData | null;
  replies: RawTweetData[];
  hasCursor: boolean;
}

// --- Follow/Unfollow ---

export type FollowState = 'following' | 'not_following' | 'pending';

export interface FollowResult {
  action: 'follow' | 'unfollow';
  handle: string;
  success: boolean;
  previousState: FollowState;
  resultState: FollowState;
}

export const TwitterFollowActionParamsSchema = z.object({
  handle: z.string().min(1).optional()
    .describe('Twitter handle (with or without @)'),
  url: z.string().optional()
    .describe('Profile URL as alternative to handle (e.g. https://x.com/elonmusk)'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info'),
}).refine(
  d => d.handle || d.url,
  { message: 'Either --handle or --url is required' },
);

// --- UserProfile ---

export const UserProfileSchema = z.object({
  userId: z.string(),
  handle: z.string(),
  displayName: z.string(),
  bio: z.string(),
  website: z.string().optional(),
  location: z.string().optional(),
  avatarUrl: z.string().optional(),
  followersCount: z.number(),
  followingCount: z.number(),
  tweetsCount: z.number(),
  likesCount: z.number(),
  verified: z.boolean(),
  createdAt: z.string(),
  bannerUrl: z.string().optional(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

// --- Relationship ---

export const RelationshipSchema = z.object({
  youFollowThem: z.boolean(),
  theyFollowYou: z.boolean(),
  blocking: z.boolean(),
  muting: z.boolean(),
});

export type Relationship = z.infer<typeof RelationshipSchema>;

// --- ProfileResult ---

export const ProfileResultSchema = z.object({
  user: UserProfileSchema,
  relationship: RelationshipSchema.nullable(),
});

export type ProfileResult = z.infer<typeof ProfileResultSchema>;

// --- ProfileWithTimelineResult ---

import type { FeedItem } from '../../registry/types.js';

export interface ProfileWithTimelineResult extends ProfileResult {
  posts?: FeedItem[];
  replies?: FeedItem[];
  errors?: string[];
}

// --- FollowListResult ---

export const FollowListResultSchema = z.object({
  users: z.array(UserProfileSchema),
  meta: z.object({
    totalReturned: z.number(),
    hasMore: z.boolean(),
    owner: z.string().describe('Whose following/followers list this is'),
  }),
});

export type FollowListResult = z.infer<typeof FollowListResultSchema>;

// --- TwitterProfileParams ---

export const TwitterProfileParamsSchema = z.object({
  handle: z.string().min(1).optional()
    .describe('Twitter handle (with or without @)'),
  url: z.string().optional()
    .describe('Profile URL as alternative to handle (e.g. https://x.com/elonmusk)'),
  following: z.boolean().default(false)
    .describe('List accounts this user follows'),
  followers: z.boolean().default(false)
    .describe('List accounts that follow this user'),
  posts: z.boolean().default(false)
    .describe('Include user\'s recent tweets'),
  replies: z.boolean().default(false)
    .describe('Include user\'s replies'),
  count: z.number().min(1).max(500).default(20)
    .describe('Number of items to return (with --following/--followers/--posts/--replies)'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info'),
}).refine(
  d => !(d.following && d.followers),
  { message: '--following and --followers are mutually exclusive' },
).refine(
  d => !(d.following || d.followers) || !(d.posts || d.replies),
  { message: '--following/--followers cannot be combined with --posts/--replies' },
).refine(
  d => d.following || d.followers || d.handle || d.url,
  { message: 'Either --handle/--url is required, or use --following/--followers to query self' },
).refine(
  d => !(d.posts || d.replies) || (d.handle || d.url),
  { message: '--posts/--replies require --handle or --url' },
);

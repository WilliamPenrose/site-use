// src/sites/twitter/harness-assertions.ts
import type { AssertionFn } from '../../harness/types.js';
import type { FeedItem } from '../../registry/types.js';

// ---------------------------------------------------------------------------
// Domain assertions (ctx.output is FeedItem)
// ---------------------------------------------------------------------------

/** Retweet: surfacedBy must be non-empty string. */
export const surfacedByNotEmpty: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  const surfacedBy = item.siteMeta?.surfacedBy as string | undefined;
  return surfacedBy && surfacedBy.length > 0
    ? { pass: true }
    : { pass: false, message: 'surfacedBy is empty or missing on retweet' };
};

/** Quote: siteMeta.quotedTweet must exist. */
export const quotedTweetExists: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  return item.siteMeta?.quotedTweet != null
    ? { pass: true }
    : { pass: false, message: 'quotedTweet missing on quote tweet' };
};

/** media:photo — at least one photo in media array. */
export const hasPhotoMedia: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  const hasPhoto = item.media.some((m) => m.type === 'photo');
  return hasPhoto
    ? { pass: true }
    : { pass: false, message: 'no photo media found' };
};

/** media:photo — width > 0 && height > 0. */
export const photoHasDimensions: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  const photos = item.media.filter((m) => m.type === 'photo');
  const ok = photos.every((p) => p.width > 0 && p.height > 0);
  return ok
    ? { pass: true }
    : { pass: false, message: 'photo missing valid dimensions' };
};

/** media:photo — url is non-empty string. */
export const photoUrlValid: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  const photos = item.media.filter((m) => m.type === 'photo');
  const ok = photos.every((p) => typeof p.url === 'string' && p.url.length > 0);
  return ok
    ? { pass: true }
    : { pass: false, message: 'photo has empty or missing url' };
};

/** media:video — at least one video/gif in media array. */
export const hasVideoMedia: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  const hasVideo = item.media.some((m) => m.type === 'video' || m.type === 'gif');
  return hasVideo
    ? { pass: true }
    : { pass: false, message: 'no video/gif media found' };
};

/** media:video — duration > 0 (optional for gif). */
export const videoHasDuration: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  const videos = item.media.filter((m) => m.type === 'video');
  const ok = videos.every((v) => (v.duration ?? 0) > 0);
  return ok
    ? { pass: true }
    : { pass: false, message: 'video missing duration' };
};

/** media:video — url is non-empty string. */
export const videoUrlNotEmpty: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  const vids = item.media.filter((m) => m.type === 'video' || m.type === 'gif');
  const ok = vids.every((v) => typeof v.url === 'string' && v.url.length > 0);
  return ok
    ? { pass: true }
    : { pass: false, message: 'video/gif has empty or missing url' };
};

/** has_urls — links array length > 0. */
export const linksArrayNotEmpty: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  return item.links.length > 0
    ? { pass: true }
    : { pass: false, message: 'links array is empty' };
};

/** has_urls — no links starting with https://t.co/. */
export const noTcoInLinks: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  const hasTco = item.links.some((l) => l.startsWith('https://t.co/'));
  return !hasTco
    ? { pass: true }
    : { pass: false, message: 'links array still contains t.co URLs' };
};

/** has_urls — no t.co URLs in text. */
export const textTcoReplaced: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  const hasTco = /https?:\/\/t\.co\/\w+/.test(item.text);
  return !hasTco
    ? { pass: true }
    : { pass: false, message: 'text still contains t.co URLs' };
};

/** following:true — siteMeta.following === true. */
export const followingIsTrue: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  return item.siteMeta?.following === true
    ? { pass: true }
    : { pass: false, message: 'expected following to be true' };
};

/** following:false — siteMeta.following === false. */
export const followingIsFalse: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  return item.siteMeta?.following === false
    ? { pass: true }
    : { pass: false, message: 'expected following to be false' };
};

/** note_tweet — text.length > 280. */
export const textLongerThanLegacyLimit: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  return item.text.length > 280
    ? { pass: true }
    : { pass: false, message: `text length ${item.text.length} is not > 280` };
};

/** tombstone — ctx.output == null (layer 1 returns empty). */
export const layer1ReturnsEmpty: AssertionFn = (ctx) => {
  return ctx.output == null
    ? { pass: true }
    : { pass: false, message: 'expected null output for tombstone' };
};

/** wrapped — FeedItem has valid id, author.handle, and text. */
export const outputMatchesDirectEquivalent: AssertionFn = (ctx) => {
  const item = ctx.output as FeedItem;
  if (!item) return { pass: false, message: 'output is null' };
  const ok =
    typeof item.id === 'string' && item.id.length > 0 &&
    typeof item.author?.handle === 'string' && item.author.handle.length > 0 &&
    typeof item.text === 'string' && item.text.length > 0;
  return ok
    ? { pass: true }
    : { pass: false, message: 'unwrapped FeedItem missing id, author.handle, or text' };
};

// ---------------------------------------------------------------------------
// Format assertions (ctx.output is string)
// ---------------------------------------------------------------------------

/** Formatted text includes retweet indicator. */
export const formatContainsRetweetLine: AssertionFn = (ctx) => {
  const text = ctx.output as string;
  return text.includes('↻ retweeted by')
    ? { pass: true }
    : { pass: false, message: 'formatted text missing "↻ retweeted by"' };
};

/** Formatted text includes quote block marker. */
export const formatContainsQuoteBlock: AssertionFn = (ctx) => {
  const text = ctx.output as string;
  return text.includes('┃')
    ? { pass: true }
    : { pass: false, message: 'formatted text missing quote block marker "┃"' };
};

/** Formatted text contains @author handle. */
export const formatContainsAuthor: AssertionFn = (ctx) => {
  const text = ctx.output as string;
  return /@\w+/.test(text)
    ? { pass: true }
    : { pass: false, message: 'formatted text missing @author handle' };
};

/** Formatted text contains timestamp (year or time pattern). */
export const formatContainsTimestamp: AssertionFn = (ctx) => {
  const text = ctx.output as string;
  return /\d{4}/.test(text) || /\d{1,2}:\d{2}/.test(text)
    ? { pass: true }
    : { pass: false, message: 'formatted text missing timestamp' };
};

/** Formatted text contains metrics symbols. */
export const formatContainsMetrics: AssertionFn = (ctx) => {
  const text = ctx.output as string;
  return text.includes('♡') || text.includes('↻')
    ? { pass: true }
    : { pass: false, message: 'formatted text missing metrics (♡ or ↻)' };
};

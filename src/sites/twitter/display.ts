// src/sites/twitter/display.ts
import type { DisplaySchema } from '../../display/resolve.js';

export const twitterDisplaySchema: DisplaySchema = {
  author:      { path: 'author.handle' },
  authorName:  { path: 'author.name' },
  following:   { path: 'siteMeta.following' },
  authorTag:   { path: 'siteMeta.following', format: (v) => v === false ? '[not following]' : undefined },
  text:        { path: 'text' },
  timestamp:   { path: 'timestamp' },
  url:         { path: 'url' },
  likes:       { path: 'siteMeta.likes' },
  retweets:    { path: 'siteMeta.retweets' },
  replies:     { path: 'siteMeta.replies' },
  views:       { path: 'siteMeta.views' },
  bookmarks:   { path: 'siteMeta.bookmarks' },
  quotes:      { path: 'siteMeta.quotes' },
  isRetweet:      { path: 'siteMeta.isRetweet' },
  isAd:           { path: 'siteMeta.isAd' },
  media:          { path: 'media' },
  links:          { path: 'links' },
  surfaceReason:  { path: 'siteMeta.surfaceReason' },
  surfacedBy:     { path: 'siteMeta.surfacedBy' },
  quotedTweet:    { path: 'siteMeta.quotedTweet' },
  inReplyTo:      { path: 'siteMeta.inReplyTo' },
};

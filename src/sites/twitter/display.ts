// src/sites/twitter/display.ts
import type { DisplaySchema } from '../../display/resolve.js';

export const twitterDisplaySchema: DisplaySchema = {
  author:      { path: 'author.handle' },
  authorName:  { path: 'author.name' },
  following:   { path: 'author.following' },
  authorTag:   { path: 'author.following', format: (v) => v === false ? '[not following]' : undefined },
  text:        { path: 'text' },
  timestamp:   { path: 'timestamp' },
  url:         { path: 'url' },
  likes:       { path: 'metrics.likes' },
  retweets:    { path: 'metrics.retweets' },
  replies:     { path: 'metrics.replies' },
  views:       { path: 'metrics.views' },
  bookmarks:   { path: 'metrics.bookmarks' },
  quotes:      { path: 'metrics.quotes' },
  isRetweet:   { path: 'isRetweet' },
  isAd:        { path: 'isAd' },
  media:       { path: 'media' },
  links:       { path: 'links' },
};

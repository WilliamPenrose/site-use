// src/sites/twitter/format.ts
import type { SearchResultItem } from '../../storage/types.js';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function metricsLine(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  const likes = meta.likes as number | undefined;
  const retweets = meta.retweets as number | undefined;
  const replies = meta.replies as number | undefined;
  const views = meta.views as number | undefined;

  if (likes != null) parts.push(`♡ ${formatNumber(likes)}`);
  if (retweets != null) parts.push(`↻ ${formatNumber(retweets)}`);
  if (replies != null) parts.push(`💬 ${formatNumber(replies)}`);
  if (views != null) parts.push(`👁 ${formatNumber(views)}`);

  return parts.join('  ');
}

export function formatTweetText(item: SearchResultItem): string {
  const meta = item.siteMeta ?? {};
  const reason = meta.surfaceReason as string | undefined;
  const lines: string[] = [];

  // Header: @author · date
  const headerParts: string[] = [];
  if (item.author) headerParts.push(`@${item.author}`);
  if (item.timestamp) headerParts.push(formatDate(item.timestamp));
  if (headerParts.length > 0) lines.push(headerParts.join(' · '));

  // Surface context
  if (reason === 'retweet' && meta.surfacedBy) {
    lines.push(`↻ retweeted by ${meta.surfacedBy}`);
  } else if (reason === 'reply' && meta.inReplyTo) {
    const replyTo = meta.inReplyTo as { handle: string };
    lines.push(`↩ reply to @${replyTo.handle}`);
  }

  // Body
  lines.push('');
  lines.push(item.text ?? '');

  // Quoted tweet
  const qt = meta.quotedTweet as Record<string, unknown> | undefined;
  if (qt) {
    const qtAuthor = (qt.author as Record<string, unknown>)?.handle ?? 'unknown';
    const qtText = qt.text as string ?? '';
    const qtMetrics = qt.metrics as Record<string, unknown> | undefined;
    lines.push('');
    lines.push(`  ┃ @${qtAuthor}: ${qtText}`);
    if (qtMetrics) {
      const qtParts: string[] = [];
      if (qtMetrics.likes != null) qtParts.push(`♡ ${formatNumber(qtMetrics.likes as number)}`);
      if (qtMetrics.retweets != null) qtParts.push(`↻ ${formatNumber(qtMetrics.retweets as number)}`);
      if (qtParts.length > 0) lines.push(`  ┃ ${qtParts.join('  ')}`);
    }
  }

  // Metrics
  const ml = metricsLine(meta);
  if (ml) {
    lines.push('');
    lines.push(ml);
  }

  // URL
  if (item.url) {
    lines.push(`🔗 ${item.url}`);
  }

  return lines.join('\n');
}

import { describe, it, expect } from 'vitest';
import { parseSearchArgs, formatHumanReadable, formatJson } from '../../src/cli/knowledge.js';
import type { SearchResult } from '../../src/storage/types.js';

describe('parseSearchArgs', () => {
  it('parses positional query', () => {
    const params = parseSearchArgs(['AI agent']);
    expect(params.query).toBe('AI agent');
  });

  it('parses --author flag', () => {
    const params = parseSearchArgs(['--author', 'elonmusk']);
    expect(params.author).toBe('elonmusk');
  });

  it('parses --since and --until', () => {
    const params = parseSearchArgs(['--since', '2026-03-01', '--until', '2026-03-20']);
    expect(params.since).toBe('2026-03-01');
    expect(params.until).toBe('2026-03-20');
  });

  it('parses --limit', () => {
    const params = parseSearchArgs(['--limit', '10']);
    expect(params.limit).toBe(10);
  });

  it('parses --hashtag into siteFilters', () => {
    const params = parseSearchArgs(['--hashtag', 'AI']);
    expect(params.siteFilters?.hashtag).toBe('AI');
  });

  it('parses --min-likes into siteFilters', () => {
    const params = parseSearchArgs(['--min-likes', '100']);
    expect(params.siteFilters?.minLikes).toBe(100);
  });

  it('parses combined query + flags', () => {
    const params = parseSearchArgs(['AI agent', '--author', 'elonmusk', '--limit', '5']);
    expect(params.query).toBe('AI agent');
    expect(params.author).toBe('elonmusk');
    expect(params.limit).toBe(5);
  });
});

describe('formatHumanReadable', () => {
  it('formats search results for terminal', () => {
    const result: SearchResult = {
      items: [{
        id: '1', site: 'twitter', text: 'Hello world',
        author: 'alice', timestamp: '2026-03-20T14:32:00Z',
        url: 'https://x.com/alice/status/1',
        siteMeta: { likes: 42, retweets: 8, replies: 3 },
      }],
      total: 1,
    };
    const output = formatHumanReadable(result);
    expect(output).toContain('@alice');
    expect(output).toContain('Hello world');
    expect(output).toContain('https://x.com/alice/status/1');
    expect(output).toContain('1 result');
  });
});

describe('formatJson', () => {
  it('outputs valid JSON', () => {
    const result: SearchResult = {
      items: [{ id: '1', site: 'twitter', text: 'test', author: 'a', timestamp: 't', url: 'u' }],
      total: 1,
    };
    const parsed = JSON.parse(formatJson(result));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });
});

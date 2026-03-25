import { describe, it, expect } from 'vitest';
import { parseSearchArgs, localToUtc, formatHumanReadable, formatJson } from '../../src/cli/knowledge.js';
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

  it('parses --start-date and --end-date as UTC ISO strings', () => {
    const params = parseSearchArgs(['--start-date', '2026-03-01', '--end-date', '2026-03-20']);
    expect(params.start_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(params.end_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('parses --max-results', () => {
    const params = parseSearchArgs(['--max-results', '10']);
    expect(params.max_results).toBe(10);
  });

  it('parses --hashtag as top-level param', () => {
    const params = parseSearchArgs(['--hashtag', 'AI']);
    expect(params.hashtag).toBe('AI');
  });

  it('parses --mention as top-level param (strips @)', () => {
    const params = parseSearchArgs(['--mention', '@openai']);
    expect(params.mention).toBe('openai');
  });

  it('parses --min-likes into metricFilters', () => {
    const params = parseSearchArgs(['--min-likes', '100']);
    expect(params.metricFilters).toEqual([{ metric: 'likes', op: '>=', numValue: 100 }]);
  });

  it('parses --min-retweets into metricFilters', () => {
    const params = parseSearchArgs(['--min-retweets', '50']);
    expect(params.metricFilters).toEqual([{ metric: 'retweets', op: '>=', numValue: 50 }]);
  });

  it('combines multiple metric filters', () => {
    const params = parseSearchArgs(['--min-likes', '100', '--min-retweets', '50']);
    expect(params.metricFilters).toHaveLength(2);
  });

  it('parses --fields as array', () => {
    const params = parseSearchArgs(['--fields', 'author,url,links']);
    expect(params.fields).toEqual(['author', 'url', 'links']);
  });

  it('rejects unknown fields', () => {
    parseSearchArgs(['--fields', 'author,likes']);
    expect(process.exitCode).toBe(1);
  });

  it('parses combined query + flags', () => {
    const params = parseSearchArgs(['AI agent', '--author', 'elonmusk', '--max-results', '5']);
    expect(params.query).toBe('AI agent');
    expect(params.author).toBe('elonmusk');
    expect(params.max_results).toBe(5);
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
    };
    const output = formatHumanReadable(result);
    expect(output).toContain('@alice');
    expect(output).toContain('1 result');
  });
});

describe('formatJson', () => {
  it('outputs valid JSON', () => {
    const result: SearchResult = {
      items: [{ id: '1', site: 'twitter', text: 'test', author: 'a', timestamp: 't', url: 'u' }],
    };
    const parsed = JSON.parse(formatJson(result));
    expect(parsed.items).toHaveLength(1);
  });
});

describe('localToUtc', () => {
  it('converts slash-separated date', () => {
    const result = localToUtc('2026/03/24 08');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes through invalid input', () => {
    expect(localToUtc('not-a-date')).toBe('not-a-date');
  });
});

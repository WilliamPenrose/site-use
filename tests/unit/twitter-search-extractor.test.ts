import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseGraphQLSearch } from '../../src/sites/twitter/extractors.js';

const FIXTURES_DIR = path.join(import.meta.dirname, '..', 'fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

describe('parseGraphQLSearch', () => {
  it('parses initial search response with tweets (skips user module)', () => {
    const body = readFixture('twitter-search-response-0.json');
    const results = parseGraphQLSearch(body);
    expect(results.length).toBe(3);
    for (const tweet of results) {
      expect(tweet.authorHandle).toBeTruthy();
      expect(tweet.text).toBeTruthy();
      expect(tweet.timestamp).toBeTruthy();
      expect(tweet.url).toContain('x.com');
    }
  });

  it('parses scroll (paginated) search response', () => {
    const body = readFixture('twitter-search-response-1.json');
    const results = parseGraphQLSearch(body);
    expect(results.length).toBe(3);
    for (const tweet of results) {
      expect(tweet.authorHandle).toBeTruthy();
      expect(tweet.text).toBeTruthy();
    }
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseGraphQLSearch('not json')).toEqual([]);
  });

  it('returns empty array for empty instructions', () => {
    const body = JSON.stringify({
      data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } },
    });
    expect(parseGraphQLSearch(body)).toEqual([]);
  });
});

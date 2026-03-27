import { describe, it, expect } from 'vitest';
import { parseFeedArgs } from '../../src/cli/workflow.js';

describe('parseFeedArgs', () => {
  it('parses valid args', () => {
    const result = parseFeedArgs(['--count', '10', '--tab', 'for_you', '--debug', '--json']);
    expect(result).toEqual({ count: 10, tab: 'for_you', debug: true, json: true, local: false, fetch: false, maxAge: 120 });
  });

  it('returns defaults when no args', () => {
    const result = parseFeedArgs([]);
    expect(result).toEqual({ count: 20, tab: 'for_you', debug: false, json: false, local: false, fetch: false, maxAge: 120 });
  });

  it('throws on NaN count', () => {
    expect(() => parseFeedArgs(['--count', 'abc'])).toThrow();
  });

  it('throws on count < 1', () => {
    expect(() => parseFeedArgs(['--count', '0'])).toThrow();
  });

  it('throws on count > 100', () => {
    expect(() => parseFeedArgs(['--count', '200'])).toThrow();
  });

  it('throws on invalid tab value', () => {
    expect(() => parseFeedArgs(['--tab', 'trending'])).toThrow();
  });

  it('parses --local flag', () => {
    const result = parseFeedArgs(['--local']);
    expect(result.local).toBe(true);
  });

  it('defaults local to false', () => {
    const result = parseFeedArgs([]);
    expect(result.local).toBe(false);
  });

  it('combines --local with --count and --tab', () => {
    const result = parseFeedArgs(['--local', '--count', '5', '--tab', 'for_you']);
    expect(result).toMatchObject({ local: true, count: 5, tab: 'for_you' });
  });

  it('parses --fetch flag', () => {
    const result = parseFeedArgs(['--fetch']);
    expect(result.fetch).toBe(true);
  });

  it('defaults fetch to false', () => {
    const result = parseFeedArgs([]);
    expect(result.fetch).toBe(false);
  });

  it('parses --max-age with value', () => {
    const result = parseFeedArgs(['--max-age', '60']);
    expect(result.maxAge).toBe(60);
  });

  it('defaults maxAge to 120', () => {
    const result = parseFeedArgs([]);
    expect(result.maxAge).toBe(120);
  });

  it('throws when --fetch and --local are both set', () => {
    expect(() => parseFeedArgs(['--fetch', '--local'])).toThrow('mutually exclusive');
  });

  it('throws when --local and --fetch are both set (reverse order)', () => {
    expect(() => parseFeedArgs(['--local', '--fetch'])).toThrow('mutually exclusive');
  });
});

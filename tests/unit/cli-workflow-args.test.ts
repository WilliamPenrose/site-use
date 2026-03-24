import { describe, it, expect } from 'vitest';
import { parseFeedArgs } from '../../src/cli/workflow.js';

describe('parseFeedArgs', () => {
  it('parses valid args', () => {
    const result = parseFeedArgs(['--count', '10', '--tab', 'for_you', '--debug', '--json']);
    expect(result).toEqual({ count: 10, tab: 'for_you', debug: true, json: true });
  });

  it('returns defaults when no args', () => {
    const result = parseFeedArgs([]);
    expect(result).toEqual({ count: 20, tab: 'following', debug: false, json: false });
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
});

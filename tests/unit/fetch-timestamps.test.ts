import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getLastFetchTime, setLastFetchTime, getAllTimestamps } from '../../src/fetch-timestamps.js';

describe('fetch-timestamps', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-ts-'));
    filePath = path.join(tmpDir, 'fetch-timestamps.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when file does not exist', () => {
    expect(getLastFetchTime(filePath, 'twitter', 'following')).toBeNull();
  });

  it('returns null when site key is missing', () => {
    fs.writeFileSync(filePath, JSON.stringify({ other: { x: '2026-01-01T00:00:00Z' } }));
    expect(getLastFetchTime(filePath, 'twitter', 'following')).toBeNull();
  });

  it('returns null when variant key is missing', () => {
    fs.writeFileSync(filePath, JSON.stringify({ twitter: { for_you: '2026-01-01T00:00:00Z' } }));
    expect(getLastFetchTime(filePath, 'twitter', 'following')).toBeNull();
  });

  it('returns timestamp when present', () => {
    const ts = '2026-03-25T14:30:00Z';
    fs.writeFileSync(filePath, JSON.stringify({ twitter: { following: ts } }));
    expect(getLastFetchTime(filePath, 'twitter', 'following')).toBe(ts);
  });

  it('setLastFetchTime creates file if absent', () => {
    setLastFetchTime(filePath, 'twitter', 'following');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.twitter.following).toBeDefined();
    expect(typeof data.twitter.following).toBe('string');
  });

  it('setLastFetchTime preserves other sites and variants', () => {
    fs.writeFileSync(filePath, JSON.stringify({
      twitter: { for_you: '2026-01-01T00:00:00Z' },
      xiaohongshu: { discover: '2026-02-01T00:00:00Z' },
    }));
    setLastFetchTime(filePath, 'twitter', 'following');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.twitter.for_you).toBe('2026-01-01T00:00:00Z');
    expect(data.xiaohongshu.discover).toBe('2026-02-01T00:00:00Z');
    expect(data.twitter.following).toBeDefined();
  });
});

describe('getAllTimestamps', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-ts-'));
    filePath = path.join(tmpDir, 'fetch-timestamps.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when file does not exist', () => {
    const result = getAllTimestamps(filePath);
    expect(result).toEqual({});
  });

  it('returns all site/variant timestamps', () => {
    setLastFetchTime(filePath, 'twitter', 'following');
    setLastFetchTime(filePath, 'twitter', 'for_you');
    setLastFetchTime(filePath, 'xhs', 'discover');

    const result = getAllTimestamps(filePath);
    expect(Object.keys(result)).toEqual(['twitter', 'xhs']);
    expect(Object.keys(result.twitter)).toEqual(['following', 'for_you']);
    expect(Object.keys(result.xhs)).toEqual(['discover']);
    // Values are ISO strings
    expect(new Date(result.twitter.following).getTime()).toBeGreaterThan(0);
  });
});

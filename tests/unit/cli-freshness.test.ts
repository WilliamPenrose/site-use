import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkFreshness, formatAge } from '../../src/cli/freshness.js';

describe('checkFreshness', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-'));
    filePath = path.join(tmpDir, 'fetch-timestamps.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns no_data when file does not exist', () => {
    const result = checkFreshness(tmpDir, 'twitter', 'following', 120);
    expect(result).toEqual({ shouldFetch: true, reason: 'no_data' });
  });

  it('returns no_data when variant key is missing', () => {
    fs.writeFileSync(filePath, JSON.stringify({ twitter: { for_you: '2026-01-01T00:00:00Z' } }));
    const result = checkFreshness(tmpDir, 'twitter', 'following', 120);
    expect(result).toEqual({ shouldFetch: true, reason: 'no_data' });
  });

  it('returns stale when timestamp exceeds max age', () => {
    const old = new Date(Date.now() - 180 * 60_000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify({ twitter: { following: old } }));
    const result = checkFreshness(tmpDir, 'twitter', 'following', 120);
    expect(result.shouldFetch).toBe(true);
    expect(result.reason).toBe('stale');
    expect(result.ageMinutes).toBeGreaterThanOrEqual(179);
  });

  it('returns fresh when timestamp is within max age', () => {
    const recent = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify({ twitter: { following: recent } }));
    const result = checkFreshness(tmpDir, 'twitter', 'following', 120);
    expect(result.shouldFetch).toBe(false);
    expect(result.reason).toBe('fresh');
    expect(result.ageMinutes).toBeLessThanOrEqual(11);
  });

  it('returns stale when max-age is 0 (always stale)', () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify({ twitter: { following: recent } }));
    const result = checkFreshness(tmpDir, 'twitter', 'following', 0);
    expect(result.shouldFetch).toBe(true);
    expect(result.reason).toBe('stale');
  });
});

describe('formatAge', () => {
  it('formats minutes under 60', () => {
    expect(formatAge(47)).toBe('47min');
  });

  it('formats exact hours', () => {
    expect(formatAge(120)).toBe('2h');
  });

  it('formats hours with remaining minutes', () => {
    expect(formatAge(90)).toBe('1h30min');
  });

  it('formats 0 minutes', () => {
    expect(formatAge(0)).toBe('0min');
  });
});

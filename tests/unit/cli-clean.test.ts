import { describe, it, expect } from 'vitest';
import { parseCleanArgs, formatPreview, formatProgress } from '../../src/cli/clean.js';
import { utcToLocalDisplay } from '../../src/format-date.js';
import type { DeletePreview } from '../../src/storage/types.js';

describe('parseCleanArgs', () => {
  it('parses --site --before', () => {
    const result = parseCleanArgs(['--site', 'twitter', '--before', '2026-03-01']);
    expect(result.params?.site).toBe('twitter');
    expect(result.params?.before).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.noBackup).toBe(false);
  });

  it('parses --site --after --author', () => {
    const result = parseCleanArgs(['--site', 'twitter', '--after', '2026-03-20', '--author', 'alice']);
    expect(result.params?.site).toBe('twitter');
    expect(result.params?.author).toBe('alice');
    expect(result.params?.after).toBeDefined();
  });

  it('parses --ingested-before and --ingested-after', () => {
    const result = parseCleanArgs(['--site', 'twitter', '--ingested-before', '2026-03-25']);
    expect(result.params?.ingestedBefore).toBeDefined();

    const result2 = parseCleanArgs(['--site', 'twitter', '--ingested-after', '2026-03-20']);
    expect(result2.params?.ingestedAfter).toBeDefined();
  });

  it('parses --no-backup flag', () => {
    const result = parseCleanArgs(['--site', 'twitter', '--before', '2026-03-01', '--no-backup']);
    expect(result.noBackup).toBe(true);
  });

  it('errors when --site is missing', () => {
    const result = parseCleanArgs(['--before', '2026-03-01']);
    expect(result.error).toMatch(/--site is required/);
  });

  it('errors when no filter is provided', () => {
    const result = parseCleanArgs(['--site', 'twitter']);
    expect(result.error).toMatch(/at least one filter/i);
  });

  it('accepts ingested filters as valid filters', () => {
    const result = parseCleanArgs(['--site', 'twitter', '--ingested-before', '2026-03-25']);
    expect(result.error).toBeUndefined();
    expect(result.params).toBeDefined();
  });

  it('strips @ from author', () => {
    const result = parseCleanArgs(['--site', 'twitter', '--author', '@alice']);
    expect(result.params?.author).toBe('alice');
  });
});

describe('utcToLocalDisplay', () => {
  it('converts UTC ISO string to local time with timezone', () => {
    const result = utcToLocalDisplay('2026-03-01T00:00:00Z');
    // Should contain date, time, and timezone like (UTC+8) or (UTC-5) or (UTC+5:30)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d+(?::\d{2})?\)$/);
  });

  it('format is consistent across calls', () => {
    const result = utcToLocalDisplay('2026-06-15T12:30:00Z');
    expect(result).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d+(?::\d{2})?\)$/);
  });
});

describe('formatPreview', () => {
  it('formats preview with authors and local time range', () => {
    const preview: DeletePreview = {
      totalCount: 42,
      authors: [
        { handle: 'alice', count: 15 },
        { handle: 'bob', count: 12 },
        { handle: 'charlie', count: 8 },
        { handle: 'dave', count: 7 },
      ],
      timeRange: { from: '2025-12-03T00:00:00Z', to: '2026-02-28T23:59:00Z' },
    };
    const output = formatPreview('twitter', preview);
    expect(output).toContain('42 items');
    expect(output).toContain('twitter');
    expect(output).toContain('@alice (15)');
    expect(output).toContain('@bob (12)');
    // Time should show timezone ONCE at the end
    expect(output).toMatch(/UTC[+-]\d+/);
  });

  it('truncates long author lists', () => {
    const authors = Array.from({ length: 20 }, (_, i) => ({ handle: `user${i}`, count: 1 }));
    const preview: DeletePreview = {
      totalCount: 20,
      authors,
      timeRange: { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' },
    };
    const output = formatPreview('twitter', preview);
    expect(output).toContain('more');
  });
});

describe('formatProgress', () => {
  it('shows percentage and ETA', () => {
    const output = formatProgress(500, 2000, 1.2);
    expect(output).toContain('500/2000');
    expect(output).toContain('25%');
    expect(output).toMatch(/ETA/);
  });

  it('shows done when complete', () => {
    const output = formatProgress(2000, 2000, 0);
    expect(output).toContain('100%');
  });
});

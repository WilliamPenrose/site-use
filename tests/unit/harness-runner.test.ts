import { describe, it, expect } from 'vitest';
import type { FeedItem } from '../../src/registry/types.js';
import type { IngestItem, SearchResultItem } from '../../src/storage/types.js';
import type { DisplaySchema } from '../../src/display/resolve.js';
import type {
  SiteHarnessDescriptor,
  DomainDescriptor,
  AssertionFn,
  AssertionResult,
} from '../../src/harness/types.js';
import { matchAssertions, runVariant, runDomain, loadHarness } from '../../src/harness/runner.js';

// --- Mock data ---

const mockFeedItem: FeedItem = {
  id: 'test-1',
  author: { handle: 'tester', name: 'Test User' },
  text: 'hello world',
  timestamp: '2026-03-26T12:00:00Z',
  url: 'https://example.com/test-1',
  media: [],
  links: [],
  siteMeta: { likes: 10, following: true, surfaceReason: 'original', isRetweet: false, isAd: false },
};

// --- Mock descriptor factory ---

function createMockDescriptor(overrides?: {
  parseEntry?: (raw: unknown) => unknown;
  toFeedItem?: (parsed: unknown) => FeedItem;
  domainAssertions?: Record<string, AssertionFn[]>;
  formatAssertions?: Record<string, AssertionFn[]>;
}): SiteHarnessDescriptor {
  const displaySchema: DisplaySchema = {
    likes: { path: 'siteMeta.likes' },
    following: { path: 'siteMeta.following' },
  };

  const domain: DomainDescriptor = {
    extractEntries: (body: string) => JSON.parse(body),
    parseEntry: overrides?.parseEntry ?? ((raw: unknown) => raw),
    toFeedItem: overrides?.toFeedItem ?? ((_parsed: unknown) => ({ ...mockFeedItem })),
    variantSignature: (raw: unknown) => (raw as Record<string, string>)?._variant ?? 'unknown',
    assertions: overrides?.domainAssertions ?? {},
  };

  return {
    domains: { timeline: domain },
    storeAdapter: (items: FeedItem[]): IngestItem[] =>
      items.map((fi) => ({
        site: 'test-site',
        id: fi.id,
        text: fi.text,
        author: fi.author.handle,
        timestamp: fi.timestamp,
        url: fi.url,
        rawJson: JSON.stringify(fi),
        metrics: [
          { metric: 'likes', numValue: (fi.siteMeta?.likes as number) ?? 0 },
        ],
      })),
    displaySchema,
    formatFn: (item: SearchResultItem) => `@${item.author}: ${item.text}`,
    formatAssertions: overrides?.formatAssertions ?? {},
  };
}

// --- matchAssertions ---

describe('matchAssertions', () => {
  it('matches wildcard * to any non-tombstone variant', () => {
    const fn: AssertionFn = () => ({ pass: true });
    const registry: Record<string, AssertionFn[]> = { '*': [fn] };
    const matched = matchAssertions(registry, 'direct|original');
    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(fn);
  });

  it('does not match wildcard * to tombstone variant', () => {
    const fn: AssertionFn = () => ({ pass: true });
    const registry: Record<string, AssertionFn[]> = { '*': [fn] };
    const matched = matchAssertions(registry, 'tombstone');
    expect(matched).toHaveLength(0);
  });

  it('matches tag-specific assertions via substring', () => {
    const fn: AssertionFn = () => ({ pass: true });
    const registry: Record<string, AssertionFn[]> = { retweet: [fn] };
    const matched = matchAssertions(registry, 'direct|retweet');
    expect(matched).toHaveLength(1);
  });

  it('does not match unrelated tags', () => {
    const fn: AssertionFn = () => ({ pass: true });
    const registry: Record<string, AssertionFn[]> = { retweet: [fn] };
    const matched = matchAssertions(registry, 'direct|original');
    expect(matched).toHaveLength(0);
  });

  it('combines wildcard and tag-specific matches', () => {
    const fn1: AssertionFn = () => ({ pass: true });
    const fn2: AssertionFn = () => ({ pass: true });
    const registry: Record<string, AssertionFn[]> = { '*': [fn1], retweet: [fn2] };
    const matched = matchAssertions(registry, 'direct|retweet');
    expect(matched).toHaveLength(2);
  });
});

// --- runVariant ---

describe('runVariant', () => {
  it('passes all layers for a well-formed variant', async () => {
    const descriptor = createMockDescriptor();
    const result = await runVariant(descriptor, 'timeline', 'direct|original');
    expect(result.pass).toBe(true);
    expect(result.variant).toBe('direct|original');
    expect(result.layers.length).toBeGreaterThanOrEqual(5);
    for (const layer of result.layers) {
      expect(layer.pass).toBe(true);
    }
  });

  it('reports failure when parseEntry throws', async () => {
    const descriptor = createMockDescriptor({
      parseEntry: () => { throw new Error('parse boom'); },
    });
    const result = await runVariant(descriptor, 'timeline', 'direct|original');
    expect(result.pass).toBe(false);
    expect(result.failedLayer).toContain('0');
    expect(result.message).toContain('parse boom');
  });

  it('reports failure when toFeedItem throws', async () => {
    const descriptor = createMockDescriptor({
      toFeedItem: () => { throw new Error('convert boom'); },
    });
    const result = await runVariant(descriptor, 'timeline', 'direct|original');
    expect(result.pass).toBe(false);
    expect(result.failedLayer).toContain('1');
    expect(result.message).toContain('convert boom');
  });

  it('runs domain assertions and reports failure', async () => {
    const failAssertion: AssertionFn = () => ({ pass: false, message: 'bad feeditem' });
    const descriptor = createMockDescriptor({
      domainAssertions: { '*': [failAssertion] },
    });
    const result = await runVariant(descriptor, 'timeline', 'direct|original');
    expect(result.pass).toBe(false);
    expect(result.failedLayer).toContain('2');
    expect(result.message).toContain('bad feeditem');
  });

  it('runs format assertions and reports failure', async () => {
    const failAssertion: AssertionFn = () => ({ pass: false, message: 'bad format' });
    const descriptor = createMockDescriptor({
      formatAssertions: { '*': [failAssertion] },
    });
    const result = await runVariant(descriptor, 'timeline', 'direct|original');
    expect(result.pass).toBe(false);
    expect(result.failedLayer).toContain('5');
    expect(result.message).toContain('bad format');
  });

  it('skips tombstone variants after Layer 0 (parseEntry returns null)', async () => {
    const descriptor = createMockDescriptor({
      parseEntry: () => null,
    });
    const result = await runVariant(descriptor, 'timeline', 'tombstone|deleted');
    expect(result.pass).toBe(true);
    expect(result.variant).toBe('tombstone|deleted');
    // Should have Layer 0 result but stop there
    expect(result.layers.length).toBe(1);
    expect(result.layers[0].pass).toBe(true);
  });

  it('matches tag-specific assertions from variant string', async () => {
    const retweetAssertion: AssertionFn = (ctx) => {
      const fi = ctx.output as FeedItem;
      return fi.text === 'hello world'
        ? { pass: true }
        : { pass: false, message: 'unexpected text' };
    };
    const descriptor = createMockDescriptor({
      domainAssertions: { retweet: [retweetAssertion] },
    });
    // "retweet" is a substring of "direct|retweet" so it should match
    const result = await runVariant(descriptor, 'timeline', 'direct|retweet');
    expect(result.pass).toBe(true);
  });
});

// --- runDomain ---

describe('runDomain', () => {
  it('runs all variants and returns HarnessReport', async () => {
    const descriptor = createMockDescriptor();
    const variants = ['direct|original', 'direct|retweet'];
    const report = await runDomain(descriptor, 'test-site', 'timeline', variants, 'golden');
    expect(report.site).toBe('test-site');
    expect(report.domain).toBe('timeline');
    expect(report.source).toBe('golden');
    expect(report.totalVariants).toBe(2);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.results).toHaveLength(2);
    expect(report.results[0].variant).toBe('direct|original');
    expect(report.results[1].variant).toBe('direct|retweet');
  });

  it('counts failures correctly', async () => {
    const descriptor = createMockDescriptor({
      parseEntry: (raw: unknown) => {
        const variant = (raw as string);
        if (variant === 'bad') throw new Error('bad entry');
        return raw;
      },
    });
    const variants = ['good', 'bad'];
    const report = await runDomain(descriptor, 'test-site', 'timeline', variants, 'golden');
    expect(report.totalVariants).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
  });
});

// --- loadHarness ---

describe('loadHarness', () => {
  it('returns null for nonexistent site', async () => {
    const result = await loadHarness('nonexistent-site-xyz');
    expect(result).toBeNull();
  });
});

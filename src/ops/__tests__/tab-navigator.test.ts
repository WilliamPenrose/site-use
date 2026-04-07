import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { matchTab, discoverTabs, ensureTab, TabNotFoundError, type TabInfo } from '../tab-navigator.js';
import type { Primitives, Snapshot, SnapshotNode } from '../../primitives/types.js';

// Helper to create a Snapshot from a simplified map
function makeSnapshot(entries: [string, Partial<SnapshotNode>][]): Snapshot {
  const idToNode = new Map<string, SnapshotNode>();
  for (const [uid, partial] of entries) {
    idToNode.set(uid, { uid, role: '', name: '', ...partial } as SnapshotNode);
  }
  return { idToNode };
}

// Helper to create mock primitives with overrides
function createTabMockPrimitives(overrides: Partial<Primitives> = {}): Primitives {
  return {
    evaluate: vi.fn(),
    takeSnapshot: vi.fn().mockResolvedValue(makeSnapshot([])),
    click: vi.fn(),
    navigate: vi.fn(),
    scroll: vi.fn(),
    scrollIntoView: vi.fn(),
    type: vi.fn(),
    pressKey: vi.fn(),
    screenshot: vi.fn(),
    interceptRequest: vi.fn(),
    getRawPage: vi.fn(),
    ...overrides,
  } as unknown as Primitives;
}

const TWITTER_WELL_KNOWN: Record<string, number> = { for_you: 0, following: 1 };

const TAB_SELECTOR = '[role="tablist"] [role="tab"]';
const WELL_KNOWN = { for_you: 0, following: 1 };

describe('matchTab', () => {
  const tabs: TabInfo[] = [
    { name: 'For you', index: 0 },
    { name: 'Following', index: 1 },
    { name: 'vibe coding', index: 2 },
    { name: 'OpenClaw', index: 3 },
  ];

  it('matches exact name (case-insensitive)', () => {
    expect(matchTab('Following', tabs)).toEqual({ name: 'Following', index: 1 });
    expect(matchTab('following', tabs)).toEqual({ name: 'Following', index: 1 });
    expect(matchTab('FOLLOWING', tabs)).toEqual({ name: 'Following', index: 1 });
  });

  it('normalizes underscores to spaces', () => {
    expect(matchTab('for_you', tabs)).toEqual({ name: 'For you', index: 0 });
  });

  it('matches multi-word tab names', () => {
    expect(matchTab('vibe coding', tabs)).toEqual({ name: 'vibe coding', index: 2 });
    expect(matchTab('Vibe Coding', tabs)).toEqual({ name: 'vibe coding', index: 2 });
  });

  it('falls back to well-known table for non-matching text', () => {
    const jpTabs: TabInfo[] = [
      { name: 'おすすめ', index: 0 },
      { name: 'フォロー中', index: 1 },
    ];
    expect(matchTab('for_you', jpTabs, TWITTER_WELL_KNOWN)).toEqual({ name: 'おすすめ', index: 0 });
    expect(matchTab('following', jpTabs, TWITTER_WELL_KNOWN)).toEqual({ name: 'フォロー中', index: 1 });
  });

  it('prefers normalize match over well-known', () => {
    expect(matchTab('for_you', tabs, TWITTER_WELL_KNOWN)).toEqual({ name: 'For you', index: 0 });
  });

  it('throws TabNotFoundError with available tab names', () => {
    expect(() => matchTab('nonexistent', tabs, TWITTER_WELL_KNOWN))
      .toThrow(/not found/i);
    try {
      matchTab('nonexistent', tabs, TWITTER_WELL_KNOWN);
    } catch (e: any) {
      expect(e.availableTabs).toEqual(['For you', 'Following', 'vibe coding', 'OpenClaw']);
    }
  });

  it('handles Unicode NFC normalization', () => {
    const unicodeTabs: TabInfo[] = [{ name: '\u00e9', index: 0 }];
    expect(matchTab('\u0065\u0301', unicodeTabs)).toEqual({ name: '\u00e9', index: 0 });
  });

  it('works without wellKnown parameter', () => {
    expect(matchTab('OpenClaw', tabs)).toEqual({ name: 'OpenClaw', index: 3 });
    expect(() => matchTab('nonexistent', tabs)).toThrow(/not found/i);
  });
});

describe('discoverTabs', () => {
  it('returns all tabs from DOM', async () => {
    const primitives = createTabMockPrimitives({
      evaluate: vi.fn().mockResolvedValue(
        JSON.stringify([
          { name: 'For you', index: 0 },
          { name: 'Following', index: 1 },
          { name: 'vibe coding', index: 2 },
        ]),
      ),
    });

    const tabs = await discoverTabs(primitives, TAB_SELECTOR);
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toEqual({ name: 'For you', index: 0 });
    expect(tabs[2]).toEqual({ name: 'vibe coding', index: 2 });
  });

  it('polls until tabs appear in DOM', async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce('[]')  // first poll: empty
      .mockResolvedValueOnce('[]')  // second poll: empty
      .mockResolvedValue(JSON.stringify([{ name: 'For you', index: 0 }]));

    const primitives = createTabMockPrimitives({ evaluate });
    const tabs = await discoverTabs(primitives, TAB_SELECTOR, { timeoutMs: 5000, pollMs: 50 });

    expect(tabs).toHaveLength(1);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it('throws after timeout if no tabs appear', async () => {
    const primitives = createTabMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('[]'),
    });

    await expect(discoverTabs(primitives, TAB_SELECTOR, { timeoutMs: 300, pollMs: 100 }))
      .rejects.toThrow(/no tabs found/i);
  });
});

describe('ensureTab', () => {
  it('returns already_there when target tab is already selected', async () => {
    const primitives = createTabMockPrimitives({
      evaluate: vi.fn().mockResolvedValue(
        JSON.stringify([
          { name: 'For you', index: 0 },
          { name: 'Following', index: 1 },
        ]),
      ),
      takeSnapshot: vi.fn().mockResolvedValue(
        makeSnapshot([
          ['1', { role: 'tab', name: 'For you', selected: true }],
          ['2', { role: 'tab', name: 'Following', selected: false }],
        ]),
      ),
    });

    const result = await ensureTab(primitives, 'for_you', TAB_SELECTOR, WELL_KNOWN);
    expect(result.action).toBe('already_there');
    expect(result.availableTabs).toEqual(['For you', 'Following']);
  });

  it('clicks and returns transitioned when switching tabs', async () => {
    const takeSnapshot = vi.fn()
      .mockResolvedValueOnce(
        makeSnapshot([
          ['1', { role: 'tab', name: 'For you', selected: true }],
          ['2', { role: 'tab', name: 'Following', selected: false }],
        ]),
      )
      .mockResolvedValue(
        makeSnapshot([
          ['1', { role: 'tab', name: 'For you', selected: false }],
          ['2', { role: 'tab', name: 'Following', selected: true }],
        ]),
      );

    const primitives = createTabMockPrimitives({
      evaluate: vi.fn().mockResolvedValue(
        JSON.stringify([
          { name: 'For you', index: 0 },
          { name: 'Following', index: 1 },
        ]),
      ),
      takeSnapshot,
      click: vi.fn().mockResolvedValue(undefined),
    });

    const result = await ensureTab(primitives, 'following', TAB_SELECTOR, WELL_KNOWN);
    expect(result.action).toBe('transitioned');
    expect(result.availableTabs).toEqual(['For you', 'Following']);
    expect(primitives.click).toHaveBeenCalled();
  });

  it('calls scrollIntoView before clicking off-screen tab', async () => {
    const evaluateFn = vi.fn()
      .mockResolvedValueOnce(  // discoverTabs
        JSON.stringify([
          { name: 'For you', index: 0 },
          { name: 'Following', index: 1 },
          { name: 'vibe coding', index: 2 },
        ]),
      )
      .mockResolvedValueOnce(undefined);  // scrollIntoView call

    const takeSnapshot = vi.fn()
      .mockResolvedValueOnce(
        makeSnapshot([
          ['1', { role: 'tab', name: 'For you', selected: true }],
          ['2', { role: 'tab', name: 'Following', selected: false }],
          ['3', { role: 'tab', name: 'vibe coding', selected: false }],
        ]),
      )
      .mockResolvedValue(
        makeSnapshot([
          ['1', { role: 'tab', name: 'For you', selected: false }],
          ['2', { role: 'tab', name: 'Following', selected: false }],
          ['3', { role: 'tab', name: 'vibe coding', selected: true }],
        ]),
      );

    const primitives = createTabMockPrimitives({
      evaluate: evaluateFn,
      takeSnapshot,
      click: vi.fn().mockResolvedValue(undefined),
    });

    const result = await ensureTab(primitives, 'vibe coding', TAB_SELECTOR, WELL_KNOWN);
    expect(result.action).toBe('transitioned');
    // scrollIntoView called for tab at index 2
    expect(evaluateFn).toHaveBeenCalledTimes(2);
    const scrollCall = evaluateFn.mock.calls[1][0] as string;
    expect(scrollCall).toContain('scrollIntoView');
    expect(scrollCall).toContain('[2]');
  });

  it('returns availableTabs with tab names', async () => {
    const primitives = createTabMockPrimitives({
      evaluate: vi.fn().mockResolvedValue(
        JSON.stringify([
          { name: 'おすすめ', index: 0 },
          { name: 'フォロー中', index: 1 },
          { name: '花日記', index: 2 },
        ]),
      ),
      takeSnapshot: vi.fn().mockResolvedValue(
        makeSnapshot([
          ['1', { role: 'tab', name: 'おすすめ', selected: true }],
          ['2', { role: 'tab', name: 'フォロー中', selected: false }],
          ['3', { role: 'tab', name: '花日記', selected: false }],
        ]),
      ),
    });

    const result = await ensureTab(primitives, 'for_you', TAB_SELECTOR, WELL_KNOWN);
    expect(result.availableTabs).toEqual(['おすすめ', 'フォロー中', '花日記']);
    // Locale convergence: even though the DOM textContent is おすすめ, the
    // matched index (0) reverse-looks-up to the well-known key for_you.
    expect(result.wellKnownKey).toBe('for_you');
  });

  it('returns wellKnownKey for English DOM well-known tab', async () => {
    const primitives = createTabMockPrimitives({
      evaluate: vi.fn().mockResolvedValue(
        JSON.stringify([
          { name: 'For you', index: 0 },
          { name: 'Following', index: 1 },
        ]),
      ),
      takeSnapshot: vi.fn().mockResolvedValue(
        makeSnapshot([
          ['1', { role: 'tab', name: 'For you', selected: false }],
          ['2', { role: 'tab', name: 'Following', selected: true }],
        ]),
      ),
      click: vi.fn().mockResolvedValue(undefined),
    });

    const result = await ensureTab(primitives, 'following', TAB_SELECTOR, WELL_KNOWN);
    expect(result.wellKnownKey).toBe('following');
  });

  it('omits wellKnownKey for custom List tabs', async () => {
    const primitives = createTabMockPrimitives({
      evaluate: vi.fn().mockResolvedValue(
        JSON.stringify([
          { name: 'For you', index: 0 },
          { name: 'Following', index: 1 },
          { name: 'vibe coding', index: 2 },
        ]),
      ),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(
          makeSnapshot([
            ['1', { role: 'tab', name: 'For you', selected: true }],
            ['2', { role: 'tab', name: 'Following', selected: false }],
            ['3', { role: 'tab', name: 'vibe coding', selected: false }],
          ]),
        )
        .mockResolvedValue(
          makeSnapshot([
            ['1', { role: 'tab', name: 'For you', selected: false }],
            ['2', { role: 'tab', name: 'Following', selected: false }],
            ['3', { role: 'tab', name: 'vibe coding', selected: true }],
          ]),
        ),
      click: vi.fn().mockResolvedValue(undefined),
    });

    const result = await ensureTab(primitives, 'vibe coding', TAB_SELECTOR, WELL_KNOWN);
    expect(result.wellKnownKey).toBeUndefined();
  });
});

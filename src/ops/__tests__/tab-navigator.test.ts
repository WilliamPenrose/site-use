import { describe, it, expect } from 'vitest';
import { matchTab, type TabInfo } from '../tab-navigator.js';

const TWITTER_WELL_KNOWN: Record<string, number> = { for_you: 0, following: 1 };

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

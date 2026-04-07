import { describe, it, expect } from 'vitest';
import { canonicalizeTab } from '../canonicalize.js';

describe('canonicalizeTab', () => {
  it('lowercases and underscores well-known tabs', () => {
    expect(canonicalizeTab('Following')).toBe('following');
    expect(canonicalizeTab('FOLLOWING')).toBe('following');
    expect(canonicalizeTab('following')).toBe('following');
    expect(canonicalizeTab('For You')).toBe('for_you');
    expect(canonicalizeTab('for you')).toBe('for_you');
    expect(canonicalizeTab('for_you')).toBe('for_you');
    expect(canonicalizeTab('FOR_YOU')).toBe('for_you');
  });

  it('canonicalizes custom List names case-insensitively', () => {
    expect(canonicalizeTab('Vibe Coding')).toBe('vibe_coding');
    expect(canonicalizeTab('vibe coding')).toBe('vibe_coding');
    expect(canonicalizeTab('vibe_coding')).toBe('vibe_coding');
  });

  it('trims and collapses whitespace', () => {
    expect(canonicalizeTab('  Following  ')).toBe('following');
    expect(canonicalizeTab('vibe   coding')).toBe('vibe_coding');
    expect(canonicalizeTab('vibe\tcoding')).toBe('vibe_coding');
  });

  it('is idempotent', () => {
    const inputs = ['following', 'for_you', 'vibe_coding', 'long_tab_name'];
    for (const input of inputs) {
      expect(canonicalizeTab(canonicalizeTab(input))).toBe(canonicalizeTab(input));
    }
  });

  it('NFC normalizes Unicode', () => {
    // Combining sequence vs precomposed — both must collapse.
    const precomposed = 'Café';
    const decomposed = 'Cafe\u0301';
    expect(canonicalizeTab(precomposed)).toBe(canonicalizeTab(decomposed));
  });

  it('preserves empty input', () => {
    // Upstream zod min(1) is the layer that rejects this; canonicalize stays
    // pure and lets the validator decide.
    expect(canonicalizeTab('')).toBe('');
    expect(canonicalizeTab('   ')).toBe('');
  });
});

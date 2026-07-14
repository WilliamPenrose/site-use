import { describe, it, expect } from 'vitest';
import {
  containsCjk,
  splitCjkRuns,
  segmentCjkWords,
  wordToPinyin,
} from '../../packages/runtime/src/internal/primitives/keyboard-enhanced.js';

// CJK fixtures via code points (repo policy: no raw CJK chars in code files).
const C = (...cps: number[]) => String.fromCodePoint(...cps);
const QIAN = C(0x524d); // pinyin: qian
const DUAN = C(0x7aef); // pinyin: duan
const GONG = C(0x5de5);
const CHENG = C(0x7a0b);
const SHI = C(0x5e08);
const NI = C(0x4f60);
const HAO = C(0x597d);
const GA = C(0xac00); // Hangul, no pinyin

describe('containsCjk', () => {
  it('true for Han', () => expect(containsCjk(QIAN + DUAN)).toBe(true));
  it('false for ASCII', () => expect(containsCjk('frontend')).toBe(false));
  it('true for mixed', () => expect(containsCjk('hi' + NI + HAO)).toBe(true));
});

describe('splitCjkRuns', () => {
  it('splits mixed into alternating runs preserving order', () => {
    expect(splitCjkRuns('hi' + NI + HAO + 'a')).toEqual([
      { cjk: false, text: 'hi' },
      { cjk: true, text: NI + HAO },
      { cjk: false, text: 'a' },
    ]);
  });
  it('single ASCII run', () => {
    expect(splitCjkRuns('abc')).toEqual([{ cjk: false, text: 'abc' }]);
  });
});

describe('segmentCjkWords', () => {
  it('covers the whole run and produces >1 word for a phrase', () => {
    const phrase = QIAN + DUAN + GONG + CHENG + SHI; // frontend engineer
    const words = segmentCjkWords(phrase);
    expect(words.join('')).toBe(phrase);
    expect(words.length).toBeGreaterThan(1);
  });
});

describe('wordToPinyin', () => {
  it('maps Han to pinyin syllables aligned to chars', () => {
    expect(wordToPinyin(QIAN + DUAN)).toEqual([
      { char: QIAN, pinyin: 'qian' },
      { char: DUAN, pinyin: 'duan' },
    ]);
  });
  it('marks non-Han (Hangul) as fallback null', () => {
    expect(wordToPinyin(GA)).toEqual([{ char: GA, pinyin: null }]);
  });
});

import { pinyin } from 'pinyin-pro';

/** Unicode ranges treated as CJK / IME-composed input. */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
];

export function isCjkCodePoint(cp: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function containsCjk(text: string): boolean {
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) as number)) return true;
  }
  return false;
}

export interface TextRun {
  cjk: boolean;
  text: string;
}

/** Split into alternating CJK / non-CJK runs, preserving order. */
export function splitCjkRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  for (const ch of text) {
    const cjk = isCjkCodePoint(ch.codePointAt(0) as number);
    const last = runs[runs.length - 1];
    if (last && last.cjk === cjk) last.text += ch;
    else runs.push({ cjk, text: ch });
  }
  return runs;
}

const ZH_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

/** Segment a CJK run into words the way a user types them before selecting. */
export function segmentCjkWords(run: string): string[] {
  return [...ZH_SEGMENTER.segment(run)].map((s) => s.segment);
}

export interface PinyinChar {
  char: string;
  /** null => character has no pinyin; use the fallback commit. */
  pinyin: string | null;
}

/** Map each char of a word to its pinyin syllable (toneless), aligned 1:1. */
export function wordToPinyin(word: string): PinyinChar[] {
  const chars = [...word];
  const syllables = pinyin(word, { toneType: 'none', type: 'array' });
  return chars.map((char, i) => {
    const syl = syllables[i];
    const ok = typeof syl === 'string' && /^[a-z]+$/.test(syl);
    return { char, pinyin: ok ? syl : null };
  });
}

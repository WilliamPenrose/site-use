import { describe, it, expect, vi } from 'vitest';
import {
  containsCjk,
  splitCjkRuns,
  segmentCjkWords,
  wordToPinyin,
  imeComposeText,
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

const NO_DELAY = {
  letterDelayMs: () => 0,
  wordStartDelayMs: () => 0,
  commitDelayMs: () => 0,
};

function mockClient() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

describe('imeComposeText', () => {
  it('emits keydown(229), growing composition, real-code keyup, then insertText commit', async () => {
    const client = mockClient();
    await imeComposeText(client as any, QIAN, NO_DELAY); // pinyin: qian
    const calls = client.send.mock.calls;

    const firstKeydown = calls.find(
      (c) => c[0] === 'Input.dispatchKeyEvent' && c[1].type === 'keyDown',
    );
    expect(firstKeydown[1].windowsVirtualKeyCode).toBe(229);
    expect(firstKeydown[1].key).toBe('Process');

    const comps = calls
      .filter((c) => c[0] === 'Input.imeSetComposition')
      .map((c) => c[1].text);
    expect(comps).toEqual(['q', 'qi', 'qia', 'qian']);

    const letterKeyups = calls
      .filter((c) => c[0] === 'Input.dispatchKeyEvent' && c[1].type === 'keyUp' && c[1].code.startsWith('Key'))
      .map((c) => c[1].windowsVirtualKeyCode);
    expect(letterKeyups).toEqual([81, 73, 65, 78]); // Q I A N

    const inserts = calls.filter((c) => c[0] === 'Input.insertText');
    expect(inserts.at(-1)[1].text).toBe(QIAN);
  });

  it('fallback: unmapped char emits composition + insertText, no 229 keydown', async () => {
    const client = mockClient();
    await imeComposeText(client as any, GA, NO_DELAY); // Hangul, no pinyin
    const methods = client.send.mock.calls.map((c) => c[0]);
    expect(methods).toContain('Input.imeSetComposition');
    expect(methods).toContain('Input.insertText');
    const has229 = client.send.mock.calls.some(
      (c) => c[0] === 'Input.dispatchKeyEvent' && c[1].windowsVirtualKeyCode === 229,
    );
    expect(has229).toBe(false);
  });
});

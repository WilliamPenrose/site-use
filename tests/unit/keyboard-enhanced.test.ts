import { describe, it, expect, vi } from 'vitest';
import {
  containsCjk,
  splitCjkRuns,
  segmentCjkWords,
  wordToPinyin,
  imeComposeText,
  typeAsciiHumanized,
  DEFAULT_KEY_DWELL_MS,
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
  keyDwellMs: () => 0,
};

function mockClient() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

describe('imeComposeText', () => {
  it('emits keydown(229), growing composition, real-code keyup, then insertText commit', async () => {
    const client = mockClient();
    await imeComposeText(client as any, QIAN, NO_DELAY); // pinyin: qian
    const calls = client.send.mock.calls;

    const letterKeydowns = calls.filter(
      (c) =>
        c[0] === 'Input.dispatchKeyEvent' &&
        c[1].type === 'keyDown' &&
        typeof c[1].code === 'string' &&
        c[1].code.startsWith('Key'),
    );
    expect(letterKeydowns.length).toBeGreaterThan(0);
    for (const c of letterKeydowns) {
      expect(c[1].windowsVirtualKeyCode).toBe(229);
      expect(c[1].key).toBe('Process');
    }

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

  it('fallback: unmapped char is bracketed by a matching 229 keydown/keyup pair', async () => {
    const client = mockClient();
    await imeComposeText(client as any, GA, NO_DELAY); // Hangul, no pinyin
    const calls = client.send.mock.calls;
    const methods = calls.map((c) => c[0]);
    expect(methods).toContain('Input.imeSetComposition');
    expect(methods).toContain('Input.insertText');

    const keydowns229 = calls.filter(
      (c) => c[0] === 'Input.dispatchKeyEvent' && c[1].type === 'keyDown' && c[1].windowsVirtualKeyCode === 229,
    );
    const keyups229 = calls.filter(
      (c) => c[0] === 'Input.dispatchKeyEvent' && c[1].type === 'keyUp' && c[1].windowsVirtualKeyCode === 229,
    );
    expect(keydowns229.length).toBe(1);
    expect(keyups229.length).toBe(1);

    const keydownIdx = calls.indexOf(keydowns229[0]);
    const compositionIdx = calls.findIndex((c) => c[0] === 'Input.imeSetComposition');
    const insertIdx = calls.findIndex((c) => c[0] === 'Input.insertText');
    const keyupIdx = calls.indexOf(keyups229[0]);

    expect(keydownIdx).toBeLessThan(compositionIdx);
    expect(compositionIdx).toBeLessThan(insertIdx);
    expect(insertIdx).toBeLessThan(keyupIdx);
  });
});

describe('DEFAULT_KEY_DWELL_MS', () => {
  it('returns a human key-hold in the ~55-110ms range', () => {
    for (let i = 0; i < 200; i++) {
      const v = DEFAULT_KEY_DWELL_MS();
      expect(v).toBeGreaterThanOrEqual(55);
      expect(v).toBeLessThanOrEqual(110);
    }
  });
});

/** Log dispatchKeyEvent order into `log`, interleaving a 'dwell' marker per keyDwellMs call. */
function loggingClientWithDwell(log: string[]) {
  const client = mockClient();
  client.send.mockImplementation((method: string, params: any) => {
    if (method === 'Input.dispatchKeyEvent') log.push(`${params.type}:${params.code}`);
    return Promise.resolve(undefined);
  });
  const keyDwellMs = () => {
    log.push('dwell');
    return 0;
  };
  return { client, keyDwellMs };
}

describe('imeComposeText key dwell (hold time)', () => {
  it('holds each letter key: a dwell wait sits between its keyDown and keyUp', async () => {
    const log: string[] = [];
    const { client, keyDwellMs } = loggingClientWithDwell(log);
    await imeComposeText(client as any, QIAN, { ...NO_DELAY, keyDwellMs }); // pinyin: qian

    for (const code of ['KeyQ', 'KeyI', 'KeyA', 'KeyN']) {
      const down = log.indexOf(`keyDown:${code}`);
      const up = log.indexOf(`keyUp:${code}`);
      expect(down).toBeGreaterThanOrEqual(0);
      expect(up).toBeGreaterThan(down);
      expect(log.slice(down + 1, up)).toContain('dwell');
    }
  });

  it('holds the Space commit key between its keyDown and keyUp', async () => {
    const log: string[] = [];
    const { client, keyDwellMs } = loggingClientWithDwell(log);
    await imeComposeText(client as any, QIAN, { ...NO_DELAY, keyDwellMs });

    const down = log.indexOf('keyDown:Space');
    const up = log.indexOf('keyUp:Space');
    expect(down).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(down);
    expect(log.slice(down + 1, up)).toContain('dwell');
  });

  it('holds the fallback key between its keyDown and keyUp', async () => {
    const log: string[] = [];
    const { client, keyDwellMs } = loggingClientWithDwell(log);
    await imeComposeText(client as any, GA, { ...NO_DELAY, keyDwellMs }); // Hangul, no pinyin

    const down = log.indexOf('keyDown:');
    const up = log.indexOf('keyUp:');
    expect(down).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(down);
    expect(log.slice(down + 1, up)).toContain('dwell');
  });
});

describe('typeAsciiHumanized', () => {
  function mockKeyboard(log: string[]) {
    return {
      down: vi.fn((k: string) => {
        log.push(`down:${k}`);
        return Promise.resolve();
      }),
      up: vi.fn((k: string) => {
        log.push(`up:${k}`);
        return Promise.resolve();
      }),
      sendCharacter: vi.fn((c: string) => {
        log.push(`send:${c}`);
        return Promise.resolve();
      }),
    };
  }

  it('presses, holds for the dwell, then releases each mappable char in order', async () => {
    const log: string[] = [];
    const kb = mockKeyboard(log);
    const keyDwellMs = () => {
      log.push('dwell');
      return 0;
    };
    await typeAsciiHumanized(kb as any, 'ab', { keyDwellMs, delayMs: 0 });
    expect(log).toEqual([
      'down:a',
      'dwell',
      'up:a',
      'down:b',
      'dwell',
      'up:b',
    ]);
  });

  it('falls back to sendCharacter (no dwell, no up) when down() throws for an unmappable char', async () => {
    const log: string[] = [];
    const kb = mockKeyboard(log);
    kb.down.mockImplementation((k: string) => {
      if (k === 'é') return Promise.reject(new Error('no key definition'));
      log.push(`down:${k}`);
      return Promise.resolve();
    });
    await typeAsciiHumanized(kb as any, 'aé', { keyDwellMs: () => 0, delayMs: 0 });
    expect(log).toEqual(['down:a', 'up:a', 'send:é']);
    expect(kb.up).toHaveBeenCalledTimes(1); // never released the key that failed to press
  });

  it('presses and releases each char (default dwell) when no timing is supplied', async () => {
    const log: string[] = [];
    const kb = mockKeyboard(log);
    await typeAsciiHumanized(kb as any, 'a', {});
    // Default path still down/up-drives the key (real hold applied via DEFAULT_KEY_DWELL_MS).
    expect(log).toEqual(['down:a', 'up:a']);
  });
});

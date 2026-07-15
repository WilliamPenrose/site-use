import { pinyin } from 'pinyin-pro';
import type { CDPSession } from 'puppeteer-core';

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

export interface ImeTiming {
  letterDelayMs?: () => number;
  wordStartDelayMs?: () => number;
  commitDelayMs?: () => number;
  /** Key-hold (dwell) time between a key's keyDown and its keyUp, in ms. */
  keyDwellMs?: () => number;
}

/**
 * Default human key-hold (dwell) time: ~55-110ms between keyDown and keyUp.
 * A real key press is held tens of ms; without this the per-key dwell series a
 * detector reads (e.g. keystroke-timing biometrics) collapses to all-zero.
 */
export const DEFAULT_KEY_DWELL_MS = (): number => 55 + Math.random() * 55;

/** keyCode during IME composition is always 229 ("Process") regardless of key. */
const IME_KEYDOWN_KEYCODE = 229;

/** keyCode reported by the Space key (candidate-selection commit). */
const SPACE_KEYCODE = 32;

/** Physical key metadata for pinyin letters a-z (keyup reports the real code). */
const LETTER_KEYS: Record<string, { code: string; keyCode: number }> = {};
for (let c = 97; c <= 122; c++) {
  const ch = String.fromCharCode(c);
  LETTER_KEYS[ch] = { code: `Key${ch.toUpperCase()}`, keyCode: c - 32 };
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

async function composeSpan(
  client: CDPSession,
  span: PinyinChar[],
  d: Required<ImeTiming>,
): Promise<void> {
  await wait(d.wordStartDelayMs());
  const hanzi = span.map((c) => c.char).join('');
  const letters = span.map((c) => c.pinyin as string).join('');

  let composed = '';
  for (const letter of letters) {
    const key = LETTER_KEYS[letter];
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      windowsVirtualKeyCode: IME_KEYDOWN_KEYCODE,
      key: 'Process',
      code: key?.code ?? '',
    });
    composed += letter;
    await client.send('Input.imeSetComposition', {
      text: composed,
      selectionStart: composed.length,
      selectionEnd: composed.length,
    });
    // Hold the key for a human dwell before releasing it.
    await wait(d.keyDwellMs());
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: key?.keyCode ?? 0,
      key: letter,
      code: key?.code ?? '',
    });
    await wait(d.letterDelayMs());
  }

  // Candidate selection: Space confirms the composition.
  await wait(d.commitDelayMs());
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    windowsVirtualKeyCode: IME_KEYDOWN_KEYCODE,
    key: 'Process',
    code: 'Space',
  });
  await client.send('Input.insertText', { text: hanzi });
  await wait(d.keyDwellMs());
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: SPACE_KEYCODE,
    key: ' ',
    code: 'Space',
  });
}

async function composeFallback(
  client: CDPSession,
  char: string,
  d: Required<ImeTiming>,
): Promise<void> {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    windowsVirtualKeyCode: IME_KEYDOWN_KEYCODE,
    key: 'Process',
    code: '',
  });
  await client.send('Input.imeSetComposition', {
    text: char,
    selectionStart: char.length,
    selectionEnd: char.length,
  });
  await client.send('Input.insertText', { text: char });
  await wait(d.keyDwellMs());
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: IME_KEYDOWN_KEYCODE,
    key: 'Process',
    code: '',
  });
}

/** Drive an IME-faithful keystroke stream for a CJK run on the focused element. */
export async function imeComposeText(
  client: CDPSession,
  runText: string,
  timing: ImeTiming = {},
): Promise<void> {
  const d: Required<ImeTiming> = {
    letterDelayMs: timing.letterDelayMs ?? (() => 80 + Math.random() * 90),
    wordStartDelayMs: timing.wordStartDelayMs ?? (() => 150 + Math.random() * 350),
    commitDelayMs: timing.commitDelayMs ?? (() => 200 + Math.random() * 400),
    keyDwellMs: timing.keyDwellMs ?? DEFAULT_KEY_DWELL_MS,
  };

  for (const word of segmentCjkWords(runText)) {
    const chars = wordToPinyin(word);
    let i = 0;
    while (i < chars.length) {
      if (chars[i].pinyin == null) {
        await composeFallback(client, chars[i].char, d);
        i++;
        continue;
      }
      const span: PinyinChar[] = [];
      while (i < chars.length && chars[i].pinyin != null) {
        span.push(chars[i]);
        i++;
      }
      await composeSpan(client, span, d);
    }
  }
}

/** Minimal Puppeteer `page.keyboard` surface the ASCII typer depends on. */
export interface KeyboardLike {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
  sendCharacter(char: string): Promise<void>;
}

export interface AsciiTypingOptions {
  /** Key-hold (dwell) time between keyDown and keyUp, in ms. */
  keyDwellMs?: () => number;
  /** Inter-key gap after each character is released, in ms. */
  delayMs?: number;
}

/**
 * Type ASCII (non-IME) text with a human key-hold on each character.
 *
 * Drives per-character keyDown -> dwell -> keyUp so each key is held for a
 * realistic duration, instead of Puppeteer's `keyboard.type` which releases
 * every key within CDP round-trip latency (a degenerate ~0ms dwell). Characters
 * that have no key definition (accented Latin, emoji, etc.) fall back to
 * `sendCharacter`, matching `keyboard.type`'s own behavior.
 */
export async function typeAsciiHumanized(
  keyboard: KeyboardLike,
  text: string,
  options: AsciiTypingOptions = {},
): Promise<void> {
  const keyDwellMs = options.keyDwellMs ?? DEFAULT_KEY_DWELL_MS;
  const delayMs = options.delayMs ?? 0;

  for (const char of text) {
    let pressed = false;
    try {
      await keyboard.down(char);
      pressed = true;
    } catch {
      // No key definition for this character; fall back to a raw text insert.
      pressed = false;
    }

    if (pressed) {
      await wait(keyDwellMs());
      await keyboard.up(char);
    } else {
      await keyboard.sendCharacter(char);
    }

    await wait(delayMs);
  }
}

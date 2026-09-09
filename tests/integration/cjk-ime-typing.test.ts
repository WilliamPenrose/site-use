import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer-core';
import { imeComposeText } from '../../packages/runtime/src/internal/primitives/keyboard-enhanced.js';

const EXECUTABLE = process.env.CHROME_EXECUTABLE_PATH;

// CJK fixtures via code points (repo policy: no raw CJK chars in code files).
const C = (...cps: number[]) => String.fromCodePoint(...cps);
const QIANDUAN = C(0x524d, 0x7aef); // frontend

const FAST = {
  letterDelayMs: () => 1,
  wordStartDelayMs: () => 1,
  commitDelayMs: () => 1,
  keyDwellMs: () => 1,
};

describe.skipIf(!EXECUTABLE)('CJK IME typing (real browser)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: EXECUTABLE, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('emits composition + input events in order and commits the exact text', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <textarea id="t"></textarea>
        <script>
          window.__events = [];
          const t = document.getElementById('t');
          for (const type of ['compositionstart','compositionupdate','compositionend','input']) {
            t.addEventListener(type, (e) => window.__events.push({ type, data: e.data ?? null }));
          }
        </script>
      `);
      await page.focus('#t');

      const client = await page.createCDPSession();
      await imeComposeText(client, QIANDUAN, FAST);
      await client.detach();

      const value = await page.$eval('#t', (el) => (el as HTMLTextAreaElement).value);
      expect(value).toBe(QIANDUAN);

      const types: string[] = await page.evaluate(() => (window as any).__events.map((e: any) => e.type));

      // compositionstart is the very first event.
      expect(types[0]).toBe('compositionstart');
      expect(types.filter((t) => t === 'compositionstart').length).toBe(1);
      expect(types.filter((t) => t === 'compositionend').length).toBe(1);

      const lastUpdate = types.lastIndexOf('compositionupdate');
      const firstEnd = types.indexOf('compositionend');
      // Every compositionupdate precedes compositionend (checked via the LAST update, not the first).
      expect(lastUpdate).toBeGreaterThanOrEqual(0);
      expect(lastUpdate).toBeLessThan(firstEnd);

      // compositionend is the terminal event of the trace (real driver behavior: no input after it).
      expect(types[types.length - 1]).toBe('compositionend');

      const updateCount = types.filter((t) => t === 'compositionupdate').length;
      const inputCount = types.filter((t) => t === 'input').length;
      // Each compositionupdate is paired with an input commit (letters + final insertText).
      expect(inputCount).toBeGreaterThanOrEqual(1);
      expect(inputCount).toBeGreaterThanOrEqual(updateCount);

      // No input event fires after compositionend.
      expect(types.lastIndexOf('input')).toBeLessThan(firstEnd);
    } finally {
      await page.close();
    }
  });
});

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
    const firstStart = types.indexOf('compositionstart');
    const firstUpdate = types.indexOf('compositionupdate');
    const lastEnd = types.lastIndexOf('compositionend');
    const lastInput = types.lastIndexOf('input');

    expect(firstStart).toBeGreaterThanOrEqual(0);
    expect(firstUpdate).toBeGreaterThan(firstStart);
    expect(lastEnd).toBeGreaterThan(firstUpdate);
    expect(lastInput).toBeGreaterThan(firstStart);
    expect(types.filter((t) => t === 'compositionupdate').length).toBeGreaterThanOrEqual(1);

    await page.close();
  });
});

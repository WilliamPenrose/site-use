import type { CheckMeta, CheckResult } from '../types.js';
import type { Page } from 'puppeteer-core';

export const meta: CheckMeta & { runtime: 'node' } = {
  id: 'browser-info',
  name: 'Browser identity',
  description: 'Check for headless mode, Chrome for Testing, and suspicious launch args',
  runtime: 'node',
  expected: 'not headless, not CfT',
};

export async function run(page: Page): Promise<CheckResult> {
  const browser = page.browser();
  const cdpSession = await browser.target().createCDPSession();

  try {
    const versionInfo = (await cdpSession.send('Browser.getVersion')) as {
      product: string;
      userAgent: string;
      revision: string;
    };

    const product = versionInfo.product;
    const isHeadless = product.toLowerCase().includes('headless');
    const isCfT =
      versionInfo.userAgent.includes('Chrome for Testing') ||
      versionInfo.userAgent.includes('HeadlessChrome');

    const spawnargs = browser.process()?.spawnargs ?? [];
    const suspiciousArgs = spawnargs.filter(
      (a) =>
        a.includes('--headless') ||
        a.includes('--remote-debugging') ||
        a.includes('enable-automation'),
    );

    const pass = !isHeadless && !isCfT;
    const parts: string[] = [];
    parts.push(`product=${product}`);
    if (isHeadless) parts.push('HEADLESS');
    if (isCfT) parts.push('CfT');
    if (suspiciousArgs.length > 0) parts.push(`args=[${suspiciousArgs.join(', ')}]`);

    return {
      pass,
      actual: pass ? 'regular Chrome' : parts.join(', '),
      detail: parts.join(', '),
    };
  } finally {
    await cdpSession.detach();
  }
}

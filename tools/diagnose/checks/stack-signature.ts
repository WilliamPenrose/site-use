import type { CheckMeta, CheckResult } from '../types.js';
import type { Page } from 'puppeteer-core';

export const meta: CheckMeta & { runtime: 'node' } = {
  id: 'stack-signature',
  name: 'Stack trace signature',
  description: 'page.evaluate() stack should not contain puppeteer/pyppeteer markers',
  runtime: 'node',
  expected: 'clean stack',
  knownFail: true,
};

export async function run(page: Page): Promise<CheckResult> {
  const stack: string = await page.evaluate(() => {
    try {
      throw new Error();
    } catch (e) {
      return (e as Error).stack || '';
    }
  });

  const patterns: Record<string, RegExp> = {
    puppeteer_eval: /__puppeteer_evaluation_script__/,
    puppeteer_pptr: /pptr:evaluate/,
    pyppeteer: /__pyppeteer_evaluation_script__/,
    stealth: /newHandler\.<computed> \[as apply\]/,
  };

  const found: string[] = [];
  for (const [name, re] of Object.entries(patterns)) {
    if (re.test(stack)) found.push(name);
  }

  return {
    pass: found.length === 0,
    actual: found.length > 0 ? `matched: ${found.join(', ')}` : 'clean',
    detail: found.length > 0 ? stack.split('\n').slice(0, 5).join(' | ') : undefined,
  };
}

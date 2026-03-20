import type { CheckMeta, CheckResult } from '../types.js';
import type { Page } from 'puppeteer-core';

export const meta: CheckMeta & { runtime: 'node' } = {
  id: 'launch-args',
  name: 'Chrome launch arguments',
  description: 'Report all Chrome launch arguments for inspection',
  runtime: 'node',
  expected: 'see detail',
  info: true,
};

export async function run(page: Page): Promise<CheckResult> {
  const browser = page.browser();
  const spawnargs = browser.process()?.spawnargs ?? [];

  // Skip the first arg (chrome binary path) for readability
  const args = spawnargs.slice(1);

  return {
    pass: true,
    actual: `${args.length} args`,
    detail: args.join(', '),
  };
}

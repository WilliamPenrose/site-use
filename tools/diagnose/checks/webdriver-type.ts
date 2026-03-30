import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'webdriver-type',
  name: 'typeof navigator.webdriver',
  description: 'typeof navigator.webdriver should be "boolean" (not "undefined")',
  runtime: 'browser',
  expected: 'boolean',
};

export function run(): CheckResult {
  const t = typeof navigator.webdriver;
  return {
    pass: t === 'boolean',
    actual: t,
  };
}

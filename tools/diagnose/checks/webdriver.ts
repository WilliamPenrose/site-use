import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'webdriver',
  name: 'navigator.webdriver',
  description: 'navigator.webdriver should be false, not true',
  runtime: 'browser',
  expected: 'false',
};

export function run(): CheckResult {
  const val = navigator.webdriver;
  return {
    pass: val === false,
    actual: String(val),
    detail: `typeof=${typeof val}`,
  };
}

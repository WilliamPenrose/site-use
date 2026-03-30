import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'chrome-window',
  name: 'window.chrome exists',
  description: 'window.chrome object should exist in a real Chrome browser',
  runtime: 'browser',
  expected: 'true',
};

export function run(): CheckResult {
  const exists = !!(window as unknown as Record<string, unknown>).chrome;
  return {
    pass: exists,
    actual: String(exists),
  };
}

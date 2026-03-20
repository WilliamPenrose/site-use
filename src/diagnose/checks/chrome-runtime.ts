import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'chrome-runtime',
  name: 'window.chrome.runtime exists',
  description: 'Report whether chrome.runtime is available (depends on installed extensions)',
  runtime: 'browser',
  expected: 'depends on extensions',
  info: true,
};

export function run(): CheckResult {
  const chrome = (window as unknown as Record<string, unknown>).chrome as
    | Record<string, unknown>
    | undefined;
  const exists = !!chrome?.runtime;
  return {
    pass: exists,
    actual: String(exists),
  };
}

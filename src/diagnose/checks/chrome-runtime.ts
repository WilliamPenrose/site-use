import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'chrome-runtime',
  name: 'window.chrome.runtime exists',
  description: 'window.chrome.runtime should exist (depends on extensions)',
  runtime: 'browser',
  expected: 'true',
};

export function run(): CheckResult {
  const chrome = (window as unknown as Record<string, unknown>).chrome as
    | Record<string, unknown>
    | undefined;
  const exists = !!chrome?.runtime;
  return {
    pass: exists,
    actual: String(exists),
    detail: exists ? undefined : 'may depend on installed extensions',
  };
}

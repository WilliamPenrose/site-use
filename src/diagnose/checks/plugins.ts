import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'plugins',
  name: 'navigator.plugins.length',
  description: 'navigator.plugins should have at least one entry',
  runtime: 'browser',
  expected: '> 0',
};

export function run(): CheckResult {
  const len = navigator.plugins.length;
  return {
    pass: len > 0,
    actual: String(len),
  };
}

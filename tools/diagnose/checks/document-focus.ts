import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'document-focus',
  name: 'document.hasFocus()',
  description: 'document.hasFocus() should return true (focus emulation active)',
  runtime: 'browser',
  expected: 'true',
};

export function run(): CheckResult {
  const val = document.hasFocus();
  return {
    pass: val === true,
    actual: String(val),
  };
}

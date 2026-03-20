import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'window-size',
  name: 'window outer dimensions',
  description: 'outerWidth should be 1920 and outerHeight > 0',
  runtime: 'browser',
  expected: 'outerWidth=1920, outerHeight>0',
};

export function run(): CheckResult {
  const w = window.outerWidth;
  const h = window.outerHeight;
  const pass = w === 1920 && h > 0;
  return {
    pass,
    actual: `outerWidth=${w}, outerHeight=${h}`,
  };
}

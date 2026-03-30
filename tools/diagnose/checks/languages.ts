import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'languages',
  name: 'navigator.languages',
  description: 'Report configured browser languages',
  runtime: 'browser',
  expected: 'non-empty list',
  info: true,
};

export function run(): CheckResult {
  const langs = Array.from(navigator.languages);
  return {
    pass: langs.length > 0,
    actual: langs.join(', '),
  };
}

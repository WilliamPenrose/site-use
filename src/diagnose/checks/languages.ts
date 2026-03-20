import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'languages',
  name: 'navigator.languages includes en-US',
  description: 'navigator.languages should include en-US',
  runtime: 'browser',
  expected: 'includes en-US',
};

export function run(): CheckResult {
  const langs = Array.from(navigator.languages);
  const has = langs.includes('en-US');
  return {
    pass: has,
    actual: langs.join(', '),
  };
}

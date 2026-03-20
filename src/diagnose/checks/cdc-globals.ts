import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'cdc-globals',
  name: 'ChromeDriver cdc_ globals',
  description: 'No cdc_* properties should exist on window',
  runtime: 'browser',
  expected: 'none found',
};

export function run(): CheckResult {
  const matches: string[] = [];
  for (const prop in window) {
    if (prop.match && prop.match(/cdc_[a-z0-9]/gi)) {
      matches.push(prop);
    }
  }
  return {
    pass: matches.length === 0,
    actual: matches.length > 0 ? `found: ${matches.join(', ')}` : 'none',
  };
}

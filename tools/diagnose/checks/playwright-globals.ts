import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'playwright-globals',
  name: 'Playwright globals',
  description: 'No Playwright-specific globals should exist on window',
  runtime: 'browser',
  expected: 'none found',
};

export function run(): CheckResult {
  const win = window as unknown as Record<string, unknown>;
  const found: string[] = [];
  if (win.__pwInitScripts !== undefined) found.push('__pwInitScripts');
  if (win.__playwright__binding__ !== undefined) found.push('__playwright__binding__');
  return {
    pass: found.length === 0,
    actual: found.length > 0 ? `found: ${found.join(', ')}` : 'none',
  };
}

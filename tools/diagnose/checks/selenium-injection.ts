import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'selenium-injection',
  name: 'Selenium script injection',
  description: 'Function.prototype.apply should be native and no ChromeDriver globals present',
  runtime: 'browser',
  expected: 'native, no globals',
};

export function run(): CheckResult {
  const applyStr = Function.prototype.apply.toString();
  const isNative = applyStr.indexOf('[native code]') !== -1;

  const win = window as unknown as Record<string, unknown>;
  const cdcFound: string[] = [];
  const cdcPatterns = ['WebDriver', 'cdc_adoQpoasnfa76pfcZLmcfl'];
  for (const p of cdcPatterns) {
    if (win[p] !== undefined) cdcFound.push(p);
  }

  const pass = isNative && cdcFound.length === 0;
  return {
    pass,
    actual:
      (!isNative ? 'Function.apply patched' : 'native') +
      (cdcFound.length > 0 ? `, globals: ${cdcFound.join(',')}` : ''),
  };
}

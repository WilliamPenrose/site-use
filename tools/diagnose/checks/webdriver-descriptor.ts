import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'webdriver-descriptor',
  name: 'webdriver property descriptor',
  description: 'webdriver descriptor should be enumerable and configurable',
  runtime: 'browser',
  expected: 'enumerable=true, configurable=true',
};

export function run(): CheckResult {
  const desc =
    Object.getOwnPropertyDescriptor(navigator, 'webdriver') ||
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'webdriver');

  if (!desc) {
    return { pass: false, actual: 'no descriptor found' };
  }

  const pass = desc.enumerable === true && desc.configurable === true;
  return {
    pass,
    actual: `enumerable=${desc.enumerable}, configurable=${desc.configurable}`,
  };
}

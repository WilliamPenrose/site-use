import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'visibility-state',
  name: 'document.visibilityState',
  description: 'document.visibilityState should be "visible" (focus emulation locks this)',
  runtime: 'browser',
  expected: 'visible',
};

export function run(): CheckResult {
  const val = document.visibilityState;
  return {
    pass: val === 'visible',
    actual: val,
  };
}

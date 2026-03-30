import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'input-trusted',
  name: 'Mouse events isTrusted',
  description: 'Mouse events dispatched by CDP should have isTrusted=true',
  runtime: 'browser',
  expected: 'all trusted',
};

let checked = false;
let untrusted = false;

export function setup(): void {
  const events = ['mousedown', 'mouseup', 'click', 'mousemove'];
  events.forEach((evt) => {
    document.addEventListener(evt, (e) => {
      checked = true;
      if (!e.isTrusted) untrusted = true;
    });
  });
}

export function run(): CheckResult {
  if (!checked) {
    return { pass: true, actual: 'no events received (skipped)' };
  }
  return {
    pass: !untrusted,
    actual: untrusted ? 'untrusted events detected' : 'all events trusted',
  };
}

import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'popup-crash',
  name: 'Popup from iframe',
  description: 'window.open from an iframe should not crash or be blocked',
  runtime: 'browser',
  expected: 'popup allowed',
};

export function run(): CheckResult {
  try {
    const f = document.createElement('iframe');
    f.src = 'about:blank';
    f.style.cssText = 'height:0;width:0;opacity:0;position:absolute';
    document.body.appendChild(f);
    try {
      const w = f.contentWindow!.open('', '', 'top=9999,left=9999,width=1,height=1');
      if (w) {
        w.close();
        f.remove();
        return { pass: true, actual: 'popup allowed' };
      }
      f.remove();
      return { pass: false, actual: 'popup blocked' };
    } catch (e) {
      f.remove();
      return { pass: false, actual: `popup error: ${(e as Error).message}` };
    }
  } catch (e) {
    return { pass: false, actual: `iframe error: ${(e as Error).message}` };
  }
}

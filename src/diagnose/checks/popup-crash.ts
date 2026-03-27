import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'popup-crash',
  name: 'Popup from iframe',
  description: 'Programmatic window.open should be blocked (normal browser) and not crash',
  runtime: 'browser',
  expected: 'popup blocked',
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
        // Normal browsers block programmatic popups without user gesture
        return { pass: false, actual: 'popup allowed (automation signature)' };
      }
      f.remove();
      return { pass: true, actual: 'popup blocked' };
    } catch (e) {
      f.remove();
      return { pass: false, actual: `popup error: ${(e as Error).message}` };
    }
  } catch (e) {
    return { pass: false, actual: `iframe error: ${(e as Error).message}` };
  }
}

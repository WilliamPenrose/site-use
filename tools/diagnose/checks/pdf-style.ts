import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'pdf-style',
  name: 'PDF style injection',
  description: 'No injected <style> should exist in an about:blank iframe',
  runtime: 'browser',
  expected: 'clean',
};

export function run(): Promise<CheckResult> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'height:0;width:0;position:absolute;opacity:0';
    iframe.src = 'about:blank';
    document.body.appendChild(iframe);

    setTimeout(() => {
      try {
        const style =
          iframe.contentDocument && iframe.contentDocument.querySelector('style');
        const hasStyle = !!(style && style.textContent);
        iframe.remove();
        resolve({
          pass: !hasStyle,
          actual: hasStyle ? 'injected style found' : 'clean',
        });
      } catch {
        iframe.remove();
        resolve({
          pass: true,
          actual: 'cross-origin (OK)',
        });
      }
    }, 500);
  });
}

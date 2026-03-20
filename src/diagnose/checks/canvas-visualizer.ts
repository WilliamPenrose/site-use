import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'canvas-visualizer',
  name: 'Canvas mouse visualizer overlay',
  description: 'No suspicious full-screen fixed canvas with pointer-events:none',
  runtime: 'browser',
  expected: 'none found',
};

export function run(): CheckResult {
  const canvases = document.querySelectorAll('canvas');
  let suspicious = false;
  canvases.forEach((c) => {
    const s = c.style;
    if (
      s.position === 'fixed' &&
      s.pointerEvents === 'none' &&
      c.width >= window.innerWidth - 1 &&
      c.height >= window.innerHeight - 1
    ) {
      suspicious = true;
    }
  });
  return {
    pass: !suspicious,
    actual: suspicious ? 'suspicious overlay canvas found' : 'none',
  };
}

import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'input-coords',
  name: 'Mouse coordinate leak',
  description: 'pageX/pageY should differ from screenX/screenY when Chrome has UI overhead',
  runtime: 'browser',
  expected: 'no leak',
};

let checked = false;
let coordsLeak = false;

export function setup(): void {
  const events = ['mousedown', 'mouseup', 'click', 'mousemove'];
  events.forEach((evt) => {
    document.addEventListener(evt, (e: Event) => {
      const me = e as MouseEvent;
      checked = true;
      if (
        me.pageY === me.screenY &&
        me.pageX === me.screenX &&
        window.outerHeight - window.innerHeight > 1
      ) {
        coordsLeak = true;
      }
    });
  });
}

export function run(): CheckResult {
  if (!checked) {
    return { pass: true, actual: 'no events received (skipped)' };
  }
  return {
    pass: !coordsLeak,
    actual: coordsLeak ? 'pageX==screenX leak detected' : 'clean',
  };
}

import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'runtime-enabled',
  name: 'CDP Runtime detection',
  description: 'console.debug should not trigger extra stack/name lookups from CDP Runtime',
  runtime: 'browser',
  expected: 'not detected',
  knownFail: true,
};

export async function run(): Promise<CheckResult> {
  let stackLookupCount = 0;
  let nameLookupCount = 0;

  const origDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, 'name');
  Object.defineProperty(Error.prototype, 'name', {
    configurable: true,
    enumerable: false,
    get() {
      nameLookupCount++;
      return 'Error';
    },
  });

  const e = new Error();
  Object.defineProperty(e, 'stack', {
    configurable: true,
    enumerable: false,
    get() {
      stackLookupCount++;
      return '';
    },
  });

  let c: Console;
  try {
    c = (console as unknown as Record<string, (prefix: string) => Console>).context('detect: ');
  } catch {
    c = console;
  }
  c.debug(e);

  nameLookupCount = 0;
  c.debug(new Error(''));
  const finalNameCount = nameLookupCount;

  if (origDescriptor) {
    Object.defineProperty(Error.prototype, 'name', origDescriptor);
  }

  const detected = stackLookupCount > 0 || finalNameCount >= 2;
  c.clear();

  return {
    pass: !detected,
    actual: detected ? 'detected' : 'not detected',
    detail: `stackLookups=${stackLookupCount}, nameLookups=${finalNameCount}`,
  };
}

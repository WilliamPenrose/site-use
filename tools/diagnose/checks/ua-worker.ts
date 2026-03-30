import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'ua-worker',
  name: 'UA worker consistency',
  description: 'High entropy values should match between main thread and Web Worker',
  runtime: 'browser',
  expected: 'values match',
};

const HINTS = [
  'architecture',
  'bitness',
  'model',
  'platform',
  'platformVersion',
  'uaFullVersion',
] as const;

type HEValues = Record<string, string>;

function getMainThreadValues(): Promise<HEValues | null> {
  const nav = navigator as unknown as Record<string, unknown>;
  const uad = nav.userAgentData as
    | { getHighEntropyValues?: (hints: string[]) => Promise<HEValues> }
    | undefined;
  if (!uad?.getHighEntropyValues) return Promise.resolve(null);
  return uad.getHighEntropyValues([...HINTS]);
}

function getWorkerValues(timeout = 5000): Promise<HEValues> {
  return new Promise((resolve, reject) => {
    const code = `
      self.onmessage = async function () {
        const data = await navigator.userAgentData.getHighEntropyValues(
          ${JSON.stringify([...HINTS])}
        );
        postMessage(data);
      };
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('timeout'));
    }, timeout);
    worker.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(e.data as HEValues);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error('worker error'));
    };
    worker.postMessage('call');
  });
}

export async function run(): Promise<CheckResult> {
  const mainValues = await getMainThreadValues();
  if (!mainValues) {
    return { pass: true, actual: 'userAgentData API not available (OK)' };
  }

  let workerValues: HEValues;
  try {
    workerValues = await getWorkerValues();
  } catch (err) {
    return {
      pass: true,
      actual: `Worker unavailable: ${(err as Error).message}`,
    };
  }

  const mismatches: string[] = [];
  for (const key of HINTS) {
    const main = mainValues[key] ?? '';
    const worker = workerValues[key] ?? '';
    if (main !== worker) {
      mismatches.push(`${key}: main="${main}" worker="${worker}"`);
    }
  }

  if (mismatches.length > 0) {
    return {
      pass: false,
      actual: `mismatch: ${mismatches.join('; ')}`,
      detail: 'Stealth plugin likely patched main thread navigator but not Worker',
    };
  }

  return { pass: true, actual: 'main/worker values match' };
}

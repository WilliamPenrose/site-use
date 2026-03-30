import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'ua-override',
  name: 'UA high entropy values',
  description: 'userAgentData.getHighEntropyValues() should return non-empty data',
  runtime: 'browser',
  expected: 'non-empty values',
};

export async function run(): Promise<CheckResult> {
  const nav = navigator as unknown as Record<string, unknown>;
  const uad = nav.userAgentData as
    | { getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string>> }
    | undefined;

  if (!uad?.getHighEntropyValues) {
    return { pass: true, actual: 'API not available (OK)' };
  }

  try {
    const data = await uad.getHighEntropyValues([
      'architecture',
      'bitness',
      'model',
      'platform',
      'platformVersion',
      'uaFullVersion',
    ]);
    const allEmpty =
      !data.architecture &&
      !data.bitness &&
      !data.model &&
      !data.platformVersion &&
      !data.uaFullVersion;
    return {
      pass: !allEmpty,
      actual: allEmpty
        ? 'all values empty (spoofed UA)'
        : `arch=${data.architecture}, platform=${data.platform}`,
    };
  } catch (err) {
    return {
      pass: true,
      actual: `getHighEntropyValues error: ${(err as Error).message}`,
    };
  }
}

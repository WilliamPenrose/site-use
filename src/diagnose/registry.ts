import type { CheckMeta, CheckResult } from './types.js';
import type { Page } from 'puppeteer-core';
import { meta as browserInfoMeta, run as browserInfoRun } from './checks/browser-info.js';
import { meta as stackSignatureMeta, run as stackSignatureRun } from './checks/stack-signature.js';

export interface NodeCheckEntry {
  meta: CheckMeta & { runtime: 'node' };
  run: (page: Page) => Promise<CheckResult>;
}

export const nodeChecks: NodeCheckEntry[] = [
  { meta: browserInfoMeta, run: browserInfoRun },
  { meta: stackSignatureMeta, run: stackSignatureRun },
];

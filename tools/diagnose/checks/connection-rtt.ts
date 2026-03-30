import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'connection-rtt',
  name: 'navigator.connection.rtt',
  description: 'Network connection RTT should be > 0',
  runtime: 'browser',
  expected: '> 0',
};

export function run(): CheckResult {
  const nav = navigator as unknown as Record<string, unknown>;
  const conn = (nav.connection ?? {}) as Record<string, unknown>;
  const rtt = conn.rtt as number | undefined;
  return {
    pass: (rtt ?? 0) > 0,
    actual: String(rtt ?? 'undefined'),
  };
}

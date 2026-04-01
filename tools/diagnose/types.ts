export interface CheckMeta {
  id: string;
  name: string;
  description: string;
  runtime: 'browser' | 'node';
  expected: string;
  knownFail?: boolean;
  info?: boolean;
}

export interface CheckResult {
  pass: boolean;
  actual: string;
  detail?: string;
}

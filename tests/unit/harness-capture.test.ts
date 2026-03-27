import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { captureForHarness } from '../../src/harness/capture.js';
import type { DomainDescriptor } from '../../src/harness/types.js';

let tmpDir: string;
let goldenDir: string;
let capturedDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-capture-'));
  goldenDir = path.join(tmpDir, 'golden');
  capturedDir = path.join(tmpDir, 'captured');
  fs.mkdirSync(goldenDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const mockDomain: DomainDescriptor = {
  extractEntries: (body: string) => {
    const data = JSON.parse(body);
    return data.entries ?? [];
  },
  parseEntry: (entry: unknown) => entry,
  toFeedItem: () => ({ id: '1', author: { handle: 'a', name: 'A' }, text: '', timestamp: '', url: '', media: [], links: [], siteMeta: {} }),
  variantSignature: (entry: unknown) => (entry as any).sig ?? 'unknown',
  assertions: {},
};

describe('captureForHarness', () => {
  it('saves entry to captured/ when variant not in golden', async () => {
    fs.writeFileSync(path.join(goldenDir, 'test-variants.json'), '[]');

    const body = JSON.stringify({ entries: [{ sig: 'new|variant', data: 'x' }] });
    const result = await captureForHarness(body, mockDomain, 'test', goldenDir, capturedDir);

    expect(result.captured).toBe(1);
    const files = fs.readdirSync(capturedDir).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(1);
  });

  it('skips entry when variant already matches golden structure', async () => {
    fs.writeFileSync(
      path.join(goldenDir, 'test-variants.json'),
      JSON.stringify([{ _variant: 'known|variant', sig: 'known|variant', data: 'old' }]),
    );

    const body = JSON.stringify({ entries: [{ sig: 'known|variant', data: 'same structure' }] });
    const result = await captureForHarness(body, mockDomain, 'test', goldenDir, capturedDir);

    expect(result.captured).toBe(0);
  });

  it('captures entry when structure differs from golden', async () => {
    fs.writeFileSync(
      path.join(goldenDir, 'test-variants.json'),
      JSON.stringify([{ _variant: 'existing', sig: 'existing', count: 42 }]),
    );

    const body = JSON.stringify({ entries: [{ sig: 'existing', count: 42, newField: 'surprise' }] });
    const result = await captureForHarness(body, mockDomain, 'test', goldenDir, capturedDir);

    expect(result.captured).toBe(1);
  });

  it('handles empty response body gracefully', async () => {
    const result = await captureForHarness('{}', mockDomain, 'test', goldenDir, capturedDir);
    expect(result.captured).toBe(0);
  });
});

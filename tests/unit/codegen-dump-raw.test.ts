import { describe, it, expect } from 'vitest';
import { extractDumpRaw } from '../../src/registry/codegen.js';

describe('extractDumpRaw', () => {
  it('returns null and original args when --dump-raw not present', () => {
    const result = extractDumpRaw(['--count', '5', '--debug'], 'twitter');
    expect(result.dumpRawDir).toBeNull();
    expect(result.remainingArgs).toEqual(['--count', '5', '--debug']);
  });

  it('extracts --dump-raw with explicit dir', () => {
    const result = extractDumpRaw(['--dump-raw', './mydir', '--count', '5'], 'twitter');
    expect(result.dumpRawDir).toBe('./mydir');
    expect(result.isDefaultDir).toBe(false);
    expect(result.remainingArgs).toEqual(['--count', '5']);
  });

  it('extracts --dump-raw without dir, uses default', () => {
    const result = extractDumpRaw(['--count', '5', '--dump-raw'], 'twitter');
    expect(result.dumpRawDir).toContain('dump');
    expect(result.dumpRawDir).toContain('twitter');
    expect(result.isDefaultDir).toBe(true);
    expect(result.remainingArgs).toEqual(['--count', '5']);
  });

  it('extracts --dump-raw when next arg is another flag', () => {
    const result = extractDumpRaw(['--dump-raw', '--count', '5'], 'twitter');
    expect(result.dumpRawDir).toContain('twitter');
    expect(result.isDefaultDir).toBe(true);
    expect(result.remainingArgs).toEqual(['--count', '5']);
  });
});

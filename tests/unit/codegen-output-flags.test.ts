import { describe, it, expect } from 'vitest';
import { stripOutputFlags } from '../../src/registry/codegen.js';

describe('stripOutputFlags', () => {
  it('extracts --stdout flag', () => {
    const result = stripOutputFlags(['--count', '20', '--stdout']);
    expect(result.stdoutFlag).toBe(true);
    expect(result.pluginArgs).toEqual(['--count', '20']);
  });

  it('extracts --output with path', () => {
    const result = stripOutputFlags(['--output', '/tmp/out.json', '--count', '20']);
    expect(result.outputPath).toBe('/tmp/out.json');
    expect(result.pluginArgs).toEqual(['--count', '20']);
  });

  it('throws if --output has no value', () => {
    expect(() => stripOutputFlags(['--output'])).toThrow('--output requires a file path');
  });

  it('throws if --output value looks like a flag', () => {
    expect(() => stripOutputFlags(['--output', '--count'])).toThrow('--output requires a file path');
  });

  it('passes through all args when no output flags', () => {
    const result = stripOutputFlags(['--count', '20', '--tab', 'for_you']);
    expect(result.stdoutFlag).toBe(false);
    expect(result.outputPath).toBeUndefined();
    expect(result.fields).toBeUndefined();
    expect(result.pluginArgs).toEqual(['--count', '20', '--tab', 'for_you']);
  });

  it('extracts --fields with comma-separated list', () => {
    const result = stripOutputFlags(['--fields', 'author,text,url', '--count', '20']);
    expect(result.fields).toEqual(['author', 'text', 'url']);
    expect(result.pluginArgs).toEqual(['--count', '20']);
  });

  it('throws if --fields has no value', () => {
    expect(() => stripOutputFlags(['--fields'])).toThrow('--fields requires');
  });

  it('throws if --fields value looks like a flag', () => {
    expect(() => stripOutputFlags(['--fields', '--count'])).toThrow('--fields requires');
  });

  it('combines --stdout and --fields', () => {
    const result = stripOutputFlags(['--stdout', '--fields', 'author,text']);
    expect(result.stdoutFlag).toBe(true);
    expect(result.fields).toEqual(['author', 'text']);
    expect(result.pluginArgs).toEqual([]);
  });
});

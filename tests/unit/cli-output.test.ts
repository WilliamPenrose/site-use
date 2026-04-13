import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeOutput, unwrapToolResult } from '../../src/registry/cli-output.js';

describe('unwrapToolResult', () => {
  it('parses successful result', () => {
    const result = {
      content: [{ type: 'text' as const, text: '{"items":[]}' }],
    };
    expect(unwrapToolResult(result)).toEqual({ items: [] });
  });

  it('returns null and sets exitCode on error', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = {
      content: [{ type: 'text' as const, text: '{"type":"PluginError"}' }],
      isError: true,
    };
    expect(unwrapToolResult(result)).toBeNull();
    expect(process.exitCode).toBe(1);
    consoleSpy.mockRestore();
    process.exitCode = undefined as any;
  });
});

describe('writeOutput', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-output-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--stdout writes full JSON to stdout', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const data = { items: [{ id: '1' }], meta: {} };
    writeOutput(data, { stdout: true, siteName: 'twitter', workflowName: 'feed' });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.items).toHaveLength(1);
    consoleSpy.mockRestore();
  });

  it('default writes to file and prints summary to stdout', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outputPath = path.join(tmpDir, 'test-output.json');
    const data = { items: [{ id: '1' }, { id: '2' }], meta: {} };
    writeOutput(data, { stdout: false, outputPath, siteName: 'twitter', workflowName: 'feed' });

    // Verify file written
    expect(fs.existsSync(outputPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(written.items).toHaveLength(2);

    // Verify summary to stdout
    const summary = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(summary.count).toBe(2);
    expect(summary.file).toBe(outputPath);
    consoleSpy.mockRestore();
  });

  it('creates output directory if it does not exist', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outputPath = path.join(tmpDir, 'nested', 'dir', 'output.json');
    writeOutput({ items: [] }, { stdout: false, outputPath, siteName: 'twitter', workflowName: 'feed' });
    expect(fs.existsSync(outputPath)).toBe(true);
    consoleSpy.mockRestore();
  });
});

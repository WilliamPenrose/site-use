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

  it('--fields filters item fields, always keeps id', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const data = {
      items: [
        { id: '1', author: { handle: 'alice' }, text: 'hello', url: 'http://x.com/1', timestamp: '2026-04-13T10:00:00Z' },
      ],
      meta: {},
    };
    writeOutput(data, { stdout: true, fields: ['author', 'text'], siteName: 'twitter', workflowName: 'feed' });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.items[0].author).toEqual({ handle: 'alice' });
    expect(output.items[0].text).toBe('hello');
    expect(output.items[0].id).toBe('1');
    expect(output.items[0].url).toBeUndefined();
    expect(output.items[0].timestamp).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('--fields does not affect non-items data (meta preserved)', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const data = {
      items: [{ id: '1', text: 'hello', url: 'http://x.com/1' }],
      meta: { coveredUsers: ['alice'], timeRange: { from: '2026-04-13', to: '2026-04-13' } },
    };
    writeOutput(data, { stdout: true, fields: ['text'], siteName: 'twitter', workflowName: 'feed' });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.meta.coveredUsers).toEqual(['alice']);
    expect(output.items[0].url).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('--fields with file output filters before writing', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outputPath = path.join(tmpDir, 'fields-output.json');
    const data = {
      items: [{ id: '1', author: 'alice', text: 'hello', url: 'http://x.com/1' }],
    };
    writeOutput(data, { stdout: false, outputPath, fields: ['text'], siteName: 'twitter', workflowName: 'feed' });
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(written.items[0].text).toBe('hello');
    expect(written.items[0].id).toBe('1');
    expect(written.items[0].author).toBeUndefined();
    consoleSpy.mockRestore();
  });
});

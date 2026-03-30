import { describe, it, expect, vi } from 'vitest';
import { unwrapToolResult } from '../../src/registry/cli-output.js';
import { formatCliOutput } from '../../src/registry/cli-output.js';

describe('unwrapToolResult', () => {
  it('returns parsed JSON from successful tool result', () => {
    const result = {
      content: [{ type: 'text' as const, text: '{"items":[1,2,3]}' }],
    };
    expect(unwrapToolResult(result)).toEqual({ items: [1, 2, 3] });
  });

  it('returns null and sets exitCode on error result', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = {
      content: [{ type: 'text' as const, text: '{"type":"SessionExpired","message":"Not logged in"}' }],
      isError: true,
    };
    const data = unwrapToolResult(result);
    expect(data).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith('{"type":"SessionExpired","message":"Not logged in"}');
    logSpy.mockRestore();
    process.exitCode = undefined as any;
  });
});

describe('formatCliOutput', () => {
  it('outputs JSON to stdout in normal mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    formatCliOutput({ items: [{ text: 'hello' }] }, { quiet: false });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.items[0].text).toBe('hello');

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('outputs one-line summary to stderr in quiet mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    formatCliOutput(
      { items: [{ text: 'a' }, { text: 'b' }], meta: { timeRange: { from: '2026-03-30T10:00:00Z', to: '2026-03-30T12:00:00Z' } } },
      { quiet: true, variant: 'for_you' },
    );

    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls[0][0] as string;
    expect(msg).toContain('2 items');

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('shows cache source hint on stderr when source is local', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    formatCliOutput(
      { items: [] },
      { quiet: false, source: 'local', ageMinutes: 5 },
    );

    const stderrOutput = errSpy.mock.calls.map(c => c[0]).join('\n');
    expect(stderrOutput).toContain('cached');
    expect(stderrOutput).toContain('5min');

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('no stderr hint when source is undefined (non-cache path)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    formatCliOutput(
      { items: [{ text: 'hello' }] },
      { quiet: false },  // source omitted → undefined
    );

    expect(logSpy).toHaveBeenCalledOnce();
    expect(errSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('applies fields filter when fields are provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    formatCliOutput(
      { items: [{ id: '1', text: 'hello', author: 'alice', timestamp: '2026-01-01', url: 'http://x.com/1' }] },
      { quiet: false, fields: ['author', 'text'] as any },
    );

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.items[0].author).toBe('alice');
    expect(output.items[0].text).toBe('hello');
    expect(output.items[0].url).toBeUndefined();

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('localizes timestamps before output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    formatCliOutput(
      { items: [{ timestamp: '2026-03-30T10:00:00.000Z' }] },
      { quiet: false },
    );

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(typeof output.items[0].timestamp).toBe('string');

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

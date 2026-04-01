import { describe, it, expect } from 'vitest';
import { Trace, NOOP_TRACE, NOOP_SPAN, type TraceData, type SpanData } from '../trace.js';

describe('Trace', () => {
  it('records a successful span with timing and attrs', async () => {
    const trace = new Trace('test_tool');
    await trace.span('step1', async (s) => {
      s.set('key', 'value');
      s.set('count', 42);
    });
    const data = trace.toJSON();

    expect(data.tool).toBe('test_tool');
    expect(data.status).toBe('ok');
    expect(data.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(data.root.children).toHaveLength(1);

    const span = data.root.children[0];
    expect(span.name).toBe('step1');
    expect(span.status).toBe('ok');
    expect(span.startMs).toBeGreaterThanOrEqual(0);
    expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
    expect(span.attrs).toEqual({ key: 'value', count: 42 });
    expect(span.error).toBeUndefined();
  });

  it('records an error span and propagates the exception', async () => {
    const trace = new Trace('test_tool');
    await expect(
      trace.span('failing', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const data = trace.toJSON();
    expect(data.status).toBe('error');

    const span = data.root.children[0];
    expect(span.status).toBe('error');
    expect(span.error).toBe('boom');
    expect(span.endMs).not.toBeNull();
  });

  it('supports nested spans', async () => {
    const trace = new Trace('test_tool');
    await trace.span('parent', async (p) => {
      await p.span('child1', async (c) => {
        c.set('x', 1);
      });
      await p.span('child2', async (c) => {
        c.set('x', 2);
      });
    });

    const data = trace.toJSON();
    const parent = data.root.children[0];
    expect(parent.name).toBe('parent');
    expect(parent.children).toHaveLength(2);
    expect(parent.children[0].name).toBe('child1');
    expect(parent.children[0].attrs).toEqual({ x: 1 });
    expect(parent.children[1].name).toBe('child2');
    expect(parent.children[1].attrs).toEqual({ x: 2 });
  });

  it('marks parent as error when child throws', async () => {
    const trace = new Trace('test_tool');
    await expect(
      trace.span('parent', async (p) => {
        await p.span('ok_child', async () => {});
        await p.span('bad_child', async () => {
          throw new Error('child failed');
        });
      }),
    ).rejects.toThrow('child failed');

    const data = trace.toJSON();
    const parent = data.root.children[0];
    expect(parent.status).toBe('error');
    expect(parent.children[0].status).toBe('ok');
    expect(parent.children[1].status).toBe('error');
  });

  it('silently ignores set() after span ends', async () => {
    const trace = new Trace('test_tool');
    let capturedSpan: any;
    await trace.span('step', async (s) => {
      capturedSpan = s;
      s.set('during', true);
    });
    // span has ended — set should be silently ignored
    capturedSpan.set('after', true);

    const span = trace.toJSON().root.children[0];
    expect(span.attrs).toEqual({ during: true });
  });

  it('returns span result value', async () => {
    const trace = new Trace('test_tool');
    const result = await trace.span('compute', async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('reports ok when span succeeds', async () => {
    const trace = new Trace('test_tool');
    await trace.span('work', async () => 'done');
    const data = trace.toJSON();
    expect(data.status).toBe('ok');
    expect(data.root.children[0].status).toBe('ok');
  });

  it('reports error when child span throws', async () => {
    const trace = new Trace('test_tool');
    await trace.span('work', async () => {
      throw new Error('boom');
    }).catch(() => {});
    const data = trace.toJSON();
    expect(data.status).toBe('error');
    expect(data.root.children[0].status).toBe('error');
    expect(data.root.children[0].error).toBe('boom');
  });

  it('captures error in trace when handler is wrapped in span', async () => {
    const trace = new Trace('twitter_feed');

    try {
      await trace.span('handler', async () => {
        throw new Error('Input.dispatchMouseEvent timed out');
      });
    } catch {}

    const data = trace.toJSON();
    expect(data.status).toBe('error');
    expect(data.root.children).toHaveLength(1);
    expect(data.root.children[0].name).toBe('handler');
    expect(data.root.children[0].status).toBe('error');
    expect(data.root.children[0].error).toContain('dispatchMouseEvent');
  });
});

describe('NOOP_TRACE', () => {
  it('executes fn without recording', async () => {
    const result = await NOOP_TRACE.span('anything', async (s) => {
      s.set('key', 'value');
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('supports nested spans', async () => {
    const result = await NOOP_TRACE.span('parent', async (s) => {
      return await s.span('child', async () => 99);
    });
    expect(result).toBe(99);
  });

  it('toJSON returns empty trace', () => {
    const data = NOOP_TRACE.toJSON();
    expect(data.tool).toBe('');
    expect(data.root.children).toEqual([]);
  });
});

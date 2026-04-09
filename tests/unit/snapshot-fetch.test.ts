import { describe, it, expect, vi } from 'vitest';
import { fetchAXData } from '../../src/primitives/snapshot/fetch.js';

function mockClient(frameTree: any, axResults: Record<string, any[]>) {
  return {
    send: vi.fn().mockImplementation((method: string, params?: any) => {
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({ frameTree });
      }
      if (method === 'Accessibility.getFullAXTree') {
        const nodes = axResults[params?.frameId] ?? [];
        return Promise.resolve({ nodes });
      }
      return Promise.resolve({});
    }),
  };
}

describe('fetchAXData', () => {
  it('returns AX data for a single frame (no iframes)', async () => {
    const client = mockClient(
      { frame: { id: 'main', url: 'https://example.com', securityOrigin: 'https://example.com' } },
      { main: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'OK' } }] },
    );

    const result = await fetchAXData(client as any);

    expect(result).toHaveLength(1);
    expect(result[0].frameId).toBe('main');
    expect(result[0].frameUrl).toBe('https://example.com');
    expect(result[0].isMainFrame).toBe(true);
    expect(result[0].nodes).toHaveLength(1);
  });

  it('includes same-origin iframe frames', async () => {
    const client = mockClient(
      {
        frame: { id: 'main', url: 'https://app.example.com', securityOrigin: 'https://app.example.com' },
        childFrames: [{
          frame: { id: 'iframe-1', url: 'https://app.example.com/form', securityOrigin: 'https://app.example.com' },
        }],
      },
      {
        main: [{ nodeId: '1', role: { value: 'RootWebArea' } }],
        'iframe-1': [{ nodeId: '2', role: { value: 'button' }, name: { value: 'Submit' } }],
      },
    );

    const result = await fetchAXData(client as any);

    expect(result).toHaveLength(2);
    expect(result[0].frameId).toBe('main');
    expect(result[0].isMainFrame).toBe(true);
    expect(result[1].frameId).toBe('iframe-1');
    expect(result[1].frameUrl).toBe('https://app.example.com/form');
    expect(result[1].isMainFrame).toBe(false);
  });

  it('skips cross-origin iframes (OOPIF)', async () => {
    const client = mockClient(
      {
        frame: { id: 'main', url: 'https://app.example.com', securityOrigin: 'https://app.example.com' },
        childFrames: [{
          frame: { id: 'oopif', url: 'https://ads.thirdparty.com', securityOrigin: 'https://ads.thirdparty.com' },
        }],
      },
      { main: [{ nodeId: '1' }] },
    );

    const result = await fetchAXData(client as any);

    expect(result).toHaveLength(1);
    expect(result[0].frameId).toBe('main');
  });

  it('respects MAX_IFRAME_DEPTH', async () => {
    // Build a chain: main → child → grandchild → ... (7 levels deep)
    function buildDeepTree(depth: number, origin: string): any {
      const frame = { id: `frame-${depth}`, url: `${origin}/d${depth}`, securityOrigin: origin };
      if (depth >= 7) return { frame };
      return { frame, childFrames: [buildDeepTree(depth + 1, origin)] };
    }

    const tree = buildDeepTree(0, 'https://example.com');
    const axResults: Record<string, any[]> = {};
    for (let i = 0; i <= 7; i++) axResults[`frame-${i}`] = [{ nodeId: `n${i}` }];

    const client = mockClient(tree, axResults);
    const result = await fetchAXData(client as any);

    // MAX_IFRAME_DEPTH = 5, so frames at depth 0-5 included, 6-7 excluded
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('respects MAX_IFRAMES count limit', async () => {
    // Build a tree with 120 same-origin sibling iframes
    const origin = 'https://example.com';
    const childFrames = Array.from({ length: 120 }, (_, i) => ({
      frame: { id: `iframe-${i}`, url: `${origin}/f${i}`, securityOrigin: origin },
    }));
    const tree = {
      frame: { id: 'main', url: origin, securityOrigin: origin },
      childFrames,
    };
    const axResults: Record<string, any[]> = { main: [{ nodeId: 'n0' }] };
    for (let i = 0; i < 120; i++) axResults[`iframe-${i}`] = [{ nodeId: `n${i + 1}` }];

    const client = mockClient(tree, axResults);
    const result = await fetchAXData(client as any);

    // MAX_IFRAMES = 100, result should be capped (1 main + at most 99 iframes)
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('handles getFullAXTree failure for a frame gracefully', async () => {
    const client = {
      send: vi.fn().mockImplementation((method: string, params?: any) => {
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: {
              frame: { id: 'main', url: 'https://example.com', securityOrigin: 'https://example.com' },
              childFrames: [{
                frame: { id: 'broken', url: 'https://example.com/broken', securityOrigin: 'https://example.com' },
              }],
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          if (params?.frameId === 'broken') return Promise.reject(new Error('Frame not found'));
          return Promise.resolve({ nodes: [{ nodeId: '1' }] });
        }
        return Promise.resolve({});
      }),
    };

    const result = await fetchAXData(client as any);

    // Main frame succeeds, broken frame is skipped
    expect(result).toHaveLength(1);
    expect(result[0].frameId).toBe('main');
  });

  it('falls back to single-frame when Page.getFrameTree fails (Chrome <120)', async () => {
    const client = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'Page.getFrameTree') return Promise.reject(new Error('not supported'));
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: [{ nodeId: '1', role: { value: 'button' } }] });
        }
        return Promise.resolve({});
      }),
    };

    const result = await fetchAXData(client as any);

    expect(result).toHaveLength(1);
    expect(result[0].isMainFrame).toBe(true);
    expect(result[0].nodes).toHaveLength(1);
  });
});

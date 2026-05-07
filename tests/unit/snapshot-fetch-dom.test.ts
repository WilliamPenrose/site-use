import { describe, it, expect, vi } from 'vitest';
import { fetchSnapshotData } from '../../packages/runtime/src/internal/primitives/snapshot/fetch.js';

describe('fetchSnapshotData', () => {
  it('returns frames + domSnapshot from parallel CDP calls', async () => {
    const session = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: { frame: { id: 'main', url: 'https://x.com', securityOrigin: 'https://x.com' } },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: [{ nodeId: 'a1', role: { value: 'button' }, name: { value: 'X' }, backendDOMNodeId: 1, ignored: false }] });
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          return Promise.resolve({ documents: [{ frame: 'main', nodes: { backendNodeId: [1] } }], strings: ['BUTTON'] });
        }
        return Promise.resolve({});
      }),
    };

    const result = await fetchSnapshotData(session as any);
    expect(result.frames.length).toBe(1);
    expect(result.frames[0].frameId).toBe('main');
    expect(result.domSnapshot.documents.length).toBe(1);
    expect(result.domSnapshot.strings).toEqual(['BUTTON']);
  });

  it('degrades gracefully when DOMSnapshot.captureSnapshot fails', async () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main', url: '', securityOrigin: 'x' } } });
        }
        if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: [] });
        if (method === 'DOMSnapshot.captureSnapshot') return Promise.reject(new Error('not supported'));
        return Promise.resolve({});
      }),
    };

    const result = await fetchSnapshotData(session as any);
    expect(result.domSnapshot.documents).toEqual([]);
    expect(result.domSnapshot.strings).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

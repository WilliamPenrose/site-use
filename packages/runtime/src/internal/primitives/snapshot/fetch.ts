import type { RawFrameAX } from './types.js';
import { MAX_IFRAME_DEPTH, MAX_IFRAMES } from './types.js';

/**
 * Fetch AX tree data from all same-origin frames.
 * Traverses Page.getFrameTree, skips cross-origin iframes (OOPIF),
 * enforces depth and count limits.
 */
export async function fetchAXData(client: any): Promise<RawFrameAX[]> {
  // Graceful degradation: if Page.getFrameTree is unavailable (Chrome <120),
  // fall back to the original single-frame behavior.
  let frameTree: any;
  try {
    ({ frameTree } = await client.send('Page.getFrameTree'));
  } catch {
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    return [{ frameId: '', frameUrl: '', isMainFrame: true, nodes }];
  }

  const mainOrigin = frameTree.frame.securityOrigin;
  const mainFrameId = frameTree.frame.id;

  const frames: Array<{ id: string; url: string; isMainFrame: boolean }> = [];

  function walk(node: any, depth: number): void {
    frames.push({ id: node.frame.id, url: node.frame.url, isMainFrame: node.frame.id === mainFrameId });
    if (depth >= MAX_IFRAME_DEPTH) return;
    for (const child of node.childFrames ?? []) {
      if (frames.length >= MAX_IFRAMES) break;
      if (child.frame.securityOrigin !== mainOrigin) continue;
      walk(child, depth + 1);
    }
  }
  walk(frameTree, 0);

  const results = await Promise.allSettled(
    frames.map(async (f): Promise<RawFrameAX> => {
      const { nodes } = await client.send('Accessibility.getFullAXTree', { frameId: f.id });
      return { frameId: f.id, frameUrl: f.url, isMainFrame: f.isMainFrame, nodes };
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<RawFrameAX> => r.status === 'fulfilled')
    .map(r => r.value);
}

import type { RawFrameAX, RawSnapshotData, RawDomSnapshot } from './types.js';
import { MAX_IFRAME_DEPTH, MAX_IFRAMES } from './types.js';

const EMPTY_DOM: RawDomSnapshot = { documents: [], strings: [] };

/**
 * Fetch snapshot data from all same-origin frames.
 * Combines per-frame AX (M1) and DOMSnapshot.captureSnapshot (M2) in parallel.
 */
export async function fetchSnapshotData(client: any): Promise<RawSnapshotData> {
  let frames: RawFrameAX[];
  try {
    frames = await fetchFrames(client);
  } catch {
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    frames = [{ frameId: '', frameUrl: '', isMainFrame: true, nodes }];
  }

  const domPromise = client.send('DOMSnapshot.captureSnapshot', {
    computedStyles: ['cursor'],
    includePaintOrder: false,
    includeDOMRects: false,
    includeBlendedBackgroundColors: false,
    includeTextColorOpacities: false,
  }).catch((err: any) => {
    console.error(`[site-use] DOMSnapshot.captureSnapshot unavailable, M2 inference disabled this snapshot: ${err?.message ?? err}`);
    return EMPTY_DOM;
  });

  const domSnapshot: RawDomSnapshot = await domPromise;
  return { frames, domSnapshot };
}

async function fetchFrames(client: any): Promise<RawFrameAX[]> {
  const { frameTree } = await client.send('Page.getFrameTree');
  const mainOrigin = frameTree.frame.securityOrigin;
  const mainFrameId = frameTree.frame.id;

  const collected: Array<{ id: string; url: string; isMainFrame: boolean }> = [];
  function walk(node: any, depth: number): void {
    collected.push({ id: node.frame.id, url: node.frame.url, isMainFrame: node.frame.id === mainFrameId });
    if (depth >= MAX_IFRAME_DEPTH) return;
    for (const child of node.childFrames ?? []) {
      if (collected.length >= MAX_IFRAMES) break;
      if (child.frame.securityOrigin !== mainOrigin) continue;
      walk(child, depth + 1);
    }
  }
  walk(frameTree, 0);

  const results = await Promise.allSettled(
    collected.map(async (f): Promise<RawFrameAX> => {
      const { nodes } = await client.send('Accessibility.getFullAXTree', { frameId: f.id });
      return { frameId: f.id, frameUrl: f.url, isMainFrame: f.isMainFrame, nodes };
    }),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<RawFrameAX> => r.status === 'fulfilled')
    .map(r => r.value);
}

// Backward-compat alias used by existing tests/imports
export async function fetchAXData(client: any): Promise<RawFrameAX[]> {
  const { frames } = await fetchSnapshotData(client);
  return frames;
}

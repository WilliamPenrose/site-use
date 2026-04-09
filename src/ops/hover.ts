import type { Primitives } from '../primitives/types.js';

/**
 * Move the mouse to the center of an element identified by CSS selector.
 * Triggers mouseenter/mouseover events for hover-to-reveal UI patterns.
 *
 * Uses evaluate() for coordinates and CDP Input.dispatchMouseEvent for movement.
 * Only for main-frame elements — iframe elements should use backendNodeId path.
 */
export async function hover(primitives: Primitives, selector: string): Promise<void> {
  const rect = await primitives.evaluate<{ x: number; y: number; w: number; h: number } | null>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`,
  );

  // Reject sub-pixel elements (< 1 CSS pixel) — they are effectively invisible
  // and cannot be meaningfully hovered. This catches display:none (0×0) and
  // fractional-pixel elements from CSS transforms.
  if (!rect || rect.w < 1 || rect.h < 1) {
    throw new Error(`hover: element not found or zero-size for selector "${selector}"`);
  }

  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
    });
  } finally {
    await cdp.detach();
  }
}

import { describe, it, expect } from 'vitest';
import { ClickableElementDetector } from '../../packages/runtime/src/internal/primitives/snapshot/clickable-detector.js';
import type { DomEntry, DomLookup } from '../../packages/runtime/src/internal/primitives/snapshot/types.js';

function makeEntry(partial: Partial<DomEntry>): DomEntry {
  return {
    backendNodeId: 1, frameId: 'main', parentBackendNodeId: null,
    tag: 'div', attributes: {}, bounds: null, cursorStyle: null,
    isClickable: false, nodeType: 1, nodeValue: null,
    ...partial,
  };
}
const empty: DomLookup = new Map();

describe('ClickableElementDetector.isInteractive', () => {
  it('skips html and body', () => {
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'html' }), null, empty)).toBe(false);
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'body' }), null, empty)).toBe(false);
  });

  it('skips non-element nodes', () => {
    expect(ClickableElementDetector.isInteractive(makeEntry({ nodeType: 3 }), null, empty)).toBe(false);
  });

  it('matches interactive_tags', () => {
    for (const tag of ['button', 'input', 'select', 'textarea', 'a', 'details', 'summary', 'option', 'optgroup']) {
      expect(ClickableElementDetector.isInteractive(makeEntry({ tag }), null, empty)).toBe(true);
    }
  });

  it('iframe ≥100×100 is interactive', () => {
    const big = makeEntry({ tag: 'iframe', bounds: { x: 0, y: 0, width: 200, height: 200 } });
    expect(ClickableElementDetector.isInteractive(big, null, empty)).toBe(true);
  });

  it('iframe <100×100 is NOT interactive', () => {
    const small = makeEntry({ tag: 'iframe', bounds: { x: 0, y: 0, width: 50, height: 50 } });
    expect(ClickableElementDetector.isInteractive(small, null, empty)).toBe(false);
  });

  it('plain div with no signals is NOT interactive', () => {
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'div' }), null, empty)).toBe(false);
  });
});

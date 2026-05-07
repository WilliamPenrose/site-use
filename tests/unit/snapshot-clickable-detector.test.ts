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

  it('isClickable=true marks div as interactive (DOMSnapshot click-listener signal)', () => {
    const e = makeEntry({ tag: 'div', isClickable: true });
    expect(ClickableElementDetector.isInteractive(e, null, empty)).toBe(true);
  });

  it('cursor:pointer fallback marks div as interactive', () => {
    const e = makeEntry({ tag: 'div', cursorStyle: 'pointer' });
    expect(ClickableElementDetector.isInteractive(e, null, empty)).toBe(true);
  });

  it('cursor:default on plain div does not trigger', () => {
    const e = makeEntry({ tag: 'div', cursorStyle: 'default' });
    expect(ClickableElementDetector.isInteractive(e, null, empty)).toBe(false);
  });

  it('AX disabled excludes even when other signals fire', () => {
    const e = makeEntry({ tag: 'div', cursorStyle: 'pointer' });
    const ax = { properties: [{ name: 'disabled', value: { value: true } }] };
    expect(ClickableElementDetector.isInteractive(e, ax, empty)).toBe(false);
  });

  it('AX hidden excludes', () => {
    const e = makeEntry({ tag: 'button' });
    const ax = { properties: [{ name: 'hidden', value: { value: true } }] };
    expect(ClickableElementDetector.isInteractive(e, ax, empty)).toBe(false);
  });

  it('AX focusable=true marks interactive', () => {
    const e = makeEntry({ tag: 'div' });
    const ax = { properties: [{ name: 'focusable', value: { value: true } }] };
    expect(ClickableElementDetector.isInteractive(e, ax, empty)).toBe(true);
  });

  it('AX checked/expanded/pressed/selected presence marks interactive', () => {
    for (const name of ['checked', 'expanded', 'pressed', 'selected']) {
      const ax = { properties: [{ name, value: { value: false } }] };
      expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'div' }), ax, empty)).toBe(true);
    }
  });

  it('onclick attribute marks interactive', () => {
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'div', attributes: { onclick: 'foo()' } }), null, empty)).toBe(true);
  });

  it('tabindex attribute marks interactive', () => {
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'div', attributes: { tabindex: '0' } }), null, empty)).toBe(true);
  });

  it('role="button" attribute marks interactive', () => {
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'div', attributes: { role: 'button' } }), null, empty)).toBe(true);
  });

  it('AX role=link marks interactive', () => {
    const ax = { role: { value: 'link' }, properties: [] };
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'div' }), ax, empty)).toBe(true);
  });

  it('search indicator in class marks interactive', () => {
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'div', attributes: { class: 'search-btn primary' } }), null, empty)).toBe(true);
  });

  it('search indicator in id marks interactive', () => {
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'div', attributes: { id: 'magnify-glass' } }), null, empty)).toBe(true);
  });

  it('search indicator in data-* marks interactive', () => {
    expect(ClickableElementDetector.isInteractive(makeEntry({ tag: 'div', attributes: { 'data-action': 'lookup' } }), null, empty)).toBe(true);
  });

  it('icon-sized element with class attr marks interactive', () => {
    const e = makeEntry({ tag: 'span', bounds: { x: 0, y: 0, width: 24, height: 24 }, attributes: { class: 'icon close' } });
    expect(ClickableElementDetector.isInteractive(e, null, empty)).toBe(true);
  });

  it('icon-sized element with no relevant attrs is not interactive', () => {
    const e = makeEntry({ tag: 'span', bounds: { x: 0, y: 0, width: 24, height: 24 }, attributes: { lang: 'en' } });
    expect(ClickableElementDetector.isInteractive(e, null, empty)).toBe(false);
  });
});

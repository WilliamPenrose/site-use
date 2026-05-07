import { describe, it, expect } from 'vitest';
import { deriveDomName } from '../../packages/runtime/src/internal/primitives/snapshot/derive-name.js';
import type { DomEntry, DomLookup } from '../../packages/runtime/src/internal/primitives/snapshot/types.js';

function makeEntry(p: Partial<DomEntry>): DomEntry {
  return {
    backendNodeId: 1, frameId: 'main', parentBackendNodeId: null,
    tag: 'div', attributes: {}, bounds: null, cursorStyle: null,
    isClickable: false, nodeType: 1, nodeValue: null, ...p,
  };
}

describe('deriveDomName', () => {
  it('aria-label wins over title', () => {
    const e = makeEntry({ attributes: { 'aria-label': 'Send', title: 'Submit' } });
    expect(deriveDomName(e, new Map())).toBe('Send');
  });

  it('title fallback when no aria-label', () => {
    const e = makeEntry({ attributes: { title: 'Hello' } });
    expect(deriveDomName(e, new Map())).toBe('Hello');
  });

  it('placeholder fallback when no aria/title/text', () => {
    const e = makeEntry({ attributes: { placeholder: 'Search…' } });
    expect(deriveDomName(e, new Map())).toBe('Search…');
  });

  it('returns empty string when nothing available', () => {
    expect(deriveDomName(makeEntry({}), new Map())).toBe('');
  });

  it('trims whitespace', () => {
    const e = makeEntry({ attributes: { 'aria-label': '   Click me   ' } });
    expect(deriveDomName(e, new Map())).toBe('Click me');
  });

  it('truncates strings >80 chars with ellipsis', () => {
    const long = 'a'.repeat(100);
    const e = makeEntry({ attributes: { title: long } });
    const out = deriveDomName(e, new Map());
    expect(out.length).toBe(81);
    expect(out.endsWith('…')).toBe(true);
  });

  it('aggregates direct text child', () => {
    const lookup: DomLookup = new Map();
    const div = makeEntry({ backendNodeId: 1, tag: 'div' });
    const text = makeEntry({ backendNodeId: 2, parentBackendNodeId: 1, nodeType: 3, nodeValue: '页面价 ▾' });
    lookup.set(1, div); lookup.set(2, text);
    expect(deriveDomName(div, lookup)).toBe('页面价 ▾');
  });

  it('aggregates nested text descendants in document order', () => {
    const lookup: DomLookup = new Map();
    const div   = makeEntry({ backendNodeId: 1, tag: 'div' });
    const span1 = makeEntry({ backendNodeId: 2, tag: 'span', parentBackendNodeId: 1 });
    const t1    = makeEntry({ backendNodeId: 3, parentBackendNodeId: 2, nodeType: 3, nodeValue: 'Hello ' });
    const span2 = makeEntry({ backendNodeId: 4, tag: 'span', parentBackendNodeId: 1 });
    const t2    = makeEntry({ backendNodeId: 5, parentBackendNodeId: 4, nodeType: 3, nodeValue: 'World' });
    lookup.set(1, div); lookup.set(2, span1); lookup.set(3, t1); lookup.set(4, span2); lookup.set(5, t2);
    expect(deriveDomName(div, lookup)).toBe('Hello World');
  });

  it('aria-label still wins over text content', () => {
    const lookup: DomLookup = new Map();
    const div = makeEntry({ backendNodeId: 1, tag: 'div', attributes: { 'aria-label': 'Real Name' } });
    const text = makeEntry({ backendNodeId: 2, parentBackendNodeId: 1, nodeType: 3, nodeValue: 'visible text' });
    lookup.set(1, div); lookup.set(2, text);
    expect(deriveDomName(div, lookup)).toBe('Real Name');
  });
});

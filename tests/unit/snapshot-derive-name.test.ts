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
});

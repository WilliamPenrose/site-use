import type { DomEntry, DomLookup } from './types.js';

const MAX_NAME_LEN = 80;

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string): string {
  return s.length > MAX_NAME_LEN ? s.slice(0, MAX_NAME_LEN) + '…' : s;
}

function buildChildrenIndex(lookup: DomLookup): Map<number, number[]> {
  const idx = new Map<number, number[]>();
  for (const [bid, e] of lookup) {
    if (e.parentBackendNodeId == null) continue;
    if (!idx.has(e.parentBackendNodeId)) idx.set(e.parentBackendNodeId, []);
    idx.get(e.parentBackendNodeId)!.push(bid);
  }
  return idx;
}

const childrenIndexCache: WeakMap<DomLookup, Map<number, number[]>> = new WeakMap();

function getChildren(lookup: DomLookup, backendId: number): number[] {
  let idx = childrenIndexCache.get(lookup);
  if (!idx) {
    idx = buildChildrenIndex(lookup);
    childrenIndexCache.set(lookup, idx);
  }
  return idx.get(backendId) ?? [];
}

function collectTextDescendants(entry: DomEntry, lookup: DomLookup): string {
  const parts: string[] = [];
  const stack: number[] = [...getChildren(lookup, entry.backendNodeId)];
  for (let i = 0; i < stack.length; i++) {
    const child = lookup.get(stack[i]);
    if (!child) continue;
    if (child.nodeType === 3 && child.nodeValue) {
      parts.push(child.nodeValue);
    } else if (child.nodeType === 1) {
      stack.push(...getChildren(lookup, child.backendNodeId));
    }
  }
  return parts.join('');
}

/**
 * Derive a human-readable name for an inferred or upgraded button-like node.
 * Priority: aria-label > title > descendant text content > placeholder > "".
 */
export function deriveDomName(entry: DomEntry, domLookup: DomLookup): string {
  const aria = entry.attributes['aria-label'];
  if (aria) {
    const out = clean(aria);
    if (out) return truncate(out);
  }

  const title = entry.attributes['title'];
  if (title) {
    const out = clean(title);
    if (out) return truncate(out);
  }

  const text = collectTextDescendants(entry, domLookup);
  const cleaned = clean(text);
  if (cleaned) return truncate(cleaned);

  const placeholder = entry.attributes['placeholder'];
  if (placeholder) {
    const out = clean(placeholder);
    if (out) return truncate(out);
  }

  return '';
}

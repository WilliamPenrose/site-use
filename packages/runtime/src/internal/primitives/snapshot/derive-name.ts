import type { DomEntry, DomLookup } from './types.js';

const MAX_NAME_LEN = 80;

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string): string {
  return s.length > MAX_NAME_LEN ? s.slice(0, MAX_NAME_LEN) + '…' : s;
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

  // Descendant text aggregation (Task 12)

  const placeholder = entry.attributes['placeholder'];
  if (placeholder) {
    const out = clean(placeholder);
    if (out) return truncate(out);
  }

  return '';
}

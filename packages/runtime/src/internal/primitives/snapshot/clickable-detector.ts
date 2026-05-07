import type { DomEntry, DomLookup } from './types.js';

const INTERACTIVE_TAGS = new Set([
  'button', 'input', 'select', 'textarea', 'a', 'details', 'summary', 'option', 'optgroup',
]);

export class ClickableElementDetector {
  /**
   * Decide if a DOM node should be treated as interactive.
   * Port of browser-use's clickable_elements.py (Python). 9 heuristic branches.
   *
   * @param entry  The DOM node from hydrated DomLookup.
   * @param axNode The AX node sharing the same backendNodeId, or null if AX dropped it.
   * @param domLookup Used by descendant traversal heuristics (label/span with form control).
   */
  static isInteractive(entry: DomEntry, axNode: any | null, domLookup: DomLookup): boolean {
    if (entry.nodeType !== 1) return false;
    if (entry.tag === 'html' || entry.tag === 'body') return false;

    // iframe ≥100×100 is interactive (might be scrollable)
    if (entry.tag === 'iframe' || entry.tag === 'frame') {
      if (entry.bounds && entry.bounds.width > 100 && entry.bounds.height > 100) return true;
      return false;
    }

    // Native interactive tags
    if (INTERACTIVE_TAGS.has(entry.tag)) return true;

    return false;
  }
}

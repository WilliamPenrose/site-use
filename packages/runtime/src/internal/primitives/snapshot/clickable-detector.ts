import type { DomEntry, DomLookup } from './types.js';

const INTERACTIVE_TAGS = new Set([
  'button', 'input', 'select', 'textarea', 'a', 'details', 'summary', 'option', 'optgroup',
]);

const INTERACTIVE_ATTRS = new Set(['onclick', 'onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'tabindex']);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab',
  'textbox', 'combobox', 'slider', 'spinbutton',
  'search', 'searchbox', 'row', 'cell', 'gridcell',
]);

const SEARCH_INDICATORS = ['search', 'magnify', 'glass', 'lookup', 'find', 'query', 'searchbox'];
const ICON_ATTRS = new Set(['class', 'role', 'onclick', 'data-action', 'aria-label']);

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

    // AX property checks — must come before positive-signal short-circuits
    // because disabled/hidden override everything else
    if (axNode?.properties) {
      for (const prop of axNode.properties) {
        const name = prop.name;
        const value = prop.value?.value;
        if ((name === 'disabled' || name === 'hidden') && value) return false;
      }
      for (const prop of axNode.properties) {
        const name = prop.name;
        const value = prop.value?.value;
        if ((name === 'focusable' || name === 'editable' || name === 'settable') && value) return true;
        if (name === 'checked' || name === 'expanded' || name === 'pressed' || name === 'selected') return true;
        if ((name === 'required' || name === 'autocomplete') && value) return true;
        if (name === 'keyshortcuts' && value) return true;
      }
    }

    // Search indicators in class / id / data-*
    const cls = (entry.attributes['class'] ?? '').toLowerCase();
    if (cls && SEARCH_INDICATORS.some(ind => cls.includes(ind))) return true;
    const id = (entry.attributes['id'] ?? '').toLowerCase();
    if (id && SEARCH_INDICATORS.some(ind => id.includes(ind))) return true;
    for (const [name, value] of Object.entries(entry.attributes)) {
      if (name.startsWith('data-')) {
        const v = value.toLowerCase();
        if (SEARCH_INDICATORS.some(ind => v.includes(ind))) return true;
      }
    }

    // Native interactive tags
    if (INTERACTIVE_TAGS.has(entry.tag)) return true;

    // DOMSnapshot.isClickable — Chrome's native "this node has click listener" signal
    // (replaces browser-use's has_js_click_listener via Runtime.evaluate getEventListeners)
    if (entry.isClickable) return true;

    // Cursor pointer — final fallback for Vue/React style-driven interactives
    if (entry.cursorStyle === 'pointer') return true;

    // Attribute-level interactive signals
    for (const attr of Object.keys(entry.attributes)) {
      if (INTERACTIVE_ATTRS.has(attr)) return true;
    }

    // role attribute -> interactive
    const roleAttr = entry.attributes['role'];
    if (roleAttr && INTERACTIVE_ROLES.has(roleAttr)) return true;

    // AX role -> interactive
    const axRole = axNode?.role?.value;
    if (axRole && INTERACTIVE_ROLES.has(axRole)) return true;

    // Icon-sized elements with interactive-suggesting attrs
    if (entry.bounds &&
        entry.bounds.width >= 10 && entry.bounds.width <= 50 &&
        entry.bounds.height >= 10 && entry.bounds.height <= 50) {
      for (const attr of Object.keys(entry.attributes)) {
        if (ICON_ATTRS.has(attr)) return true;
      }
    }

    return false;
  }
}

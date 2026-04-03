import { StateTransitionFailed } from '../errors.js';

export interface TabInfo {
  name: string;
  index: number;
}

export class TabNotFoundError extends StateTransitionFailed {
  public readonly availableTabs: string[];

  constructor(input: string, availableTabs: string[]) {
    super(
      `Tab "${input}" not found. Available tabs: ${availableTabs.join(', ')}`,
      { step: 'matchTab' },
    );
    this.availableTabs = availableTabs;
  }
}

/**
 * Normalize a tab name for comparison:
 * Unicode NFC → lowercase → underscores to spaces → collapse whitespace → trim
 */
function normalizeTabName(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match user input to a discovered tab.
 *
 * Matching chain:
 * 1. Normalize both input and tab names, exact match
 * 2. If wellKnown provided, check if input is a well-known alias → match by index
 * 3. Throw TabNotFoundError with available tab names
 */
export function matchTab(
  input: string,
  tabs: TabInfo[],
  wellKnown?: Record<string, number>,
): TabInfo {
  const normalizedInput = normalizeTabName(input);

  const textMatch = tabs.find(t => normalizeTabName(t.name) === normalizedInput);
  if (textMatch) return textMatch;

  if (wellKnown) {
    const index = wellKnown[normalizedInput.replace(/ /g, '_')];
    if (index !== undefined && index < tabs.length) {
      return tabs[index];
    }
    const rawIndex = wellKnown[input];
    if (rawIndex !== undefined && rawIndex < tabs.length) {
      return tabs[rawIndex];
    }
  }

  throw new TabNotFoundError(input, tabs.map(t => t.name));
}

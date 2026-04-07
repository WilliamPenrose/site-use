import type { Primitives } from '../primitives/types.js';
import { makeEnsureState } from './ensure-state.js';
import { StateTransitionFailed } from '../errors.js';

export interface TabInfo {
  name: string;
  index: number;
}

export interface DiscoverOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface EnsureTabResult {
  action: 'already_there' | 'transitioned';
  availableTabs: string[];
  /**
   * If the matched tab corresponds to a well-known alias, this is the
   * locale-independent canonical key (e.g. `following`) — *not* the DOM
   * textContent (which would be `フォロー中` on Japanese Twitter). When
   * matching falls outside the well-known set, this is undefined and the
   * caller should use the user-supplied input or `matched.name` directly.
   *
   * Lets sites converge cross-locale fetches of the same well-known tab
   * onto a single storage / cache key.
   */
  wellKnownKey?: string;
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

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 500;

/**
 * Read all tab elements from the DOM via querySelectorAll.
 * Polls until at least one tab appears (SPA may still be rendering).
 *
 * @param tabSelector - CSS selector for tab elements. Must be a trusted constant —
 *   interpolated into evaluate() without escaping. Do not pass user input.
 */
export async function discoverTabs(
  primitives: Primitives,
  tabSelector: string,
  opts: DiscoverOptions = {},
): Promise<TabInfo[]> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const raw = await primitives.evaluate<string>(`(() => {
      const tabs = document.querySelectorAll('${tabSelector}');
      return JSON.stringify(Array.from(tabs).map((t, i) => ({
        name: t.textContent?.trim() ?? '',
        index: i,
      })));
    })()`);

    const tabs: TabInfo[] = JSON.parse(raw).filter((t: TabInfo) => t.name);
    if (tabs.length > 0) return tabs;

    await new Promise(r => setTimeout(r, pollMs));
  }

  throw new StateTransitionFailed(
    `No tabs found in DOM after ${timeoutMs}ms`,
    { step: `discoverTabs: polling ${tabSelector}` },
  );
}

/**
 * Ensure a specific tab is selected. Site-agnostic — tabSelector and wellKnown
 * are passed by the calling site.
 *
 * Flow: discoverTabs → matchTab → scrollIntoView → ensure click via ARIA path
 */
export async function ensureTab(
  primitives: Primitives,
  tabName: string,
  tabSelector: string,
  wellKnown?: Record<string, number>,
): Promise<EnsureTabResult> {
  // Discover tabs, then try to match. If the target is not a well-known alias
  // and not found, poll longer — pinned List/Community tabs may still be rendering.
  let tabs = await discoverTabs(primitives, tabSelector);
  let matched: TabInfo | undefined;
  try {
    matched = matchTab(tabName, tabs, wellKnown);
  } catch (err) {
    if (!(err instanceof TabNotFoundError)) throw err;
    // Well-known tabs (for_you, following) should always be in the first 2 tabs.
    // If matchTab failed for a well-known alias, something is wrong — don't retry.
    const normalizedInput = tabName.normalize('NFC').toLowerCase().replace(/_/g, ' ').trim();
    const isWellKnown = wellKnown && (
      wellKnown[normalizedInput.replace(/ /g, '_')] !== undefined ||
      wellKnown[tabName] !== undefined
    );
    if (isWellKnown) throw err;

    // Non-well-known tab: poll for more tabs to appear (pinned tabs load later).
    // Use a longer timeout — page may have just navigated/reloaded and pinned tabs
    // render significantly later than the default For you / Following tabs.
    const PINNED_TAB_TIMEOUT_MS = 15_000;
    const deadline = Date.now() + PINNED_TAB_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, DEFAULT_POLL_MS));
      tabs = await discoverTabs(primitives, tabSelector, { timeoutMs: 3000 });
      try {
        matched = matchTab(tabName, tabs, wellKnown);
        break;
      } catch { /* keep polling */ }
    }
    if (!matched) throw err;
  }

  // scrollIntoView via evaluate() because no ARIA snapshot/uid exists yet —
  // the snapshot is taken inside makeEnsureState below.
  await primitives.evaluate(`(() => {
    const tabs = document.querySelectorAll('${tabSelector}');
    tabs[${matched.index}]?.scrollIntoView({ inline: 'center', behavior: 'smooth' });
  })()`);

  // ARIA path click via ensure-state.
  // Use RegExp for name matching: ARIA tree may have trailing whitespace
  // that DOM textContent.trim() strips (observed on pinned Community tabs).
  const escaped = matched.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(`^\\s*${escaped}\\s*$`);
  const ensure = makeEnsureState(primitives);
  const result = await ensure({ role: 'tab', name: namePattern, selected: true });
  const availableTabs = tabs.map(t => t.name);

  // Reverse-lookup the well-known key from the matched DOM index. This lets
  // callers store a locale-independent canonical key for tabs like for_you /
  // following — `matched.name` would be the localized DOM text (e.g. フォロー中
  // on Japanese Twitter), which would split storage across locales.
  let wellKnownKey: string | undefined;
  if (wellKnown) {
    for (const [key, idx] of Object.entries(wellKnown)) {
      if (idx === matched.index) {
        wellKnownKey = key;
        break;
      }
    }
  }

  return { action: result.action, availableTabs, wellKnownKey };
}

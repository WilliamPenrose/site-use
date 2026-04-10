import type { Primitives } from '../../primitives/types.js';
import { IMPACT_DISCOVERY_URL } from './site.js';
import { ElementNotFound } from '../../errors.js';

const SEARCH_INPUT_SELECTOR = 'input[data-testid="uicl-input"][placeholder="Search"]';
const CARD_SELECTOR = '.discovery-card';

/**
 * Navigate to discovery page and perform a keyword search.
 * Clears any existing search, types the keyword, and presses Enter.
 */
export async function searchKeyword(
  primitives: Primitives,
  keyword: string,
): Promise<void> {
  await primitives.navigate(IMPACT_DISCOVERY_URL);

  // Ensure we're on "All Partners" tab. Hash changes on the same base URL
  // may not trigger a full page reload — Vue router can ignore them.
  const onAllPartners = await primitives.evaluate<boolean>(
    `window.location.hash.includes('businessModels=all')`,
  );
  if (!onAllPartners) {
    // Force hash update + wait for Vue to react
    await primitives.evaluate(
      `window.location.hash = 'businessModels=all&partnerStatuses=1&relationshipInclusions=prospecting&sortBy=reachRating&sortOrder=DESC'`,
    );
    await new Promise(r => setTimeout(r, 3000));
  }

  // Wait for search input to appear (page may take a few seconds to render)
  const inputDeadline = Date.now() + 10_000;
  while (Date.now() < inputDeadline) {
    const hasInput = await primitives.evaluate<boolean>(
      `!!document.querySelector('${SEARCH_INPUT_SELECTOR}')`,
    );
    if (hasInput) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const hasInput = await primitives.evaluate<boolean>(
    `!!document.querySelector('${SEARCH_INPUT_SELECTOR}')`,
  );
  if (!hasInput) {
    throw new ElementNotFound('Search input not found on discovery page');
  }

  // Clear existing text before typing new keyword.
  // ⚠️ Uses synthetic `input` Event to trigger Vue reactivity after programmatic
  // value clear. This is NOT a MouseEvent/click — it's an input notification that
  // browsers fire natively on every keystroke. Anti-detection risk is negligible
  // compared to synthetic click events prohibited by §2.
  await primitives.evaluate(`(() => {
    const input = document.querySelector('${SEARCH_INPUT_SELECTOR}');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  })()`);
  await new Promise(r => setTimeout(r, 300));

  // Type keyword using snapshot → find textbox → primitives.type
  const snapshot = await primitives.takeSnapshot();
  let searchUid: string | null = null;
  for (const [uid, node] of snapshot.idToNode) {
    if (node.role === 'textbox' && node.focused) {
      searchUid = uid;
      break;
    }
  }
  if (!searchUid) {
    throw new ElementNotFound('Cannot find focused search textbox in AX snapshot');
  }

  await primitives.type(searchUid, keyword);
  await primitives.pressKey('Enter');

  // Search clears all cards then reloads — wait for cards to reappear.
  // Observed latency: ~6s on real network. Poll up to 15s.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
    const count = await countCards(primitives);
    if (count > 0) return;
  }
  // No cards after timeout — keyword may have zero results (not an error)
}

/**
 * Count currently visible cards on the page.
 */
export async function countCards(primitives: Primitives): Promise<number> {
  return primitives.evaluate<number>(
    `document.querySelectorAll('${CARD_SELECTOR}').length`,
  );
}

/**
 * Scroll down to trigger infinite scroll, wait for new cards.
 * Returns true if new cards appeared, false if list is exhausted.
 *
 * ⚠️ CDP escape hatch — Why not primitives.scroll?
 * The card list is inside an inner scrollable container (overflow-y: auto),
 * not the window. primitives.scroll dispatches wheel events at the window
 * level which has no effect. We must find the scrollable ancestor of
 * .discovery-card and set its scrollTop directly.
 */
export async function scrollForMore(
  primitives: Primitives,
): Promise<boolean> {
  const before = await countCards(primitives);

  // Scroll the inner container that holds the card grid to its bottom
  await primitives.evaluate(`(() => {
    const card = document.querySelector('${CARD_SELECTOR}');
    if (!card) return;
    let el = card.parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY !== 'visible') {
        el.scrollTop = el.scrollHeight;
        return;
      }
      el = el.parentElement;
    }
  })()`);

  // Wait up to 10s for new cards to load (network latency can vary)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const after = await countCards(primitives);
    if (after > before) return true;
  }
  return false;
}

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

  // Clear existing text and type keyword
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
 */
export async function scrollForMore(
  primitives: Primitives,
): Promise<boolean> {
  const before = await countCards(primitives);
  await primitives.scroll({ direction: 'down', amount: 800 });
  // Wait up to 5s for new cards
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const after = await countCards(primitives);
    if (after > before) return true;
  }
  return false;
}

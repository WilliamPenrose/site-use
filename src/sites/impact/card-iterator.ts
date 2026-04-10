import type { Primitives } from '../../primitives/types.js';
import { hover } from '../../ops/hover.js';
import { findByDescriptor } from '../../ops/matchers.js';
import { ElementNotFound } from '../../errors.js';

const CARD_SELECTOR = '.discovery-card';

export interface CardInfo {
  partnerName: string;
  partnerId: string;
  /** Index in DOM for hover targeting */
  cardIndex: number;
}

/**
 * Extract all visible cards' partner info from the DOM.
 * Uses avatar img src to extract partner ID.
 * Tracks by partnerId, not DOM index (cards may disappear after send).
 */
export async function extractVisibleCards(
  primitives: Primitives,
): Promise<CardInfo[]> {
  return primitives.evaluate<CardInfo[]>(`(() => {
    const cards = document.querySelectorAll('${CARD_SELECTOR}');
    return Array.from(cards).map((card, i) => {
      const name = card.querySelector('.name .text-ellipsis')?.textContent?.trim() ?? '';
      const img = card.querySelector('img');
      const src = img?.src ?? '';
      const idMatch = src.match(/\\/(\\d+)$/);
      const partnerId = idMatch ? idMatch[1] : '';
      return { partnerName: name, partnerId, cardIndex: i };
    }).filter(c => c.partnerId !== '');
  })()`);
}

/**
 * Hover over a card by its DOM index to reveal the "Send Proposal" button.
 */
export async function hoverCard(
  primitives: Primitives,
  cardIndex: number,
): Promise<void> {
  await hover(primitives, `${CARD_SELECTOR}:nth-child(${cardIndex + 1})`);
  // Wait for Vue @mouseenter to flip display:none → visible
  await new Promise(r => setTimeout(r, 500));
}

/**
 * After hovering, find the "Send Proposal" button in the AX snapshot and click it.
 * Uses DOM-to-ARIA bridge: read button text via evaluate (scoped to card),
 * then find in snapshot by role+name.
 */
export async function clickSendProposal(
  primitives: Primitives,
  cardIndex: number,
): Promise<void> {
  // Read button text from DOM (locale-safe: impact.com is English-only)
  const btnText = await primitives.evaluate<string | null>(`(() => {
    const card = document.querySelectorAll('${CARD_SELECTOR}')[${cardIndex}];
    const btn = card?.querySelector('button[data-testid="uicl-button"]');
    if (!btn || getComputedStyle(btn).display === 'none') return null;
    return btn.textContent?.trim() ?? null;
  })()`);

  if (!btnText) {
    throw new ElementNotFound(
      `"Send Proposal" button not visible on card ${cardIndex} after hover`,
    );
  }

  const snapshot = await primitives.takeSnapshot();
  const node = findByDescriptor(snapshot, { role: 'button', name: btnText });
  if (!node) {
    throw new ElementNotFound(
      `AX node for button "${btnText}" not found in snapshot`,
    );
  }
  await primitives.click(node.uid);
}

/**
 * Check if a card has a "already sent" UI indicator.
 * Returns true if the card shows signs of a prior proposal.
 * Currently checks badge-container content — TBD exact element.
 */
export async function isAlreadySent(
  primitives: Primitives,
  cardIndex: number,
): Promise<boolean> {
  return primitives.evaluate<boolean>(`(() => {
    const card = document.querySelectorAll('${CARD_SELECTOR}')[${cardIndex}];
    const badge = card?.querySelector('.badge-container');
    // If badge has visible content, assume already contacted
    return badge ? badge.innerHTML.trim().length > 10 : false;
  })()`);
}

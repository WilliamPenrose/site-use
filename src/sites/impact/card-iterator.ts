import type { Primitives } from '../../primitives/types.js';
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
 * Resolve a card's current DOM index by partnerId.
 * Cards may disappear after a successful send (spec §2.8), shifting indices.
 * Always call this before interacting with a card to get a fresh index.
 * Returns -1 if the card is no longer in the DOM.
 */
export async function resolveCardIndex(
  primitives: Primitives,
  partnerId: string,
): Promise<number> {
  return primitives.evaluate<number>(`(() => {
    const cards = document.querySelectorAll('${CARD_SELECTOR}');
    for (let i = 0; i < cards.length; i++) {
      const img = cards[i].querySelector('img');
      const src = img?.src ?? '';
      if (src.endsWith('/${partnerId}')) return i;
    }
    return -1;
  })()`);
}

/**
 * Hover over a card by its querySelectorAll index to reveal the "Send Proposal" button.
 * Each .discovery-card is the sole child of its own .iui-card wrapper,
 * so :nth-child cannot be used. Instead, get bounding rect via evaluate
 * and dispatch mouseMoved via CDP.
 */
export async function hoverCard(
  primitives: Primitives,
  cardIndex: number,
): Promise<void> {
  // scrollIntoView first, then get fresh viewport-relative coordinates
  const rect = await primitives.evaluate<{ x: number; y: number; w: number; h: number } | null>(`(() => {
    const card = document.querySelectorAll('${CARD_SELECTOR}')[${cardIndex}];
    if (!card) return null;
    card.scrollIntoView({ block: 'center' });
    const r = card.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);

  if (!rect || rect.w < 1 || rect.h < 1) {
    throw new ElementNotFound(`Card at index ${cardIndex} not found or zero-size`);
  }
  await new Promise(r => setTimeout(r, 200)); // Let scroll settle

  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    // Move mouse away first, then into card — triggers mouseenter event
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await new Promise(r => setTimeout(r, 100));
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
    });
  } finally {
    await cdp.detach();
  }

  // Wait for Vue @mouseenter to flip display:none → visible
  await new Promise(r => setTimeout(r, 800));
}

/**
 * After hovering, click the "Send Proposal" button on the card.
 * DOM-to-ARIA bridge: read button text via evaluate (scoped to card),
 * then match in AX snapshot and click via primitives.click(uid) (Bezier trajectory).
 * Main-frame clicks MUST go through primitives for anti-detection.
 */
export async function clickSendProposal(
  primitives: Primitives,
  cardIndex: number,
): Promise<void> {
  // Read button text from DOM (impact.com is English-only per spec §2.1)
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

  // Find in AX snapshot and click via Bezier trajectory
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
 *
 * NOTE: The exact indicator element is TBD (spec §2.4). All tested cards
 * had an empty .badge-container. This function is a stub that always
 * returns false until a card with an existing relationship is found
 * and the indicator element is identified.
 */
export async function isAlreadySent(
  _primitives: Primitives,
  _cardIndex: number,
): Promise<boolean> {
  // TODO: identify the actual "already sent" indicator element.
  // Returning false to avoid false positives that skip valid cards.
  return false;
}

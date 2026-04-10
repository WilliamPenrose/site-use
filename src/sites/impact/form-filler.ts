import type { Primitives } from '../../primitives/types.js';
import { ElementNotFound, StateTransitionFailed } from '../../errors.js';
import type { SubstitutionContext } from './types.js';
import { substituteVariables } from './proposal-template.js';

const IFRAME_SELECTOR = 'iframe[src*="proposal"]';

/**
 * Wait for the proposal iframe dialog to appear and its form to load.
 * Returns true when interactive elements are present.
 */
export async function waitForIframeForm(
  primitives: Primitives,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await primitives.evaluate<boolean>(`(() => {
      const iframe = document.querySelector('${IFRAME_SELECTOR}');
      const doc = iframe?.contentDocument;
      return !!doc?.querySelector('textarea[data-testid="uicl-textarea"]') &&
             !!doc?.querySelector('button[data-testid="uicl-multi-select-input-button"]');
    })()`);
    if (ready) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Fill Template Term dropdown.
 *
 * The iframe has 12+ buttons sharing data-testid="uicl-multi-select-input-button"
 * (Template Term, hour, minute, AM/PM, timezone, Length, etc.).
 * AX tree "Select" matches the wrong button. querySelectorAll()[0] hits the hour picker.
 *
 * Solution: CDP DOM nested querySelector — first section.iui-form-section contains
 * exactly one multi-select button (Template Term). backendNodeId → getBoxModel
 * gives main-page absolute coordinates for iframe elements.
 */
export async function fillTemplateTerm(
  primitives: Primitives,
  value: string,
): Promise<void> {
  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const iframeDocId = findIframeDocId(doc.root);
    if (!iframeDocId) throw new ElementNotFound('Iframe document not found');

    // Nested query: first section → its only multi-select button
    const { nodeId: sectionId } = await cdp.send('DOM.querySelector', {
      nodeId: iframeDocId,
      selector: 'section.iui-form-section',
    }) as { nodeId: number };
    if (!sectionId) throw new ElementNotFound('Template Term section not found');

    const btnBid = await queryBackendId(cdp as unknown as AnyCDPSession, sectionId,
      'button[data-testid="uicl-multi-select-input-button"]');
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: btnBid });
    await new Promise(r => setTimeout(r, 300));
    await cdpClick(cdp as unknown as AnyCDPSession, btnBid);
    await new Promise(r => setTimeout(r, 800));

    // Find target option in dropdown list
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: iframeDocId,
      selector: '.iui-dropdown li, .iui-list li',
    }) as { nodeIds: number[] };

    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    let clicked = false;
    for (const nid of nodeIds) {
      const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: nid }) as { outerHTML: string };
      if (pattern.test(outerHTML)) {
        const { node } = await cdp.send('DOM.describeNode', { nodeId: nid }) as { node: { backendNodeId: number } };
        // Only click visible items (width > 0)
        try {
          await cdpClick(cdp as unknown as AnyCDPSession, node.backendNodeId);
          clicked = true;
          break;
        } catch {
          continue; // Element may be zero-size, try next match
        }
      }
    }
    if (!clicked) {
      throw new ElementNotFound(`Template Term option "${value}" not found in dropdown`);
    }
    await new Promise(r => setTimeout(r, 500));

    // Verify selection
    const { outerHTML: newBtnHtml } = await cdp.send('DOM.getOuterHTML', {
      nodeId: sectionId,
    }) as { outerHTML: string };
    if (!pattern.test(newBtnHtml)) {
      throw new StateTransitionFailed(
        `Template Term: expected "${value}" but section HTML does not contain it`,
      );
    }
  } finally {
    await cdp.detach();
  }
}

/**
 * Ensure Start Date is set. If the date button is empty, click the
 * calendar "Today" button or the today date cell.
 */
export async function ensureStartDate(
  primitives: Primitives,
): Promise<void> {
  const dateText = await primitives.evaluate<string>(`(() => {
    const iframe = document.querySelector('${IFRAME_SELECTOR}');
    return iframe?.contentDocument?.querySelector(
      'button[data-testid="uicl-date-input"] regular-text'
    )?.textContent?.trim() ?? '';
  })()`);

  // If date is already displayed, skip
  if (dateText.length > 0) return;

  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const iframeDocId = findIframeDocId(doc.root);
    if (!iframeDocId) throw new ElementNotFound('Iframe document not found');

    // Click date button
    const dateBid = await queryBackendId(cdp as unknown as AnyCDPSession, iframeDocId, 'button[data-testid="uicl-date-input"]');
    await cdpClick(cdp as unknown as AnyCDPSession, dateBid);
    await new Promise(r => setTimeout(r, 800));

    // Try to find and click "Today" button in calendar
    const { nodeId: calId } = await cdp.send('DOM.querySelector', {
      nodeId: iframeDocId,
      selector: '.iui-calendar',
    }) as { nodeId: number };
    if (calId) {
      const { nodeIds: calBtnIds } = await cdp.send('DOM.querySelectorAll', {
        nodeId: calId,
        selector: 'button',
      }) as { nodeIds: number[] };
      let clicked = false;
      for (const nid of calBtnIds) {
        const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: nid }) as { outerHTML: string };
        if (/>\s*Today\s*</i.test(outerHTML)) {
          const { node } = await cdp.send('DOM.describeNode', { nodeId: nid }) as { node: { backendNodeId: number } };
          await cdpClick(cdp as unknown as AnyCDPSession, node.backendNodeId);
          clicked = true;
          break;
        }
      }

      // Fallback: click today's date cell
      if (!clicked) {
        const today = new Date().getDate().toString();
        const { nodeIds: tdIds } = await cdp.send('DOM.querySelectorAll', {
          nodeId: calId, selector: 'td',
        }) as { nodeIds: number[] };
        for (const nid of tdIds) {
          const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: nid }) as { outerHTML: string };
          if (new RegExp(`>${today}<`).test(outerHTML)) {
            const { node } = await cdp.send('DOM.describeNode', { nodeId: nid }) as { node: { backendNodeId: number } };
            await cdpClick(cdp as unknown as AnyCDPSession, node.backendNodeId);
            break;
          }
        }
      }
    }
  } finally {
    await cdp.detach();
  }
  await new Promise(r => setTimeout(r, 500));
}

/**
 * Fill Partner Groups tag input.
 * If chips already exist, skip. Otherwise type the value.
 * NOTE: Tag input is autocomplete-only — typed text may not create a chip.
 * This is a known limitation (spec §2.6 TODO).
 */
export async function fillPartnerGroup(
  primitives: Primitives,
  value: string | undefined,
): Promise<void> {
  if (!value) return;

  // Check if chips already exist
  const chipCount = await primitives.evaluate<number>(`(() => {
    const iframe = document.querySelector('${IFRAME_SELECTOR}');
    return iframe?.contentDocument?.querySelectorAll(
      '[data-testid="uicl-tag-input-delete-icon"]'
    )?.length ?? 0;
  })()`);

  if (chipCount > 0) return; // Use existing chips

  // Focus tag input and type value
  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const iframeDocId = findIframeDocId(doc.root);
    if (!iframeDocId) return;

    const tagBid = await queryBackendId(cdp as unknown as AnyCDPSession, iframeDocId, 'input[data-testid="uicl-tag-input-text-input"]');
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: tagBid });
    await new Promise(r => setTimeout(r, 200));
    await cdp.send('DOM.focus', { backendNodeId: tagBid });
    await new Promise(r => setTimeout(r, 200));
  } finally {
    await cdp.detach();
  }

  await page.keyboard.type(value, { delay: 30 });
  await new Promise(r => setTimeout(r, 300));
}

/**
 * Fill the Message textarea.
 * Applies variable substitution before typing.
 */
export async function fillMessage(
  primitives: Primitives,
  template: string,
  ctx: SubstitutionContext,
): Promise<void> {
  const message = substituteVariables(template, ctx);

  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const iframeDocId = findIframeDocId(doc.root);
    if (!iframeDocId) throw new ElementNotFound('Iframe document not found');

    const taBid = await queryBackendId(cdp as unknown as AnyCDPSession, iframeDocId, 'textarea[data-testid="uicl-textarea"]');
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: taBid });
    await new Promise(r => setTimeout(r, 200));
    await cdp.send('DOM.focus', { backendNodeId: taBid });
    await new Promise(r => setTimeout(r, 200));
  } finally {
    await cdp.detach();
  }

  // Select all + delete to clear
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.keyboard.press('Backspace');
  await new Promise(r => setTimeout(r, 100));

  await page.keyboard.type(message, { delay: 2 });
  await new Promise(r => setTimeout(r, 300));

  // Verify
  const len = await primitives.evaluate<number>(`(() => {
    const iframe = document.querySelector('${IFRAME_SELECTOR}');
    return iframe?.contentDocument?.querySelector('textarea[data-testid="uicl-textarea"]')?.value?.length ?? 0;
  })()`);
  if (len < 10) {
    throw new StateTransitionFailed('Message textarea appears empty after typing');
  }
}

/**
 * Click the Submit ("Send Proposal") button inside the iframe.
 * Uses CDP DOM to find the button by text match, then backendNodeId → getBoxModel → click.
 */
export async function clickSubmit(primitives: Primitives): Promise<void> {
  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const iframeDocId = findIframeDocId(doc.root);
    if (!iframeDocId) throw new ElementNotFound('Iframe document not found');

    const bid = await findButtonByText(cdp as unknown as AnyCDPSession, iframeDocId, 'Send Proposal');
    if (!bid) throw new ElementNotFound('"Send Proposal" submit button not found in iframe');
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: bid });
    await new Promise(r => setTimeout(r, 200));
    await cdpClick(cdp as unknown as AnyCDPSession, bid);
  } finally {
    await cdp.detach();
  }
}

/**
 * Handle the confirmation popup: find "I understand" button in iframe and click.
 * Polls via CDP DOM since the confirmation appears after submit.
 */
export async function clickConfirm(
  primitives: Primitives,
  timeoutMs = 5_000,
): Promise<void> {
  const page = await primitives.getRawPage();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cdp = await page.createCDPSession();
    try {
      const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const iframeDocId = findIframeDocId(doc.root);
      if (iframeDocId) {
        const bid = await findButtonByText(cdp as unknown as AnyCDPSession, iframeDocId, 'I understand');
        if (bid) {
          await cdpClick(cdp as unknown as AnyCDPSession, bid);
          return;
        }
      }
    } finally {
      await cdp.detach();
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new ElementNotFound('"I understand" confirmation button not found');
}

/**
 * Wait for iframe to be removed from DOM (= submit success).
 */
export async function waitForSuccess(
  primitives: Primitives,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await primitives.evaluate<boolean>(
      `!!document.querySelector('${IFRAME_SELECTOR}')`,
    );
    if (!exists) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Close the iframe dialog if it's open (for error recovery / dry-run).
 * Uses Escape key — safer than matching unnamed close buttons.
 */
export async function closeDialog(primitives: Primitives): Promise<void> {
  await primitives.pressKey('Escape');
  await new Promise(r => setTimeout(r, 500));
  // If iframe still present, try one more Escape (some modals need two)
  const still = await primitives.evaluate<boolean>(
    `!!document.querySelector('${IFRAME_SELECTOR}')`,
  );
  if (still) {
    await primitives.pressKey('Escape');
    await new Promise(r => setTimeout(r, 500));
  }
  // Wait for page to stabilize after dialog close
  await new Promise(r => setTimeout(r, 1000));
}

// ── CDP helpers (for iframe DOM operations) ──────────────────

interface DomNode {
  nodeId?: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode & { nodeId: number };
}

function findIframeDocId(root: DomNode): number | null {
  if (root.nodeName === 'IFRAME') {
    const attrs = root.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === 'src' && attrs[i + 1]?.includes('proposal')) {
        return root.contentDocument?.nodeId ?? null;
      }
    }
  }
  for (const child of root.children ?? []) {
    const r = findIframeDocId(child);
    if (r) return r;
  }
  if (root.contentDocument) {
    const r = findIframeDocId(root.contentDocument);
    if (r) return r;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCDPSession = { send: (method: string, params?: Record<string, unknown>) => Promise<any> };

async function queryBackendId(
  cdp: AnyCDPSession,
  parentNodeId: number,
  selector: string,
): Promise<number> {
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: parentNodeId, selector }) as { nodeId: number };
  if (!nodeId) throw new ElementNotFound(`CDP querySelector failed: ${selector}`);
  const { node } = await cdp.send('DOM.describeNode', { nodeId }) as { node: { backendNodeId: number } };
  return node.backendNodeId;
}

async function cdpClick(
  cdp: AnyCDPSession,
  backendNodeId: number,
): Promise<void> {
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId }) as {
    model: { content: number[] };
  };
  const [x1, y1, , , x3, , , y4] = model.content;
  const cx = (x1 + x3) / 2;
  const cy = (y1 + y4) / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  await new Promise(r => setTimeout(r, 50));
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
  });
}

/**
 * Find a button by its text content inside an iframe document.
 * Returns backendNodeId or null if not found.
 */
async function findButtonByText(
  cdp: AnyCDPSession,
  iframeDocId: number,
  text: string,
): Promise<number | null> {
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
    nodeId: iframeDocId,
    selector: 'button[data-testid="uicl-button"]',
  }) as { nodeIds: number[] };

  for (const nid of nodeIds) {
    const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: nid }) as { outerHTML: string };
    if (outerHTML.includes(text)) {
      const { node } = await cdp.send('DOM.describeNode', { nodeId: nid }) as { node: { backendNodeId: number } };
      // Only return if element has size (is visible)
      try {
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }) as {
          model: { content: number[] };
        };
        const [x1, , , , x3] = model.content;
        if (x3 - x1 > 0) return node.backendNodeId;
      } catch {
        continue; // Element not visible
      }
    }
  }
  return null;
}

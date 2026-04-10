import type { Primitives } from '../../primitives/types.js';
import { findByDescriptor } from '../../ops/matchers.js';
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
 * ⚠️ CDP escape hatch (dropdown button click only) — Why not primitives?
 * The iframe has 12+ buttons sharing data-testid="uicl-multi-select-input-button"
 * (Template Term, hour, minute, AM/PM, timezone, Length, etc.). All appear as
 * [button] "Select" in the AX tree — findByDescriptor cannot disambiguate.
 * CDP DOM nested querySelector is the only reliable path:
 *   iframeDoc → first section.iui-form-section → its sole multi-select button.
 * backendNodeId → getBoxModel gives absolute coordinates for the click.
 *
 * Once the dropdown is open, option selection uses AX snapshot + primitives.click
 * since option names (e.g. "Public Terms") are unique.
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

  } finally {
    await cdp.detach();
  }

  // Find target option in dropdown via AX snapshot.
  // Option text (e.g. "Public Terms") is unique in the dropdown.
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'i');
  const snapshot = await primitives.takeSnapshot();
  const optionNode = findByDescriptor(snapshot, { role: 'option', name: pattern })
    ?? findByDescriptor(snapshot, { role: 'listitem', name: pattern });
  if (!optionNode) {
    throw new ElementNotFound(`Template Term option "${value}" not found in dropdown`);
  }
  await primitives.click(optionNode.uid);
  await new Promise(r => setTimeout(r, 500));

  // Verify selection via DOM
  const newText = await primitives.evaluate<string>(`(() => {
    const iframe = document.querySelector('${IFRAME_SELECTOR}');
    const section = iframe?.contentDocument?.querySelector('section.iui-form-section');
    return section?.querySelector('button[data-testid="uicl-multi-select-input-button"]')?.textContent?.trim() ?? '';
  })()`);
  if (!pattern.test(newText)) {
    throw new StateTransitionFailed(
      `Template Term: expected "${value}", got "${newText}"`,
    );
  }
}

/**
 * Ensure Start Date is set. If the date button is empty, click the
 * calendar "Today" button or the today date cell.
 *
 * ⚠️ CDP escape hatch (entire function) — Why not primitives?
 * 1. Date button: shares data-testid="uicl-date-input" with fallback date
 *    pickers — AX disambiguation unreliable, use CDP nested querySelector.
 * 2. Calendar "Today" button: no unique AX name, identified by outerHTML
 *    text match among generic calendar buttons.
 * 3. Date cell fallback: <td> elements have no AX role/name for the day
 *    number — only raw innerHTML reveals which cell is "today".
 * All clicks use CDP Input.dispatchMouseEvent with getBoxModel coordinates
 * (same mechanism as primitives.click, minus Bezier trajectory). Acceptable
 * because these are iframe-internal form controls, not user-visible page actions.
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
 * If chips already exist, skip. Otherwise focus via CDP and type the value.
 * Typing creates a chip automatically (no Enter/Tab needed).
 *
 * ⚠️ CDP escape hatch (focus only) — Why not primitives?
 * The tag input is an `<input>` inside the iframe with data-testid but
 * no unique aria-label. AX snapshot matching is unreliable (multiple
 * textboxes in iframe, hard to disambiguate from message textarea).
 * CDP DOM.focus on the exact data-testid is the reliable path.
 * Typing uses page.keyboard which sends real key events.
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

  // Focus tag input via CDP and type value
  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const iframeDocId = findIframeDocId(doc.root);
    if (!iframeDocId) {
      console.error('[site-use] impact: Partner Groups — iframe not found, skipping');
      return;
    }

    const tagBid = await queryBackendId(cdp as unknown as AnyCDPSession, iframeDocId, 'input[data-testid="uicl-tag-input-text-input"]');
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: tagBid });
    await new Promise(r => setTimeout(r, 200));
    await cdp.send('DOM.focus', { backendNodeId: tagBid });
    await new Promise(r => setTimeout(r, 200));
  } finally {
    await cdp.detach();
  }

  console.error(`[site-use] impact: fillPartnerGroup — typing "${value}"...`);
  await page.keyboard.type(value, { delay: 80 });

  // Poll for autocomplete dropdown to appear (up to 5s)
  let dropdownVisible = false;
  const ddDeadline = Date.now() + 5_000;
  while (Date.now() < ddDeadline) {
    await new Promise(r => setTimeout(r, 500));
    dropdownVisible = await primitives.evaluate<boolean>(`(() => {
      const iframe = document.querySelector('${IFRAME_SELECTOR}');
      const dd = iframe?.contentDocument?.querySelector('[data-testid="uicl-tag-input-dropdown"]');
      return !!dd && getComputedStyle(dd).display !== 'none';
    })()`);
    if (dropdownVisible) break;
  }
  console.error(`[site-use] impact: fillPartnerGroup — dropdown visible: ${dropdownVisible}`);

  // Select first matching autocomplete suggestion.
  // Dropdown appears as li[role="option"] inside [data-testid="uicl-tag-input-dropdown"].
  const snapshot = await primitives.takeSnapshot();
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const optionNode = findByDescriptor(snapshot, {
    role: 'option',
    name: new RegExp(escaped, 'i'),
  });
  console.error(`[site-use] impact: fillPartnerGroup — AX option found: ${optionNode ? `uid=${optionNode.uid} name="${optionNode.name}" frameUrl=${optionNode.frameUrl ?? 'main'}` : 'NONE'}`);
  if (optionNode) {
    await primitives.click(optionNode.uid);
    await new Promise(r => setTimeout(r, 500));
    // Verify chip
    const chipAfter = await primitives.evaluate<number>(`(() => {
      const iframe = document.querySelector('${IFRAME_SELECTOR}');
      return iframe?.contentDocument?.querySelectorAll('[data-testid="uicl-tag-input-delete-icon"]')?.length ?? 0;
    })()`);
    console.error(`[site-use] impact: fillPartnerGroup — chips after click: ${chipAfter}`);
  } else {
    console.error(`[site-use] impact: Partner Groups — no autocomplete match for "${value}"`);
  }
}

/**
 * Fill the Message textarea.
 * Applies variable substitution before typing.
 * Uses AX snapshot to find the textarea (M1 includes iframe content),
 * then primitives.type for input.
 */
export async function fillMessage(
  primitives: Primitives,
  template: string,
  ctx: SubstitutionContext,
): Promise<void> {
  const message = substituteVariables(template, ctx);

  // Find textarea via AX snapshot — look for textbox by DOM-to-ARIA bridge
  const textareaText = await primitives.evaluate<string>(`(() => {
    const iframe = document.querySelector('${IFRAME_SELECTOR}');
    const ta = iframe?.contentDocument?.querySelector('textarea[data-testid="uicl-textarea"]');
    return ta?.getAttribute('aria-label') ?? ta?.placeholder ?? '';
  })()`);

  const snapshot = await primitives.takeSnapshot();
  // Try matching by name, fallback to any textbox in iframe context
  let taNode = textareaText
    ? findByDescriptor(snapshot, { role: 'textbox', name: textareaText })
    : null;
  // Fallback: find textbox with empty/generic name (the message textarea)
  if (!taNode) {
    for (const [, node] of snapshot.idToNode) {
      if (node.role === 'textbox' && node.frameUrl?.includes('proposal')) {
        taNode = node;
        break;
      }
    }
  }
  if (!taNode) {
    throw new ElementNotFound('Message textarea not found in AX snapshot');
  }

  await primitives.scrollIntoView(taNode.uid);
  await new Promise(r => setTimeout(r, 200));

  // Clear existing content via select-all + backspace, then type
  await primitives.click(taNode.uid);
  await new Promise(r => setTimeout(r, 100));
  const page = await primitives.getRawPage();
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.keyboard.press('Backspace');
  await new Promise(r => setTimeout(r, 100));

  await primitives.type(taNode.uid, message, { delay: 2 });
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
 * Uses AX snapshot — M1 pipeline includes iframe content. The submit button
 * has testId="uicl-webflow-button" which is unique, so AX name match is safe.
 * (The card's hover button with the same name is display:none → invisible to AX.)
 */
export async function clickSubmit(primitives: Primitives): Promise<void> {
  const snapshot = await primitives.takeSnapshot();
  const btn = findByDescriptor(snapshot, { role: 'button', name: 'Send Proposal' });
  if (!btn) {
    throw new ElementNotFound('"Send Proposal" submit button not found in iframe AX');
  }
  console.error(`[site-use] impact: clickSubmit — found "Send Proposal" (uid=${btn.uid}, frameUrl=${btn.frameUrl ?? 'main'})`);
  await primitives.scrollIntoView(btn.uid);
  await new Promise(r => setTimeout(r, 200));
  await primitives.click(btn.uid);
}

/**
 * Handle the confirmation popup: find "I understand" button in iframe and click.
 * Polls AX snapshot since the confirmation appears after submit.
 * Impact.com is English-only (spec §2.1), text matching is safe.
 */
export async function clickConfirm(
  primitives: Primitives,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount++;
    const snapshot = await primitives.takeSnapshot();
    const btn = findByDescriptor(snapshot, { role: 'button', name: 'I understand' });
    if (btn) {
      console.error(`[site-use] impact: clickConfirm — found "I understand" on poll #${pollCount} (uid=${btn.uid}, frameUrl=${btn.frameUrl ?? 'main'})`);
      await primitives.click(btn.uid);
      return;
    }
    // Also check if iframe is already gone (submit completed without confirmation)
    const iframeGone = await primitives.evaluate<boolean>(
      `!document.querySelector('${IFRAME_SELECTOR}')`,
    );
    if (iframeGone) {
      console.error(`[site-use] impact: clickConfirm — iframe already gone on poll #${pollCount}, no confirmation popup appeared`);
      return; // Submit succeeded without confirmation — don't throw
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
 * Clicks outside the dialog area to dismiss it — Escape may not work
 * on impact.com's modal implementation.
 */
export async function closeDialog(primitives: Primitives): Promise<void> {
  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    // Click top-left corner (outside the centered dialog)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
    await new Promise(r => setTimeout(r, 50));
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1,
    });
  } finally {
    await cdp.detach();
  }
  await new Promise(r => setTimeout(r, 1000));

  // Verify dialog is gone
  const still = await primitives.evaluate<boolean>(
    `!!document.querySelector('${IFRAME_SELECTOR}')`,
  );
  if (still) {
    // Fallback: press Escape
    await primitives.pressKey('Escape');
    await new Promise(r => setTimeout(r, 1000));
  }
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

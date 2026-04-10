import type { Primitives } from '../../primitives/types.js';
import { findByDescriptor } from '../../ops/matchers.js';
import { ElementNotFound, StateTransitionFailed } from '../../errors.js';
import type { ProposalTemplate, SubstitutionContext } from './types.js';
import { substituteVariables } from './proposal-template.js';

const IFRAME_SELECTOR = 'iframe[src*="proposal"]';

/**
 * Wait for the proposal iframe dialog to appear and its form to load.
 * Returns true when interactive elements are present.
 */
export async function waitForIframeForm(
  primitives: Primitives,
  timeoutMs = 10_000,
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
 * Locates via DOM path: first section.iui-form-section → its multi-select button.
 */
export async function fillTemplateTerm(
  primitives: Primitives,
  value: string,
): Promise<void> {
  // Click the Template Term dropdown button
  await primitives.evaluate(`(() => {
    const iframe = document.querySelector('${IFRAME_SELECTOR}');
    const section = iframe?.contentDocument?.querySelector('section.iui-form-section');
    const btn = section?.querySelector('button[data-testid="uicl-multi-select-input-button"]');
    btn?.scrollIntoView({ block: 'center' });
  })()`);
  await new Promise(r => setTimeout(r, 300));

  // Take snapshot to find and click the button via AX
  let snapshot = await primitives.takeSnapshot();
  // Use evaluate to get the button text, then match in AX
  const btnText = await primitives.evaluate<string>(`(() => {
    const iframe = document.querySelector('${IFRAME_SELECTOR}');
    const section = iframe?.contentDocument?.querySelector('section.iui-form-section');
    return section?.querySelector('button[data-testid="uicl-multi-select-input-button"]')?.textContent?.trim() ?? '';
  })()`);

  const btnNode = findByDescriptor(snapshot, { role: 'button', name: btnText || 'Select' });
  if (!btnNode) {
    throw new ElementNotFound('Template Term dropdown button not found in AX');
  }
  await primitives.click(btnNode.uid);
  await new Promise(r => setTimeout(r, 800));

  // Find target option in dropdown
  snapshot = await primitives.takeSnapshot();
  const optionNode = findByDescriptor(snapshot, {
    role: 'option',
    name: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  });
  // Fallback: try listitem role
  const target = optionNode ?? findByDescriptor(snapshot, {
    role: 'listitem',
    name: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  });
  if (!target) {
    throw new ElementNotFound(`Template Term option "${value}" not found in dropdown`);
  }
  await primitives.click(target.uid);
  await new Promise(r => setTimeout(r, 500));

  // Verify
  const newText = await primitives.evaluate<string>(`(() => {
    const iframe = document.querySelector('${IFRAME_SELECTOR}');
    const section = iframe?.contentDocument?.querySelector('section.iui-form-section');
    return section?.querySelector('button[data-testid="uicl-multi-select-input-button"]')?.textContent?.trim() ?? '';
  })()`);
  if (!newText.toLowerCase().includes(value.toLowerCase())) {
    throw new StateTransitionFailed(
      `Template Term: expected "${value}", got "${newText}"`,
    );
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

  // Click date button to open calendar
  const snapshot = await primitives.takeSnapshot();
  // Date input button — find by evaluate text then AX match
  const dateBtnText = await primitives.evaluate<string>(`(() => {
    const iframe = document.querySelector('${IFRAME_SELECTOR}');
    const btn = iframe?.contentDocument?.querySelector('button[data-testid="uicl-date-input"]');
    btn?.scrollIntoView({ block: 'center' });
    return btn?.textContent?.trim() ?? '';
  })()`);

  // Use getRawPage + CDP for precise iframe element clicking
  const page = await primitives.getRawPage();
  const cdp = await page.createCDPSession();
  try {
    // Get iframe document via CDP DOM
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
    });
    if (calId) {
      const { nodeIds: calBtnIds } = await cdp.send('DOM.querySelectorAll', {
        nodeId: calId,
        selector: 'button',
      });
      let clicked = false;
      for (const nid of calBtnIds) {
        const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: nid });
        if (/>\s*Today\s*</i.test(outerHTML)) {
          const { node } = await cdp.send('DOM.describeNode', { nodeId: nid });
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
        });
        for (const nid of tdIds) {
          const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: nid });
          if (new RegExp(`>${today}<`).test(outerHTML)) {
            const { node } = await cdp.send('DOM.describeNode', { nodeId: nid });
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
 */
export async function clickSubmit(primitives: Primitives): Promise<void> {
  const snapshot = await primitives.takeSnapshot();
  const btn = findByDescriptor(snapshot, { role: 'button', name: 'Send Proposal' });
  if (!btn) {
    throw new ElementNotFound('"Send Proposal" submit button not found in iframe AX');
  }
  await primitives.scrollIntoView(btn.uid);
  await new Promise(r => setTimeout(r, 200));
  await primitives.click(btn.uid);
}

/**
 * Handle the confirmation popup: find "I understand" button in iframe and click.
 */
export async function clickConfirm(
  primitives: Primitives,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await primitives.takeSnapshot();
    const btn = findByDescriptor(snapshot, { role: 'button', name: 'I understand' });
    if (btn) {
      await primitives.click(btn.uid);
      return;
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
 */
export async function closeDialog(primitives: Primitives): Promise<void> {
  // Click the modal close button (X) on the main page
  const snapshot = await primitives.takeSnapshot();
  const closeBtn = findByDescriptor(snapshot, { role: 'button', name: '' });
  // Fallback: press Escape
  if (closeBtn) {
    await primitives.click(closeBtn.uid);
  } else {
    await primitives.pressKey('Escape');
  }
  await new Promise(r => setTimeout(r, 500));
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

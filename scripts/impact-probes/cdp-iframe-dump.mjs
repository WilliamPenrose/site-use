#!/usr/bin/env node
/**
 * Dump iframe content from three CDP sources for human inspection.
 * Focuses on the business iframe (impact.com same-origin), ignores Freshchat.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const TARGET_URL_PATTERN = /impact\.com/;
const IGNORE_FRAMES = /freshchat|wchat/;

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });

  const pages = await browser.pages();
  const page = pages.find(p => TARGET_URL_PATTERN.test(p.url()));
  if (!page) { console.error('No impact.com page'); process.exit(1); }

  const cdp = await page.createCDPSession();

  // ── 1. DOM.getDocument — iframe 的完整 DOM 树 ──────────────────────
  console.log('='.repeat(70));
  console.log('SOURCE 1: DOM.getDocument (pierce=true) — iframe subtree');
  console.log('='.repeat(70));

  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });

  // Find the business iframe's contentDocument
  let iframeDoc = null;
  function findIframeDoc(node) {
    if (node.nodeName === 'IFRAME' && node.contentDocument) {
      const url = node.contentDocument.documentURL || '';
      if (!IGNORE_FRAMES.test(url)) {
        iframeDoc = node.contentDocument;
        return;
      }
    }
    for (const child of node.children ?? []) findIframeDoc(child);
    for (const sr of node.shadowRoots ?? []) findIframeDoc(sr);
  }
  findIframeDoc(doc.root);

  if (!iframeDoc) {
    console.log('  No business iframe found (only Freshchat?).');
  } else {
    console.log(`  iframe URL: ${iframeDoc.documentURL}`);
    // Print a simplified DOM tree (tag + key attrs + text)
    function printTree(node, indent = 0) {
      const pad = '  '.repeat(indent);
      const name = node.nodeName?.toLowerCase() ?? '?';

      // Skip noise
      if (['#comment', 'script', 'style', 'link', 'meta', 'noscript'].includes(name)) return;

      const attrs = node.attributes ?? [];
      const attrMap = {};
      for (let i = 0; i < attrs.length; i += 2) attrMap[attrs[i]] = attrs[i + 1];

      // Build display string
      let display = name;
      if (name === '#text') {
        const text = node.nodeValue?.trim();
        if (!text) return;
        console.log(`${pad}"${text.slice(0, 100)}${text.length > 100 ? '…' : ''}"`);
        return;
      }
      if (name === '#document') {
        for (const child of node.children ?? []) printTree(child, indent);
        return;
      }

      // Show useful attrs
      const show = ['id', 'class', 'type', 'name', 'value', 'href', 'role', 'aria-label',
                     'data-testid', 'placeholder', 'for', 'action', 'method'];
      const parts = [];
      for (const a of show) {
        if (attrMap[a]) {
          let v = attrMap[a];
          if (a === 'class') v = v.split(/\s+/).slice(0, 3).join(' ') + (v.split(/\s+/).length > 3 ? '…' : '');
          parts.push(`${a}="${v.slice(0, 60)}"`);
        }
      }

      console.log(`${pad}<${display}${parts.length ? ' ' + parts.join(' ') : ''}>`);

      for (const child of node.children ?? []) printTree(child, indent + 1);
    }

    printTree(iframeDoc);
  }

  // ── 2. DOMSnapshot — iframe document 的 layout 元素 ────────────────
  console.log('\n' + '='.repeat(70));
  console.log('SOURCE 2: DOMSnapshot.captureSnapshot — iframe visible elements');
  console.log('='.repeat(70));

  const snap = await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: ['display', 'visibility', 'opacity', 'pointer-events'],
  });

  // Find the iframe document (not the main page)
  for (let di = 0; di < snap.documents.length; di++) {
    const sdoc = snap.documents[di];
    const url = snap.strings[sdoc.documentURL];
    if (IGNORE_FRAMES.test(url) || di === 0) continue; // skip main + freshchat

    console.log(`\n  Document[${di}]: ${url}`);
    console.log(`  Total nodes: ${sdoc.nodes.nodeType.length}`);
    console.log(`  Nodes with layout: ${sdoc.layout.nodeIndex.length}`);

    // Print visible elements with their bounds and text
    console.log('\n  Visible elements (with layout bounds):');
    const { nodeIndex, bounds } = sdoc.layout;
    const { nodeName, nodeType, nodeValue, attributes } = sdoc.nodes;

    for (let li = 0; li < nodeIndex.length; li++) {
      const ni = nodeIndex[li];
      const type = nodeType[ni];
      const tag = snap.strings[nodeName[ni]]?.toLowerCase() ?? '?';
      const [x, y, w, h] = bounds.slice(li * 4, li * 4 + 4);

      // Skip tiny/invisible
      if (w < 1 && h < 1) continue;

      // Get text for text nodes
      let text = '';
      if (type === 3 /* TEXT_NODE */) {
        const rawIdx = nodeValue[ni];
        text = snap.strings[rawIdx]?.trim() ?? '';
        if (!text) continue;
      }

      // Get key attributes
      const attrIndices = attributes[ni] ?? [];
      const attrPairs = [];
      for (let ai = 0; ai < attrIndices.length; ai += 2) {
        const aName = snap.strings[attrIndices[ai]];
        const aVal = snap.strings[attrIndices[ai + 1]];
        if (['id', 'class', 'type', 'name', 'role', 'aria-label', 'placeholder', 'value'].includes(aName)) {
          attrPairs.push(`${aName}="${(aVal ?? '').slice(0, 50)}"`);
        }
      }

      const bbox = `[${(x/2).toFixed(0)},${(y/2).toFixed(0)} ${(w/2).toFixed(0)}x${(h/2).toFixed(0)}]`;
      if (type === 3) {
        console.log(`    ${bbox} TEXT: "${text.slice(0, 80)}"`);
      } else {
        console.log(`    ${bbox} <${tag}${attrPairs.length ? ' ' + attrPairs.join(' ') : ''}>`);
      }
    }
  }

  // ── 3. AX tree — per-frame ─────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('SOURCE 3: Accessibility.getFullAXTree — per-frame for iframe');
  console.log('='.repeat(70));

  const frames = page.frames();
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    if (IGNORE_FRAMES.test(frame.url())) continue;

    console.log(`\n  Frame: ${frame.url().slice(0, 100)}`);

    // Try getting AX tree via the frame's execution context
    // Since frame.createCDPSession doesn't exist, use Target.attachToTarget
    try {
      // Get frame's target info
      const { targetInfos } = await cdp.send('Target.getTargets');
      const frameTarget = targetInfos.find(t =>
        t.type === 'iframe' && t.url && !IGNORE_FRAMES.test(t.url)
      );

      if (frameTarget) {
        console.log(`  Found target: ${frameTarget.targetId} (${frameTarget.url})`);
        const { sessionId } = await cdp.send('Target.attachToTarget', {
          targetId: frameTarget.targetId, flatten: true,
        });
        // Use the browser-level connection to send to this session
        // Unfortunately puppeteer CDPSession doesn't support sessionId routing directly
        // Fall back to Runtime.evaluate in frame context
        console.log(`  Attached session: ${sessionId}`);
        await cdp.send('Target.detachFromTarget', { sessionId });
      } else {
        console.log('  No separate target for same-origin iframe (expected).');
      }
    } catch (err) {
      console.log(`  Target attach error: ${err.message}`);
    }

    // For same-origin iframe, AX tree should be accessible via frameId
    // Let's try Accessibility.getFullAXTree with frameId
    try {
      // Get the frame tree to find frameId
      const { frameTree } = await cdp.send('Page.getFrameTree');
      console.log(`\n  Frame tree:`);
      function printFrameTree(ft, indent = 2) {
        const pad = '  '.repeat(indent);
        console.log(`${pad}${ft.frame.id} — ${ft.frame.url.slice(0, 80)}`);
        for (const child of ft.childFrames ?? []) printFrameTree(child, indent + 1);
      }
      printFrameTree(frameTree);

      // Find iframe frameId
      function findFrameId(ft) {
        if (!IGNORE_FRAMES.test(ft.frame.url) && ft.frame.url !== frameTree.frame.url) {
          return ft.frame.id;
        }
        for (const child of ft.childFrames ?? []) {
          const found = findFrameId(child);
          if (found) return found;
        }
        return null;
      }
      const iframeFrameId = findFrameId(frameTree);

      if (iframeFrameId) {
        console.log(`\n  Querying AX tree for frameId: ${iframeFrameId}`);
        const frameAx = await cdp.send('Accessibility.getFullAXTree', { frameId: iframeFrameId });
        const nodes = frameAx.nodes;
        console.log(`  AX nodes in iframe: ${nodes.length}`);

        // Print non-ignored nodes with role and name
        let printed = 0;
        for (const n of nodes) {
          if (n.ignored) continue;
          const role = n.role?.value ?? '?';
          const name = n.name?.value ?? '';
          if (role === 'generic' && !name) continue; // skip anonymous generics
          const props = (n.properties ?? [])
            .filter(p => ['focusable', 'required', 'disabled', 'checked', 'selected'].includes(p.name))
            .map(p => `${p.name}=${p.value?.value}`)
            .join(' ');
          console.log(`    [${role}]${name ? ' "' + name.slice(0, 60) + '"' : ''}${props ? ' (' + props + ')' : ''} backendNodeId=${n.backendDOMNodeId ?? '?'}`);
          if (++printed > 80) { console.log('    ... (truncated)'); break; }
        }
      }
    } catch (err) {
      console.log(`  AX tree error: ${err.message}`);
    }
  }

  browser.disconnect();
}

main().catch(err => { console.error('[probe] Fatal:', err.message); process.exit(1); });

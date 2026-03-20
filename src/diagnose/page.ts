/**
 * Browser entry point for the diagnose page.
 * Bundled by esbuild into dist/diagnose/checks.js (IIFE).
 */
import { checks as barrelChecks } from './checks/_browser-barrel.js';
import { setup as setupInputTrusted, run as runInputTrusted, meta as inputTrustedMeta } from './checks/input-trusted.js';
import { setup as setupInputCoords, run as runInputCoords, meta as inputCoordsMeta } from './checks/input-coords.js';
import type { CheckMeta, CheckResult } from './types.js';

interface ResultEntry {
  meta: CheckMeta;
  result: CheckResult;
}

const allResults: ResultEntry[] = [];

// Get DOM elements
const tbody = document.getElementById('results')!;
const statusEl = document.getElementById('status')!;

function addRow(meta: CheckMeta, result: CheckResult): void {
  allResults.push({ meta, result });
  const tr = document.createElement('tr');
  const statusClass = result.pass ? 'pass' : meta.knownFail ? 'warn' : 'fail';
  const statusText = result.pass ? 'PASS' : meta.knownFail ? 'KNOWN' : 'FAIL';
  tr.innerHTML =
    `<td>${meta.name}</td>` +
    `<td>${meta.expected}</td>` +
    `<td>${result.actual}</td>` +
    `<td class="${statusClass}">${statusText}</td>`;
  tbody.appendChild(tr);
}

function updateStatus(): void {
  let passed = 0;
  let knownFail = 0;
  let failed = 0;
  for (const r of allResults) {
    if (r.result.pass) passed++;
    else if (r.meta.knownFail) knownFail++;
    else failed++;
  }
  const total = allResults.length;
  statusEl.textContent = `${passed} passed, ${knownFail} known-fail, ${failed} failed (${total} total)`;
}

async function runAll(): Promise<void> {
  // Set up deferred input listeners first
  setupInputTrusted();
  setupInputCoords();

  // Run all barrel checks
  for (const check of barrelChecks) {
    try {
      const result = await check.run();
      addRow(check.meta, result);
    } catch (err) {
      addRow(check.meta, {
        pass: false,
        actual: `error: ${(err as Error).message}`,
      });
    }
  }

  updateStatus();

  // Signal that barrel checks are done
  (window as unknown as Record<string, boolean>).__checksDone = true;
}

// Expose API for the Node runner

/** Called after Node triggers mouse events to resolve input checks */
(window as unknown as Record<string, () => void>).__resolveInputChecks = () => {
  addRow(inputTrustedMeta, runInputTrusted());
  addRow(inputCoordsMeta, runInputCoords());
  updateStatus();
};

/** Called by Node runner to inject node-side check results */
(window as unknown as Record<string, (meta: CheckMeta, result: CheckResult) => void>).__addNodeResult = (
  meta: CheckMeta,
  result: CheckResult,
) => {
  addRow(meta, result);
  updateStatus();
};

/** Called by Node runner after all checks are done */
(window as unknown as Record<string, () => void>).__finalize = () => {
  updateStatus();
};

/** Expose all results for Node runner to read */
Object.defineProperty(window, '__allResults', {
  get: () => allResults,
  configurable: true,
});

runAll();

import type { Browser } from 'puppeteer-core';
import type { CheckResult, CheckMeta } from './types.js';
import { createDiagnoseServer } from './server.js';
import { nodeChecks } from './registry.js';
import { humanScroll } from '../primitives/scroll-enhanced.js';
import { analyzeScrollTrajectory } from './scroll-analyzer.js';
import type { ScrollDelta } from './scroll-analyzer.js';

export interface DiagnoseResult {
  meta: CheckMeta;
  result: CheckResult;
}

export interface DiagnoseOptions {
  keepOpen?: boolean;
}

/**
 * Run all anti-detection diagnostic checks.
 *
 * 1. Start local HTTP server serving the diagnose page
 * 2. Open a new page and navigate to it
 * 3. Wait for browser checks to complete
 * 4. Trigger mouse events for input checks
 * 5. Run node-side checks
 * 6. Collect and return all results
 */
export async function runDiagnose(
  browser: Browser,
  options: DiagnoseOptions = {},
): Promise<DiagnoseResult[]> {
  const server = await createDiagnoseServer();
  const url = `http://127.0.0.1:${server.port}/`;
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for browser checks to complete (window.__checksDone === true)
    await page.waitForFunction('window.__checksDone === true', { timeout: 15_000 });

    // Trigger mouse events for input checks
    await page.mouse.move(100, 100);
    await page.mouse.click(100, 100);

    // Resolve input checks
    await page.evaluate(() => {
      (window as unknown as Record<string, () => void>).__resolveInputChecks();
    });

    // Trigger scroll events for scroll checks
    await humanScroll(page, 0, 600);

    // Read collected wheel deltas from browser
    const scrollDeltas = await page.evaluate(() => {
      return (window as unknown as Record<string, unknown>).__scrollDeltas as Array<{
        deltaY: number;
        deltaX: number;
        timestamp: number;
      }>;
    });

    // Run scroll trajectory analysis (Node-side)
    if (scrollDeltas && scrollDeltas.length >= 3) {
      const scrollReport = analyzeScrollTrajectory(scrollDeltas);
      for (const check of scrollReport.checks) {
        const checkMeta = {
          id: `scroll-${check.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          name: `Scroll: ${check.name}`,
          description: check.reference,
          runtime: 'node' as const,
          expected: check.threshold.min != null
            ? `>${check.threshold.min}`
            : `<${check.threshold.max}`,
        };
        const checkResult = {
          pass: check.pass,
          actual: String(check.value.toFixed(3)),
          detail: check.reference,
        };
        await page.evaluate(
          (meta, res) => {
            (
              window as unknown as Record<
                string,
                (m: typeof meta, r: typeof res) => void
              >
            ).__addNodeResult(meta, res);
          },
          { ...checkMeta } as Record<string, unknown>,
          { ...checkResult } as Record<string, unknown>,
        );
      }
    }

    // Resolve browser-side scroll info check
    await page.evaluate(() => {
      (window as unknown as Record<string, () => void>).__resolveScrollChecks();
    });

    // Run node-side checks and inject results
    for (const entry of nodeChecks) {
      let result: CheckResult;
      try {
        result = await entry.run(page);
      } catch (err) {
        result = {
          pass: false,
          actual: `error: ${(err as Error).message}`,
        };
      }

      await page.evaluate(
        (meta, res) => {
          (
            window as unknown as Record<
              string,
              (m: typeof meta, r: typeof res) => void
            >
          ).__addNodeResult(meta, res);
        },
        { ...entry.meta } as Record<string, unknown>,
        { ...result } as Record<string, unknown>,
      );
    }

    // Finalize and collect results
    await page.evaluate(() => {
      (window as unknown as Record<string, () => void>).__finalize();
    });

    const allResults = await page.evaluate(() => {
      return (window as unknown as Record<string, unknown>).__allResults as Array<{
        meta: CheckMeta;
        result: CheckResult;
      }>;
    });

    // CLI output
    let passed = 0;
    let knownFail = 0;
    let failed = 0;
    let info = 0;

    for (const r of allResults) {
      const tag = r.meta.info
        ? '[INFO]'
        : r.result.pass
          ? '[PASS]'
          : r.meta.knownFail
            ? '[KNOWN]'
            : '[FAIL]';

      if (r.meta.info) info++;
      else if (r.result.pass) passed++;
      else if (r.meta.knownFail) knownFail++;
      else failed++;

      const detail = r.result.detail ? ` (${r.result.detail})` : '';
      console.log(
        `  ${tag} ${r.meta.name.padEnd(40)} expected=${r.meta.expected}  actual=${r.result.actual}${detail}`,
      );
    }

    const total = allResults.length;
    console.log(
      `\n  ${passed} passed, ${knownFail} known-fail, ${failed} failed, ${info} info (${total} total)`,
    );

    if (options.keepOpen) {
      console.log(`\n  Diagnose page: ${url}`);
      console.log('  Press Ctrl+C to close.');
    }

    return allResults;
  } finally {
    if (!options.keepOpen) {
      await page.close();
      await server.stop();
    }
  }
}

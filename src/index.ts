#!/usr/bin/env node
import { main as startServer } from './server.js';
import { ensureBrowser, closeBrowser, isBrowserConnected } from './browser/browser.js';
import { buildDetectHTML } from './browser/detect.js';
import { getConfig } from './config.js';

const HELP = `\
site-use — Site-level browser automation via MCP

Usage: site-use <command> [subcommand]

Commands:
  serve              Start MCP server (stdio transport)
  browser launch     Launch Chrome and keep it running
  browser status     Show connection status, PID, and profile path
  browser close      Detach from Chrome (process stays alive)
  help               Show this help message

Environment:
  SITE_USE_DATA_DIR      Data directory (default: ~/.site-use)
  SITE_USE_PROXY         Proxy server URL
  HTTPS_PROXY            Fallback proxy (if SITE_USE_PROXY not set)
  HTTP_PROXY             Fallback proxy (if neither above is set)
  SITE_USE_PROXY_USER    Proxy auth username
  SITE_USE_PROXY_PASS    Proxy auth password
`;

const BROWSER_HELP = `\
site-use browser — Chrome lifecycle management

Subcommands:
  launch    Launch Chrome and keep it running until Ctrl+C
  status    Show connection status, PID, and profile path
  close     Detach from Chrome (process stays alive)

Options (launch):
  --diagnose  Run anti-detection health check after launch

Extra Chrome flags can be passed directly:
  site-use browser launch --disable-web-security --some-flag
`;

async function browserLaunch(): Promise<void> {
  const knownFlags = new Set(['--diagnose']);
  const launchArgs = process.argv.slice(2);
  const diagnose = launchArgs.includes('--diagnose');

  // Collect extra --flags not recognized by site-use → pass to Chrome
  const extraChromeArgs = launchArgs
    .filter((a) => a.startsWith('--') && !knownFlags.has(a));

  if (extraChromeArgs.length > 0) {
    console.log(`Extra Chrome args: ${extraChromeArgs.join(' ')}`);
  }

  console.log('Launching Chrome...');
  const browser = await ensureBrowser(extraChromeArgs.length > 0 ? extraChromeArgs : undefined);
  const pid = browser.process()?.pid;
  const config = getConfig();
  console.log(`Chrome running (PID: ${pid})`);
  console.log(`Profile: ${config.chromeProfileDir}`);

  if (diagnose) {
    console.log('\n--- Anti-detection diagnostic ---\n');

    // Browser identity
    const cdpSession = await browser.target().createCDPSession();
    const versionInfo = await cdpSession.send('Browser.getVersion') as {
      product: string; userAgent: string; revision: string;
    };
    await cdpSession.detach();

    const product = versionInfo.product; // e.g. "Chrome/146.0.6247.0" or "HeadlessChrome/..."
    const isHeadless = product.toLowerCase().includes('headless');
    const isCfT = versionInfo.userAgent.includes('Chrome for Testing')
      || versionInfo.userAgent.includes('HeadlessChrome');

    console.log('Browser info:');
    console.log(`  Product:              ${product}`);
    console.log(`  User-Agent:           ${versionInfo.userAgent}`);
    console.log(`  Protocol revision:    ${versionInfo.revision}`);
    console.log(`  Headless:             ${isHeadless}`);
    console.log(`  Chrome for Testing:   ${isCfT}`);
    console.log('');

    // Print actual Chrome launch args
    const spawnargs = browser.process()?.spawnargs ?? [];
    console.log('Chrome launch args:');
    for (const arg of spawnargs) {
      if (arg.startsWith('--')) {
        console.log(`  ${arg}`);
      }
    }
    console.log('');

    const page = await browser.newPage();
    try {
      await page.goto('about:blank');
      const results = await page.evaluate(() => {
        const nav = navigator as unknown as Record<string, unknown>;
        const desc =
          Object.getOwnPropertyDescriptor(navigator, 'webdriver') ||
          Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(navigator),
            'webdriver',
          );
        const conn = (nav.connection ?? {}) as Record<string, unknown>;
        const chrome = (window as unknown as Record<string, unknown>).chrome as
          | Record<string, unknown>
          | undefined;
        return {
          webdriver: nav.webdriver,
          webdriverType: typeof nav.webdriver,
          webdriverIn: 'webdriver' in navigator,
          webdriverDesc: desc
            ? { enumerable: desc.enumerable, configurable: desc.configurable }
            : null,
          chromeExists: !!chrome,
          chromeRuntimeExists: !!chrome?.runtime,
          pluginsLength: navigator.plugins.length,
          languages: Array.from(navigator.languages),
          rtt: conn.rtt as number | undefined,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          innerHeight: window.innerHeight,
        };
      });

      let passed = 0;
      let total = 0;

      function check(label: string, ok: boolean, actual: string): void {
        total++;
        if (ok) {
          passed++;
          console.log(`  [PASS] ${label.padEnd(40)} = ${actual}`);
        } else {
          console.log(`  [FAIL] ${label.padEnd(40)} = ${actual}`);
        }
      }

      console.log('Checks:');
      check(
        'navigator.webdriver',
        results.webdriver === false,
        String(results.webdriver),
      );
      check(
        'typeof navigator.webdriver',
        results.webdriverType === 'boolean',
        results.webdriverType,
      );
      check(
        '"webdriver" in navigator',
        results.webdriverIn === true,
        String(results.webdriverIn),
      );
      check(
        'webdriver descriptor',
        results.webdriverDesc?.enumerable === true &&
          results.webdriverDesc?.configurable === true,
        JSON.stringify(results.webdriverDesc),
      );
      check(
        'window.chrome exists',
        results.chromeExists,
        String(results.chromeExists),
      );
      console.log(
        `  [INFO] ${'window.chrome.runtime exists'.padEnd(40)} = ${results.chromeRuntimeExists} (depends on extensions)`,
      );
      check(
        'navigator.plugins.length > 0',
        results.pluginsLength > 0,
        `true (${results.pluginsLength})`,
      );
      check(
        'navigator.languages includes en-US',
        results.languages.includes('en-US'),
        `true (${results.languages.join(', ')})`,
      );
      check(
        'navigator.connection.rtt > 0',
        (results.rtt ?? 0) > 0,
        `true (${results.rtt})`,
      );
      check(
        'window.outerWidth',
        results.outerWidth === 1920,
        String(results.outerWidth),
      );
      check(
        'window.outerHeight > 0',
        results.outerHeight > 0,
        `true (${results.outerHeight})`,
      );

      const uiOverhead = results.outerHeight - results.innerHeight;
      console.log(
        `  [INFO] ${'Chrome UI overhead'.padEnd(40)} = ${uiOverhead}px (outerHeight - innerHeight)`,
      );

      console.log(`\nResults: ${passed}/${total} passed`);

      // Advanced detection checks (Brotector-style, fully offline)
      console.log('\n--- Advanced detection checks ---\n');
      const detectHTML = buildDetectHTML();
      const detectUrl = `data:text/html;charset=utf-8,${encodeURIComponent(detectHTML)}`;
      await page.goto(detectUrl, { waitUntil: 'domcontentloaded' });

      // Wait for async checks to finish
      await new Promise((r) => setTimeout(r, 2_000));

      // Trigger mouse events for input checks, then finalize
      await page.mouse.move(100, 100);
      await page.mouse.click(100, 100);
      await page.evaluate(() => {
        (window as unknown as Record<string, () => void>).__detectRecordInput();
      });

      const detectResults = await page.evaluate(() => {
        return (window as unknown as Record<string, unknown>).__detectResults as
          Array<{ name: string; passed: boolean; detail: string }>;
      });

      let advPassed = 0;
      let advTotal = 0;
      for (const r of detectResults) {
        advTotal++;
        if (r.passed) advPassed++;
        console.log(
          `  ${r.passed ? '[PASS]' : '[FAIL]'} ${r.name.padEnd(30)} ${r.detail}`,
        );
      }
      console.log(`\nAdvanced: ${advPassed}/${advTotal} passed`);
      console.log('--- end diagnostic ---\n');
    } catch (err) {
      // If detection page fails, still continue — don't block the launch
      console.error('  Detection check error:', err instanceof Error ? err.message : err);
    }
    // Leave the detection results page open in the browser for the user to inspect
  }

  console.log('Press Ctrl+C to detach (Chrome will stay open)');

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      console.log('\nDetaching from Chrome (process stays alive)');
      closeBrowser();
      resolve();
    });
    // On Windows, handle the close event too
    process.on('SIGTERM', () => {
      closeBrowser();
      resolve();
    });
  });
}

async function browserStatus(): Promise<void> {
  const config = getConfig();
  console.log(`Profile: ${config.chromeProfileDir}`);

  if (config.proxy) {
    console.log(`Proxy: ${config.proxy.server} (from ${config.proxySource})`);
  } else {
    console.log('Proxy: none');
  }

  // Cannot check singleton state from a fresh process — just report config
  console.log('\nNote: status reflects config only. Browser state is per-process.');
}

async function browserClose(): Promise<void> {
  closeBrowser();
  console.log('Singleton reference cleared. Chrome process (if any) stays alive.');
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'serve':
      await startServer();
      break;

    case undefined:
      console.log(HELP);
      break;

    case 'browser': {
      const sub = args[1];
      switch (sub) {
        case 'launch':
          await browserLaunch();
          break;
        case 'status':
          await browserStatus();
          break;
        case 'close':
          await browserClose();
          break;
        case undefined:
        case 'help':
          console.log(BROWSER_HELP);
          break;
        default:
          console.error(`Unknown browser subcommand: ${sub}\n`);
          console.log(BROWSER_HELP);
          process.exit(1);
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

run().catch((err) => {
  console.error('site-use failed:', err);
  process.exit(1);
});

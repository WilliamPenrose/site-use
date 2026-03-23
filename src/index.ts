#!/usr/bin/env node
import { main as startServer } from './server.js';
import { ensureBrowser, closeBrowser } from './browser/browser.js';
import { runDiagnose } from './diagnose/runner.js';
import { getConfig } from './config.js';

const HELP = `\
site-use — Site-level browser automation via MCP

Usage: site-use <command> [subcommand]

Commands:
  serve, mcp         Start MCP server (stdio transport)
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
  --diagnose    Run anti-detection health check after launch
  --keep-open   Keep browser and detection page open after diagnose

Extra Chrome flags can be passed directly:
  site-use browser launch --disable-web-security --some-flag
`;

async function browserLaunch(): Promise<void> {
  const knownFlags = new Set(['--diagnose', '--keep-open']);
  const launchArgs = process.argv.slice(2);
  const diagnose = launchArgs.includes('--diagnose');
  const keepOpen = launchArgs.includes('--keep-open');

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
    await runDiagnose(browser, { keepOpen });
  }

  console.log('Press Ctrl+C to detach (Chrome will stay open)');

  await new Promise<void>((resolve) => {
    const onExit = () => {
      console.log('\nDetaching from Chrome (process stays alive)');
      closeBrowser();
      resolve();
      // Force exit — keep-open diagnose server or other handles may linger
      process.exit(0);
    };
    process.once('SIGINT', onExit);
    process.once('SIGTERM', onExit);
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
    case 'mcp':
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

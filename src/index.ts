#!/usr/bin/env node --no-warnings=ExperimentalWarning
import { main as startServer } from './server.js';
import { launchAndDetach, readChromeJson, closeBrowser, recoverOrphanChrome } from './browser/browser.js';
import { getConfig } from './config.js';
import { runKnowledgeCli } from './cli/knowledge.js';
import { runWorkflowCli } from './cli/workflow.js';
import { ensureBrowser } from './browser/browser.js';
import { runDiagnose } from './diagnose/runner.js';

const HELP = `\
site-use — Site-level browser automation via MCP

Usage: site-use <command> [subcommand]

Commands:
  mcp                Start MCP server (stdio transport)
  browser launch     Launch Chrome (detached — stays alive after exit)
  browser status     Show Chrome connection status, PID, and profile path
  browser close      Kill Chrome and clean up
  twitter feed       Collect tweets from the home timeline
  search             Search stored tweets (FTS + structured filters)
  stats              Show storage statistics
  rebuild            Rebuild search index (Phase 2)
  diagnose           Run anti-detection diagnostic checks
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
  launch    Launch Chrome (detached — stays alive after exit)
  status    Show Chrome connection status, PID, and profile path
  close     Kill Chrome and clean up

Extra Chrome flags can be passed directly:
  site-use browser launch --disable-web-security --some-flag
`;

async function browserLaunch(): Promise<void> {
  const config = getConfig();
  let existing = readChromeJson(config.chromeJsonPath);
  if (!existing) {
    existing = await recoverOrphanChrome(config.chromeProfileDir, config.chromeJsonPath);
    if (existing) {
      console.log(`Recovered orphan Chrome (PID: ${existing.pid}) — chrome.json restored.`);
    }
  }
  if (existing) {
    console.log(`Chrome already running (pid ${existing.pid})`);
    return;
  }

  const launchArgs = process.argv.slice(2);

  // Collect extra --flags not recognized by site-use → pass to Chrome
  const extraChromeArgs = launchArgs
    .filter((a) => a.startsWith('--'));

  if (extraChromeArgs.length > 0) {
    console.log(`Extra Chrome args: ${extraChromeArgs.join(' ')}`);
  }

  console.log('Launching Chrome...');
  const info = await launchAndDetach(extraChromeArgs.length > 0 ? extraChromeArgs : undefined);
  console.log(`Chrome running (PID: ${info.pid})`);
  console.log(`Profile: ${config.chromeProfileDir}`);
  console.log('Chrome is detached and will stay alive after this process exits.');
}

async function browserStatus(): Promise<void> {
  const config = getConfig();
  console.log(`Profile: ${config.chromeProfileDir}`);

  if (config.proxy) {
    console.log(`Proxy: ${config.proxy.server} (from ${config.proxySource})`);
  } else {
    console.log('Proxy: none');
  }

  const info = readChromeJson(config.chromeJsonPath);
  if (info) {
    console.log(`Chrome PID: ${info.pid}`);
    console.log(`WebSocket: ${info.wsEndpoint}`);
  } else {
    console.log('Chrome: not running');
  }
}

async function browserClose(): Promise<void> {
  const result = await closeBrowser();
  if (!result.found) {
    console.log('No running Chrome found — nothing to close.');
  } else if (result.recovered) {
    console.log(`Found orphan Chrome (PID: ${result.pid}) — killed and cleaned up.`);
  } else {
    console.log(`Chrome (PID: ${result.pid}) closed and chrome.json cleaned up.`);
  }
}

async function run(): Promise<boolean> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'mcp':
      if (args.includes('--help') || args.includes('-h')) {
        console.log(`site-use mcp — Start MCP server (stdio transport)

The server communicates via stdin/stdout using the MCP protocol.
`);
        return true;
      }
      await startServer();
      return false; // MCP server stays alive — don't process.exit()

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
        case '--help':
        case '-h':
          console.log(BROWSER_HELP);
          break;
        default:
          console.error(`Unknown browser subcommand: ${sub}\n`);
          console.log(BROWSER_HELP);
          process.exit(1);
      }
      break;
    }

    case 'twitter':
      await runWorkflowCli('twitter', args.slice(1));
      break;

    case 'search':
    case 'stats':
    case 'rebuild':
      await runKnowledgeCli(command, args.slice(1));
      break;

    case 'diagnose': {
      if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
        console.log(`site-use diagnose — Run anti-detection diagnostic checks

Options:
  --keep-open    Keep the diagnose page open after checks complete
`);
        break;
      }
      const keepOpen = args.includes('--keep-open');
      const browser = await ensureBrowser({ autoLaunch: true });
      await runDiagnose(browser, { keepOpen });
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      const helpTarget = args[1];
      if (helpTarget) {
        // "help search" → re-dispatch as "search --help"
        process.argv = [process.argv[0], process.argv[1], helpTarget, '--help'];
        await run();
      } else {
        console.log(HELP);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
  return true;
}

run().then((shouldExit) => {
  // CLI commands that connect to Chrome (via puppeteer.connect) may leave
  // WebSocket handles that keep the event loop alive.  Explicit exit is the
  // standard pattern for CLI tools that spawn or connect to external processes.
  // MCP server returns false — it must stay alive to serve requests via stdio.
  if (shouldExit) process.exit(process.exitCode ?? 0);
}).catch((err) => {
  console.error('site-use failed:', err);
  process.exit(1);
});

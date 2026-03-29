import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { SiteRuntimeManager } from '../runtime/manager.js';
import { discoverPlugins } from '../registry/discovery.js';

export function getScreenshotPath(dataDir: string, site: string): string {
  return path.join(dataDir, 'screenshots', `${site}.png`);
}

export async function runScreenshotCli(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`site-use screenshot — Take a screenshot of a site's browser tab

Options:
  --site <name>    Site name (required, e.g. "twitter")
`);
    return;
  }

  const siteIdx = args.indexOf('--site');
  if (siteIdx === -1 || siteIdx + 1 >= args.length) {
    process.stderr.write(JSON.stringify({
      error: 'MissingParameter',
      message: '--site is required',
      hint: 'Usage: npx site-use screenshot --site twitter',
    }) + '\n');
    process.exitCode = 1;
    return;
  }
  const site = args[siteIdx + 1];

  const dataDir = process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  const screenshotPath = getScreenshotPath(dataDir, site);

  const plugins = await discoverPlugins();
  const runtimeManager = new SiteRuntimeManager(plugins);

  try {
    const runtime = await runtimeManager.get(site);
    const base64 = await runtime.primitives.screenshot();

    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(base64, 'base64'));

    console.log(JSON.stringify({ screenshot: screenshotPath }));
  } catch (err) {
    process.stderr.write(JSON.stringify({
      error: 'ScreenshotFailed',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Make sure the browser is running and the site has been visited.',
    }) + '\n');
    process.exitCode = 1;
  }
}

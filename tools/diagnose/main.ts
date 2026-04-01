import { ensureBrowser } from '../../dist/browser/browser.js';
import { runDiagnose } from './runner.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`site-use diagnose — Run anti-detection diagnostic checks

Options:
  --keep-open    Keep the diagnose page open after checks complete
`);
  process.exit(0);
}

const keepOpen = args.includes('--keep-open');
const browser = await ensureBrowser({ autoLaunch: true });
await runDiagnose(browser, { keepOpen });

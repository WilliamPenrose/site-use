import { loadHarness, runDomain } from '../harness/runner.js';
import { loadGoldenVariants, loadFixtureDir, promoteFixture, goldenDir, harnessDataDir, type FixtureEntry } from '../harness/fixture-io.js';
import { formatReport, formatSummary } from '../harness/report.js';
import type { HarnessReport } from '../harness/types.js';
import fs from 'node:fs';
import path from 'node:path';

const HARNESS_HELP = `\
site-use harness — Diagnostic harness for schema drift detection

Subcommands:
  run <site>                      Run golden fixtures through full pipeline
    --domain <domain>             Only run a specific domain
    --captured                    Run captured/ fixtures instead of golden
    --quarantine                  Run quarantine/ fixtures instead of golden

  capture <site>                  Manual capture: launch browser, collect feed, save new variants to captured/
  promote <site> <file>           Promote captured/quarantine fixture to golden
  status <site>                   Show fixture counts per partition
`;

function writeError(error: string, message: string): void {
  process.stderr.write(JSON.stringify({ error, message }) + '\n');
  process.exitCode = 1;
}

async function runHarnessRun(site: string, args: string[]): Promise<void> {
  const domainFilter = (() => {
    const idx = args.indexOf('--domain');
    return idx >= 0 ? args[idx + 1] : undefined;
  })();
  const useCaptured = args.includes('--captured');
  const useQuarantine = args.includes('--quarantine');

  const descriptor = await loadHarness(site);
  if (!descriptor) {
    writeError('harness_not_found', `No harness descriptor found for site: ${site}`);
    return;
  }

  const domainNames = domainFilter
    ? [domainFilter]
    : Object.keys(descriptor.domains);

  if (domainNames.length === 0) {
    writeError('no_domains', `No domains defined in harness descriptor for site: ${site}`);
    return;
  }

  const reports: HarnessReport[] = [];

  for (const domainName of domainNames) {
    let variants: FixtureEntry[];
    let source: 'golden' | 'captured' | 'quarantine';

    if (useCaptured || useQuarantine) {
      source = useCaptured ? 'captured' : 'quarantine';
      const dir = harnessDataDir(site, source);
      const entries = loadFixtureDir(dir);
      // Filter by domain prefix
      const filtered = entries.filter(({ filePath }) =>
        path.basename(filePath).startsWith(domainName + '-'),
      );
      variants = filtered.map(({ entry }) => entry);
      if (variants.length === 0) {
        console.log(`[harness] No ${source} fixtures found for ${site}/${domainName}`);
        continue;
      }
    } else {
      source = 'golden';
      const dir = goldenDir(site);
      variants = loadGoldenVariants(dir, domainName);
      if (variants.length === 0) {
        console.log(`[harness] No golden variants found for ${site}/${domainName}`);
        continue;
      }
    }

    const report = await runDomain(descriptor, site, domainName, variants, source);
    reports.push(report);
    console.log(formatReport(report));
  }

  if (reports.length > 0) {
    const summary = formatSummary(reports);
    console.log(summary);
    const anyFailed = reports.some((r) => r.failed > 0);
    if (anyFailed) process.exitCode = 1;
  }
}

async function runHarnessCapture(site: string): Promise<void> {
  console.log(`[harness] Manual capture for site: ${site}`);
  console.log('');
  console.log('To capture new fixtures:');
  console.log(`  1. Run: site-use ${site} feed --dump-raw`);
  console.log(`     This writes raw JSON entries to stdout.`);
  console.log(`  2. Redirect output and place entries in:`);
  console.log(`     ~/.site-use/harness/${site}/captured/`);
  console.log(`  3. Name files as: <domain>-<date>-<id>.json`);
  console.log(`     Example: timeline-2026-03-27-abc123.json`);
  console.log(`  4. Each file must contain a single JSON object with a "_variant" field.`);
  console.log('');
  console.log(`  Once captured, run: site-use harness run ${site} --captured`);
  console.log(`  Then promote passing fixtures: site-use harness promote ${site} <file>`);
}

async function runHarnessPromote(site: string, file: string): Promise<void> {
  if (!fs.existsSync(file)) {
    writeError('file_not_found', `File not found: ${file}`);
    return;
  }

  const golden = goldenDir(site);
  promoteFixture(golden, file);
  console.log(`[harness] Promoted ${path.basename(file)} to golden for site: ${site}`);
}

async function runHarnessStatus(site: string): Promise<void> {
  const golden = goldenDir(site);
  const capturedDir = harnessDataDir(site, 'captured');
  const quarantineDir = harnessDataDir(site, 'quarantine');

  console.log(`[harness] Status for site: ${site}`);
  console.log('');

  // Golden: count variants per domain file
  if (fs.existsSync(golden)) {
    const goldenFiles = fs.readdirSync(golden).filter((f) => f.endsWith('-variants.json'));
    if (goldenFiles.length === 0) {
      console.log('  golden/       (empty)');
    } else {
      console.log('  golden/');
      for (const f of goldenFiles.sort()) {
        const domain = f.replace('-variants.json', '');
        const entries = JSON.parse(fs.readFileSync(path.join(golden, f), 'utf-8')) as unknown[];
        console.log(`    ${domain}: ${entries.length} variant(s)`);
      }
    }
  } else {
    console.log('  golden/       (not found)');
  }

  // Captured: count JSON files
  if (fs.existsSync(capturedDir)) {
    const files = fs.readdirSync(capturedDir).filter((f) => f.endsWith('.json'));
    console.log(`  captured/     ${files.length} file(s)`);
  } else {
    console.log('  captured/     (empty)');
  }

  // Quarantine: count JSON files
  if (fs.existsSync(quarantineDir)) {
    const files = fs.readdirSync(quarantineDir).filter((f) => f.endsWith('.json'));
    console.log(`  quarantine/   ${files.length} file(s)`);
  } else {
    console.log('  quarantine/   (empty)');
  }
}

export async function runHarnessCli(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HARNESS_HELP);
      break;

    case 'run': {
      const site = args[1];
      if (!site) {
        writeError('missing_site', 'Usage: site-use harness run <site> [--domain <domain>] [--captured] [--quarantine]');
        return;
      }
      await runHarnessRun(site, args.slice(2));
      break;
    }

    case 'capture': {
      const site = args[1];
      if (!site) {
        writeError('missing_site', 'Usage: site-use harness capture <site>');
        return;
      }
      await runHarnessCapture(site);
      break;
    }

    case 'promote': {
      const site = args[1];
      const file = args[2];
      if (!site || !file) {
        writeError('missing_args', 'Usage: site-use harness promote <site> <file>');
        return;
      }
      await runHarnessPromote(site, file);
      break;
    }

    case 'status': {
      const site = args[1];
      if (!site) {
        writeError('missing_site', 'Usage: site-use harness status <site>');
        return;
      }
      await runHarnessStatus(site);
      break;
    }

    default:
      writeError('unknown_subcommand', `Unknown harness subcommand: ${subcommand}\n\n${HARNESS_HELP}`);
  }
}

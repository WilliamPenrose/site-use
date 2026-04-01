import { loadHarness, runDomain } from '../harness/runner.js';
import { loadGoldenVariants, loadFixtureDir, promoteDomain, goldenDir, harnessDataDir, type FixtureEntry } from '../harness/fixture-io.js';
import { captureForHarness } from '../harness/capture.js';
import { formatReport, formatSummary } from '../harness/report.js';
import type { HarnessReport } from '../harness/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HARNESS_HELP = `\
site-use harness — Diagnostic harness for schema drift detection

Subcommands:
  run <site>                      Run golden fixtures through full pipeline
    --domain <domain>             Only run a specific domain
    --captured                    Run captured/ fixtures instead of golden
    --quarantine                  Run quarantine/ fixtures instead of golden

  capture <site>                  Read dump files, extract and diff against golden, save novel variants
  promote <site> [domain]         Promote captured variants to golden (all domains if omitted)
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
      if (source === 'captured') {
        // New format: {domain}-variants.json
        variants = loadGoldenVariants(dir, domainName);
      } else {
        // Quarantine still uses old per-file format
        const entries = loadFixtureDir(dir);
        const filtered = entries.filter(({ filePath }) =>
          path.basename(filePath).startsWith(domainName + '-'),
        );
        variants = filtered.map(({ entry }) => entry);
      }
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
  const descriptor = await loadHarness(site);
  if (!descriptor) {
    writeError('harness_not_found', `No harness descriptor found for site: ${site}`);
    return;
  }

  const dataDir = process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  const dumpDir = path.join(dataDir, 'dump', site);

  if (!fs.existsSync(dumpDir)) {
    writeError('no_dump_files', `No dump files found. Run "site-use ${site} feed --dump-raw" first.`);
    return;
  }

  const dumpFiles = fs.readdirSync(dumpDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.prev.json'));

  if (dumpFiles.length === 0) {
    writeError('no_dump_files', `No dump files found. Run "site-use ${site} feed --dump-raw" first.`);
    return;
  }

  const goldenDirPath = goldenDir(site);
  const capturedDirPath = harnessDataDir(site, 'captured');
  let totalCaptured = 0;
  let totalSkipped = 0;

  for (const file of dumpFiles) {
    const responseBody = fs.readFileSync(path.join(dumpDir, file), 'utf-8');
    for (const [domainName, domain] of Object.entries(descriptor.domains)) {
      const result = await captureForHarness(responseBody, domain, domainName, goldenDirPath, capturedDirPath);
      totalCaptured += result.captured;
      totalSkipped += result.skipped;
    }
  }

  console.log(`[harness] Captured ${totalCaptured}, skipped ${totalSkipped}.`);
  if (totalCaptured > 0) {
    console.log(`  Files in ${capturedDirPath}`);
  }
}

async function runHarnessPromote(site: string, domain?: string): Promise<void> {
  const goldenDirPath = goldenDir(site);
  const capturedDir = harnessDataDir(site, 'captured');

  if (!fs.existsSync(capturedDir)) {
    writeError('no_captured', `No captured fixtures found for site: ${site}`);
    return;
  }

  const domains = domain
    ? [domain]
    : fs.readdirSync(capturedDir)
        .filter(f => f.endsWith('-variants.json'))
        .map(f => f.replace('-variants.json', ''));

  if (domains.length === 0) {
    writeError('no_captured', `No captured fixtures found for site: ${site}`);
    return;
  }

  for (const d of domains) {
    promoteDomain(goldenDirPath, capturedDir, d);
    console.log(`[harness] Promoted ${d} variants to golden for site: ${site}`);
  }
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

  // Captured: count variants per domain file (same format as golden)
  if (fs.existsSync(capturedDir)) {
    const capturedFiles = fs.readdirSync(capturedDir).filter(f => f.endsWith('-variants.json'));
    if (capturedFiles.length === 0) {
      console.log('  captured/     (empty)');
    } else {
      console.log('  captured/');
      for (const f of capturedFiles.sort()) {
        const domain = f.replace('-variants.json', '');
        const entries = JSON.parse(fs.readFileSync(path.join(capturedDir, f), 'utf-8')) as unknown[];
        console.log(`    ${domain}: ${entries.length} variant(s)`);
      }
    }
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
      if (!site) {
        writeError('missing_args', 'Usage: site-use harness promote <site> [domain]');
        return;
      }
      const domain = args[2]; // optional
      await runHarnessPromote(site, domain);
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
      writeError('unknown_subcommand', `Unknown harness subcommand: ${subcommand}`);
      console.log(HARNESS_HELP);
  }
}

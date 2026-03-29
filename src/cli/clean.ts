// src/cli/clean.ts
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { createStore } from '../storage/index.js';
import { getKnowledgeDbPath } from '../config.js';
import { localToUtc } from './knowledge.js';
import { utcToLocalIso } from '../format-date.js';
import type { DeleteParams, DeletePreview } from '../storage/types.js';

const CLEAN_HELP = `\
site-use clean — Delete stored items by filter

Usage: site-use clean --site <site> <filters> [options]

Required:
  --site <site>              Site to clean (e.g. twitter)

Filters (at least one required):
  --before <date>            Delete items before this tweet date (local time)
  --after <date>             Delete items after this tweet date (local time)
  --ingested-before <date>   Delete items ingested before this date (local time)
  --ingested-after <date>    Delete items ingested after this date (local time)
  --author <handle>          Delete items by this author (@ prefix optional)

Options:
  --no-backup                Skip automatic backup before deletion

Safety:
  All parameters must be explicit — no defaults.
  Confirmation prompt before deletion.
  Automatic backup to ~/.site-use/backups/ (use --no-backup to skip).
  Deletion is batched — Ctrl+C is safe (committed batches persist).

Examples:
  site-use clean --site twitter --before 2026-03-01
  site-use clean --site twitter --author elonmusk
  site-use clean --site twitter --ingested-after 2026-03-20 --ingested-before 2026-03-21
  site-use clean --site twitter --after 2026-01-01 --before 2026-02-01 --no-backup
`;

interface ParseResult {
  params?: DeleteParams;
  noBackup: boolean;
  error?: string;
  help?: boolean;
}

export function parseCleanArgs(args: string[]): ParseResult {
  let site: string | undefined;
  let before: string | undefined;
  let after: string | undefined;
  let ingestedBefore: string | undefined;
  let ingestedAfter: string | undefined;
  let author: string | undefined;
  let noBackup = false;

  const needsValue = new Set([
    '--site', '--before', '--after',
    '--ingested-before', '--ingested-after', '--author',
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true, noBackup: false };

    if (needsValue.has(arg) && (i + 1 >= args.length || args[i + 1].startsWith('--'))) {
      return { error: `Missing value for ${arg}`, noBackup: false };
    }

    switch (arg) {
      case '--site':
        site = args[++i];
        break;
      case '--before':
        before = localToUtc(args[++i]);
        break;
      case '--after':
        after = localToUtc(args[++i]);
        break;
      case '--ingested-before':
        ingestedBefore = localToUtc(args[++i]);
        break;
      case '--ingested-after':
        ingestedAfter = localToUtc(args[++i]);
        break;
      case '--author':
        author = args[++i].replace(/^@/, '');
        break;
      case '--no-backup':
        noBackup = true;
        break;
      default:
        if (arg.startsWith('--')) return { error: `Unknown option: ${arg}`, noBackup: false };
        return { error: `Unexpected argument: ${arg}`, noBackup: false };
    }
  }

  if (!site) return { error: '--site is required', noBackup: false };
  if (!before && !after && !ingestedBefore && !ingestedAfter && !author) {
    return {
      error: 'At least one filter required (--before, --after, --ingested-before, --ingested-after, --author)',
      noBackup: false,
    };
  }

  return { params: { site, before, after, ingestedBefore, ingestedAfter, author }, noBackup };
}


export function formatPreview(site: string, preview: DeletePreview): string {
  const maxAuthorsShown = 10;
  const authorLines = preview.authors.slice(0, maxAuthorsShown)
    .map((a) => `@${a.handle} (${a.count})`)
    .join(', ');
  const extra = preview.authors.length > maxAuthorsShown
    ? `, ... ${preview.authors.length - maxAuthorsShown} more`
    : '';

  const lines = [
    `Found ${preview.totalCount} items matching filters:`,
    `  Site:     ${site}`,
    `  Authors:  ${authorLines}${extra}`,
  ];

  if (preview.timeRange) {
    const from = utcToLocalIso(preview.timeRange.from);
    const to = utcToLocalIso(preview.timeRange.to);
    lines.push(`  Time:     ${from} → ${to}`);
  }

  return lines.join('\n');
}

export function formatProgress(deletedSoFar: number, totalCount: number, etaSeconds: number): string {
  const pct = Math.round((deletedSoFar / totalCount) * 100);
  if (deletedSoFar >= totalCount) {
    return `Deleting... ${deletedSoFar}/${totalCount} (${pct}%) — done`;
  }
  const etaStr = etaSeconds < 1 ? '<1s' : `~${Math.ceil(etaSeconds)}s`;
  return `Deleting... ${deletedSoFar}/${totalCount} (${pct}%) — ETA ${etaStr}`;
}

function getDataDir(): string {
  return process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
}

export async function runCleanCli(args: string[]): Promise<void> {
  const { params, noBackup, error, help } = parseCleanArgs(args);

  if (help) {
    console.log(CLEAN_HELP);
    return;
  }

  if (error || !params) {
    process.stderr.write(`Error: ${error}\n\n`);
    console.log(CLEAN_HELP);
    process.exitCode = 1;
    return;
  }

  const dataDir = getDataDir();
  const dbPath = getKnowledgeDbPath(dataDir);
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`Database not found at ${dbPath}\n`);
    process.exitCode = 1;
    return;
  }

  const store = createStore(dbPath);

  try {
    const preview = await store.previewDelete(params);

    if (preview.totalCount === 0) {
      console.log('No items match the given filters. Nothing to delete.');
      return;
    }

    console.log(formatPreview(params.site, preview));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await rl.question(`\nDelete these ${preview.totalCount} items? (y/N) `);
    } finally {
      rl.close();
    }

    if (answer!.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    // Backup before deletion (unless --no-backup)
    if (!noBackup) {
      try {
        const backupDir = path.join(dataDir, 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `clean-${timestamp}.jsonl`);
        const fd = fs.openSync(backupPath, 'w');
        try {
          store.exportItems(params, (line) => {
            fs.writeSync(fd, line + '\n');
          });
        } finally {
          fs.closeSync(fd);
        }
        console.log(`Backed up to ${backupPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: Failed to create backup: ${msg}\n`);
        return;
      }
    }

    const startTime = Date.now();

    const result = await store.deleteItems(params, {
      onProgress: (p) => {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = p.deletedSoFar / elapsed;
        const remaining = p.totalCount - p.deletedSoFar;
        const eta = rate > 0 ? remaining / rate : 0;
        process.stdout.write(`\r${formatProgress(p.deletedSoFar, p.totalCount, eta)}`);
      },
    });

    process.stdout.write('\n');
    console.log(`Deleted ${result.deleted} items.`);
  } finally {
    store.close();
  }
}

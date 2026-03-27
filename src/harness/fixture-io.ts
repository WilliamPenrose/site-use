import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Path to golden fixtures in the source tree.
 * Resolves from __dirname (dist/harness/ or src/harness/) up to project root,
 * then into src/sites/{site}/__tests__/fixtures/golden/.
 * Works both from compiled dist/ (CLI) and from src/ (vitest).
 */
export function goldenDir(site: string): string {
  // __dirname is either dist/harness/ or src/harness/ — go up to project root
  const projectRoot = path.resolve(__dirname, '..', '..');
  return path.join(projectRoot, 'src', 'sites', site, '__tests__', 'fixtures', 'golden');
}

/** Path to harness data (captured/quarantine) under ~/.site-use/harness. */
export function harnessDataDir(site: string, partition: 'captured' | 'quarantine'): string {
  const dataDir = process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  return path.join(dataDir, 'harness', site, partition);
}

export interface FixtureEntry {
  _variant: string;
  [key: string]: unknown;
}

/** Load golden variants for a specific domain from the golden directory. */
export function loadGoldenVariants(dir: string, domain: string): FixtureEntry[] {
  const filePath = path.join(dir, `${domain}-variants.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as FixtureEntry[];
}

/** Load all fixture JSON files from a directory. Returns array of {filePath, entry}. */
export function loadFixtureDir(dir: string): Array<{ filePath: string; entry: FixtureEntry }> {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const filePath = path.join(dir, f);
    const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as FixtureEntry;
    return { filePath, entry };
  });
}

/** Save a single captured entry. Returns the written file path. */
export function saveCaptured(capturedDir: string, domain: string, entry: FixtureEntry): string {
  fs.mkdirSync(capturedDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const id = Math.random().toString(36).slice(2, 8);
  const filename = `${domain}-${date}-${id}.json`;
  const filePath = path.join(capturedDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
  return filePath;
}

/** Upsert entries into a single captured file per domain. Returns file path. */
export function upsertCaptured(capturedDir: string, domain: string, entries: FixtureEntry[]): string {
  const filePath = path.join(capturedDir, `${domain}-variants.json`);
  if (entries.length === 0) return filePath;

  fs.mkdirSync(capturedDir, { recursive: true });

  let existing: FixtureEntry[] = [];
  if (fs.existsSync(filePath)) {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as FixtureEntry[];
  }

  for (const entry of entries) {
    const idx = existing.findIndex(e => e._variant === entry._variant);
    if (idx >= 0) {
      existing[idx] = entry;
    } else {
      existing.push(entry);
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  return filePath;
}

/**
 * Promote all captured variants for a domain into golden.
 * Upserts by _variant key. Deletes the captured file after promotion.
 */
export function promoteDomain(goldenDirPath: string, capturedDir: string, domain: string): void {
  const capturedFile = path.join(capturedDir, `${domain}-variants.json`);
  if (!fs.existsSync(capturedFile)) {
    throw new Error(`No captured file found: ${capturedFile}`);
  }

  const captured = JSON.parse(fs.readFileSync(capturedFile, 'utf-8')) as FixtureEntry[];
  const goldenFile = path.join(goldenDirPath, `${domain}-variants.json`);

  let golden: FixtureEntry[] = [];
  if (fs.existsSync(goldenFile)) {
    golden = JSON.parse(fs.readFileSync(goldenFile, 'utf-8')) as FixtureEntry[];
  }

  for (const entry of captured) {
    const idx = golden.findIndex(g => g._variant === entry._variant);
    if (idx >= 0) {
      golden[idx] = entry;
    } else {
      golden.push(entry);
    }
  }

  fs.mkdirSync(path.dirname(goldenFile), { recursive: true });
  fs.writeFileSync(goldenFile, JSON.stringify(golden, null, 2));
  fs.unlinkSync(capturedFile);
}

/**
 * Promote a fixture from captured/quarantine into golden.
 * Domain is inferred from the filename prefix (e.g. "timeline-2026-03-27-abc.json" -> "timeline").
 * If a variant with the same _variant string exists in golden, it is replaced. Otherwise appended.
 * Source file is deleted after promotion.
 */
export function promoteFixture(goldenDirPath: string, sourceFilePath: string): void {
  const entry = JSON.parse(fs.readFileSync(sourceFilePath, 'utf-8')) as FixtureEntry;
  const filename = path.basename(sourceFilePath);
  const domain = filename.split('-')[0]; // "timeline-2026-..." -> "timeline"
  const goldenFile = path.join(goldenDirPath, `${domain}-variants.json`);

  let golden: FixtureEntry[] = [];
  if (fs.existsSync(goldenFile)) {
    golden = JSON.parse(fs.readFileSync(goldenFile, 'utf-8')) as FixtureEntry[];
  }

  const existingIdx = golden.findIndex(g => g._variant === entry._variant);
  if (existingIdx >= 0) {
    golden[existingIdx] = entry;
  } else {
    golden.push(entry);
  }

  fs.writeFileSync(goldenFile, JSON.stringify(golden, null, 2));
  fs.unlinkSync(sourceFilePath);
}

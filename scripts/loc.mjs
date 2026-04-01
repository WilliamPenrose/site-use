#!/usr/bin/env node
/**
 * Count lines of code in src/ (excluding tests).
 *
 * Usage:
 *   node scripts/loc.mjs          # summary by directory
 *   node scripts/loc.mjs sites/twitter  # files in a specific directory
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const target = process.argv[2]; // optional subpath like "sites/twitter"

function isTestFile(filePath) {
  return filePath.includes('__tests__') || filePath.includes('.test.');
}

function collectTs(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTs(full));
    } else if (entry.name.endsWith('.ts') && !isTestFile(full)) {
      const lines = fs.readFileSync(full, 'utf-8').split('\n').length;
      results.push({ file: full, lines });
    }
  }
  return results;
}

function printTable(rows, total) {
  const maxName = Math.max(...rows.map(r => r.name.length), 4);
  for (const { name, lines } of rows) {
    console.log(`  ${String(lines).padStart(6)}  ${name}`);
  }
  console.log(`  ${'-'.repeat(6)}  ${'-'.repeat(maxName)}`);
  console.log(`  ${String(total).padStart(6)}  total`);
}

if (target) {
  // Detail mode: list files in a specific directory
  const dir = path.join(ROOT, 'src', target);
  const files = collectTs(dir);
  if (files.length === 0) {
    console.log(`No .ts files found in src/${target}/`);
    process.exit(1);
  }
  files.sort((a, b) => b.lines - a.lines);
  const total = files.reduce((sum, f) => sum + f.lines, 0);
  const rows = files.map(f => ({ name: path.relative(dir, f.file), lines: f.lines }));
  console.log(`\nsrc/${target}/\n`);
  printTable(rows, total);
} else {
  // Summary mode: lines per top-level directory + root files
  const srcDir = path.join(ROOT, 'src');
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  const dirs = [];
  let rootLines = 0;
  const rootFiles = [];

  for (const entry of entries) {
    const full = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      const files = collectTs(full);
      const lines = files.reduce((sum, f) => sum + f.lines, 0);
      if (lines > 0) dirs.push({ name: entry.name + '/', lines });
    } else if (entry.name.endsWith('.ts') && !isTestFile(full)) {
      const lines = fs.readFileSync(full, 'utf-8').split('\n').length;
      rootLines += lines;
      rootFiles.push({ name: entry.name, lines });
    }
  }

  dirs.sort((a, b) => b.lines - a.lines);
  if (rootLines > 0) dirs.push({ name: '(root files)', lines: rootLines });
  const total = dirs.reduce((sum, d) => sum + d.lines, 0);

  console.log('\nsrc/ lines of code (excluding tests)\n');
  printTable(dirs, total);
}

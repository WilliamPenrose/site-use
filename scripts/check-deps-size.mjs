#!/usr/bin/env node
// Reports the size of each package in node_modules and dist/, sorted by size descending.
// Distinguishes production deps from devDependencies.
// Usage: node scripts/check-deps-size.mjs

import { readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const DIST = path.join(ROOT, 'dist');

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      total += statSync(full).size;
    }
  }
  return total;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// Get production dependency names (recursive) via pnpm
function getProdDeps() {
  try {
    const output = execSync('pnpm ls --prod --depth Infinity --json', { cwd: ROOT, encoding: 'utf-8' });
    const data = JSON.parse(output);
    const names = new Set();
    function walk(deps) {
      if (!deps) return;
      for (const [name, info] of Object.entries(deps)) {
        names.add(name);
        if (info.dependencies) walk(info.dependencies);
      }
    }
    // pnpm ls --json returns an array
    for (const project of Array.isArray(data) ? data : [data]) {
      walk(project.dependencies);
    }
    return names;
  } catch {
    return null; // fallback: don't distinguish
  }
}

// Scan all packages via pnpm's .pnpm directory
const packages = [];
const pnpmDir = path.join(NODE_MODULES, '.pnpm');

if (existsSync(pnpmDir)) {
  for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'lock.yaml') continue;
    const innerNm = path.join(pnpmDir, entry.name, 'node_modules');
    if (!existsSync(innerNm)) continue;
    for (const pkg of readdirSync(innerNm, { withFileTypes: true })) {
      if (!pkg.isDirectory() && !pkg.isSymbolicLink()) continue;
      if (pkg.name.startsWith('.')) continue;
      if (pkg.name.startsWith('@')) {
        const scopeDir = path.join(innerNm, pkg.name);
        for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
          if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
          const realPath = realpathSync(path.join(scopeDir, sub.name));
          if (existsSync(path.join(realPath, 'package.json'))) {
            packages.push({ name: `${pkg.name}/${sub.name}`, size: dirSize(realPath) });
          }
        }
      } else {
        const realPath = realpathSync(path.join(innerNm, pkg.name));
        if (existsSync(path.join(realPath, 'package.json'))) {
          packages.push({ name: pkg.name, size: dirSize(realPath) });
        }
      }
    }
  }
} else {
  for (const entry of readdirSync(NODE_MODULES, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(NODE_MODULES, entry.name);
      for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        packages.push({ name: `${entry.name}/${sub.name}`, size: dirSize(path.join(scopeDir, sub.name)) });
      }
    } else {
      packages.push({ name: entry.name, size: dirSize(path.join(NODE_MODULES, entry.name)) });
    }
  }
}

// Deduplicate
const deduped = new Map();
for (const pkg of packages) {
  const existing = deduped.get(pkg.name);
  if (!existing || pkg.size > existing.size) {
    deduped.set(pkg.name, pkg);
  }
}
const allPackages = [...deduped.values()].sort((a, b) => b.size - a.size);

// Classify prod vs dev
const prodDeps = getProdDeps();

function printSection(title, pkgs) {
  const total = pkgs.reduce((sum, p) => sum + p.size, 0);
  console.log(`${title}:`);
  console.log('-'.repeat(55));
  for (const pkg of pkgs) {
    console.log(`  ${formatSize(pkg.size).padStart(10)}  ${pkg.name}`);
  }
  console.log('-'.repeat(55));
  console.log(`  ${formatSize(total).padStart(10)}  TOTAL (${pkgs.length} packages)\n`);
  return total;
}

let prodTotal = 0;
let devTotal = 0;

if (prodDeps) {
  const prod = allPackages.filter(p => prodDeps.has(p.name));
  const dev = allPackages.filter(p => !prodDeps.has(p.name));
  prodTotal = printSection('Production dependencies', prod);
  devTotal = printSection('Dev dependencies (not shipped to users)', dev);
} else {
  prodTotal = printSection('All dependencies', allPackages);
}

// dist
let distTotal = 0;
if (existsSync(DIST)) {
  distTotal = dirSize(DIST);
  console.log(`Build output (dist/):  ${formatSize(distTotal)}`);
} else {
  console.log('Build output (dist/):  not built yet');
}

// Summary
console.log(`\nUser install size:  ${formatSize(prodTotal + distTotal)}  (production deps + dist)`);
if (devTotal > 0) {
  console.log(`Dev total:          ${formatSize(prodTotal + devTotal + distTotal)}  (including devDependencies)`);
}

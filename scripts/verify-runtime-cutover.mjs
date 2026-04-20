#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const FORBIDDEN_PATHS = [
  'dist/runtime/manager.js',
  'dist/runtime/manager.d.ts',
  'dist/runtime/build-site-stack.js',
  'dist/runtime/build-site-stack.d.ts',
  'dist/primitives/auth-guard.js',
  'dist/primitives/auth-guard.d.ts',
  'dist/primitives/click-enhanced.js',
  'dist/primitives/click-enhanced.d.ts',
  'dist/primitives/puppeteer-backend.js',
  'dist/primitives/puppeteer-backend.d.ts',
  'dist/primitives/rate-limit-detect.js',
  'dist/primitives/rate-limit-detect.d.ts',
  'dist/primitives/rate-limiter.js',
  'dist/primitives/rate-limiter.d.ts',
  'dist/primitives/scroll-enhanced.js',
  'dist/primitives/scroll-enhanced.d.ts',
  'dist/primitives/throttle.js',
  'dist/primitives/throttle.d.ts',
  'packages/core',
];

const REQUIRED_CHECKS = [
  {
    path: 'dist/runtime/index.js',
    forbiddenText: 'SiteRuntimeManager',
    description: 'runtime barrel must not export SiteRuntimeManager',
  },
  {
    path: 'dist/primitives/factory.js',
    forbiddenText: 'buildPrimitivesStack',
    description: 'root primitives surface must not expose buildPrimitivesStack',
  },
];

function toAbsolute(relativePath) {
  return path.join(ROOT, relativePath);
}

function createFailure(message) {
  return new Error(`[runtime-cutover] ${message}`);
}

export function verifyRuntimeCutover() {
  for (const relativePath of FORBIDDEN_PATHS) {
    if (fs.existsSync(toAbsolute(relativePath))) {
      throw createFailure(`forbidden path still exists: ${relativePath}`);
    }
  }

  for (const check of REQUIRED_CHECKS) {
    const absolutePath = toAbsolute(check.path);
    if (!fs.existsSync(absolutePath)) {
      throw createFailure(`required artifact is missing: ${check.path}`);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    if (content.includes(check.forbiddenText)) {
      throw createFailure(`${check.description}: ${check.path}`);
    }
  }

  return '[runtime-cutover] verification passed';
}

const entryHref = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (entryHref && import.meta.url === entryHref) {
  try {
    console.log(verifyRuntimeCutover());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

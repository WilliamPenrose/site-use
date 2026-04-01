#!/usr/bin/env node --no-warnings=ExperimentalWarning

// Thin entry point: check Node version before any static imports.
// node:sqlite (used by storage) requires Node >= 22.14.0 and will crash
// with an unhelpful error on older versions, so we validate early.

const MIN_MAJOR = 22;
const MIN_MINOR = 14;

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
  console.error(
    `site-use requires Node.js >= ${MIN_MAJOR}.${MIN_MINOR}.0, but you are running ${process.versions.node}.\n` +
    'Download the latest LTS from https://nodejs.org/',
  );
  process.exit(1);
}

// Version OK — dynamically import the real entry point
import('./index.js').catch((err) => {
  console.error('site-use failed:', err);
  process.exit(1);
});

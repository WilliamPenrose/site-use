import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'verify-runtime-cutover.mjs');
const DIST_ENTRY = path.join(ROOT, 'dist', 'index.js');

describe('runtime cutover verification', () => {
  it('built artifacts keep only the final runtime cutover surface', async () => {
    expect(fs.existsSync(DIST_ENTRY)).toBe(true);

    const { verifyRuntimeCutover } = await import(VERIFY_SCRIPT);
    expect(() => verifyRuntimeCutover()).not.toThrow();
  }, 120_000);
});

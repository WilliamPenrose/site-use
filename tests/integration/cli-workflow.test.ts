import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const bin = path.resolve('dist/index.js');

describe('CLI workflow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-cli-wf-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('twitter feed --local with no database exits 1 with DatabaseNotFound', () => {
    try {
      execFileSync('node', [bin, 'twitter', 'feed', '--local'], {
        env: { ...process.env, SITE_USE_DATA_DIR: tmpDir },
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect.unreachable('Expected process to exit with code 1');
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      expect(e.status).toBe(1);
      expect(e.stderr).toContain('DatabaseNotFound');
    }
  });

  it('twitter feed --local shows hint on stderr', () => {
    try {
      execFileSync('node', [bin, 'twitter', 'feed', '--local'], {
        env: { ...process.env, SITE_USE_DATA_DIR: tmpDir },
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect.unreachable('Expected process to exit with code 1');
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      expect(e.stderr).toContain('Using local data (--local)');
    }
  });

  it('twitter feed --fetch --local exits 1 with mutually exclusive error', () => {
    try {
      execFileSync('node', [bin, 'twitter', 'feed', '--fetch', '--local'], {
        env: { ...process.env, SITE_USE_DATA_DIR: tmpDir },
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect.unreachable('Expected process to exit with code 1');
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      expect(e.status).toBe(1);
      expect(e.stderr).toContain('mutually exclusive');
    }
  });


  it('twitter unknown action exits 1 with UnknownAction', () => {
    try {
      execFileSync('node', [bin, 'twitter', 'unknown'], {
        env: { ...process.env, SITE_USE_DATA_DIR: tmpDir },
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect.unreachable('Expected process to exit with code 1');
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      expect(e.status).toBe(1);
      expect(e.stderr).toContain('Unknown');
    }
  });
});

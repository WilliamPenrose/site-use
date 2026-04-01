import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isPidAlive, acquireLock, releaseLock, withLock } from '../../src/lock.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('isPidAlive', () => {
  it('returns true for current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for non-existent PID', () => {
    expect(isPidAlive(99999999)).toBe(false);
  });
});

describe('file lock', () => {
  const tmpDir = path.join(os.tmpdir(), 'site-use-lock-test-' + process.pid);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
    fs.rmdirSync(tmpDir);
  });

  it('acquires and releases a lock', async () => {
    await acquireLock({ lockDir: tmpDir });
    const lockPath = path.join(tmpDir, 'op.lock');
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseLock();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('acquires per-site lock with correct filename', async () => {
    await acquireLock({ lockDir: tmpDir, site: 'twitter' });
    const lockPath = path.join(tmpDir, 'op.twitter.lock');
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseLock();
  });

  it('cleans up stale lock from dead PID', async () => {
    const lockPath = path.join(tmpDir, 'op.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }));
    await acquireLock({ lockDir: tmpDir });
    releaseLock();
  });

  it('withLock releases on success', async () => {
    const result = await withLock(async () => 42, { lockDir: tmpDir });
    expect(result).toBe(42);
    expect(fs.existsSync(path.join(tmpDir, 'op.lock'))).toBe(false);
  });

  it('withLock releases on exception', async () => {
    await expect(withLock(async () => { throw new Error('boom'); }, { lockDir: tmpDir }))
      .rejects.toThrow('boom');
    expect(fs.existsSync(path.join(tmpDir, 'op.lock'))).toBe(false);
  });
});

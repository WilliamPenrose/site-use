import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;   // Windows: exists but no permission
    return false;
  }
}

interface LockOptions {
  lockDir?: string;
  site?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

let currentLockPath: string | null = null;

function getLockPath(opts: LockOptions = {}): string {
  const dir = opts.lockDir ?? getConfig().dataDir;
  const filename = opts.site ? `op.${opts.site}.lock` : 'op.lock';
  return path.join(dir, filename);
}

export async function acquireLock(opts: LockOptions = {}): Promise<void> {
  const lockPath = getLockPath(opts);
  const pollInterval = opts.pollIntervalMs ?? 500;
  const timeout = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeout;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
      fs.writeSync(fd, content);
      fs.closeSync(fd);
      currentLockPath = lockPath;
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      try {
        const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        if (!isPidAlive(data.pid)) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  }
}

export function releaseLock(): void {
  if (currentLockPath) {
    try { fs.unlinkSync(currentLockPath); } catch {}
    currentLockPath = null;
  }
}

export async function withLock<T>(
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  await acquireLock(opts);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });

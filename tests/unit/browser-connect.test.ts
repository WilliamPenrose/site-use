import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readChromeJson, writeChromeJson, type ChromeInfo } from '../../src/browser/browser.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('readChromeJson / writeChromeJson', () => {
  const tmpDir = path.join(os.tmpdir(), 'site-use-chrome-json-test-' + process.pid);
  const chromeJsonPath = path.join(tmpDir, 'chrome.json');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
      fs.rmdirSync(tmpDir);
    } catch {}
  });

  it('returns null when file is missing', () => {
    expect(readChromeJson(chromeJsonPath)).toBeNull();
  });

  it('writes and reads valid JSON', () => {
    const info: ChromeInfo = { pid: process.pid, wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc' };
    writeChromeJson(chromeJsonPath, info);

    const result = readChromeJson(chromeJsonPath);
    expect(result).toEqual(info);
  });

  it('cleans up and returns null when PID is dead', () => {
    const info: ChromeInfo = { pid: 99999999, wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/dead' };
    writeChromeJson(chromeJsonPath, info);

    const result = readChromeJson(chromeJsonPath);
    expect(result).toBeNull();
    // File should have been deleted
    expect(fs.existsSync(chromeJsonPath)).toBe(false);
  });

  it('returns info when PID is alive (current process)', () => {
    const info: ChromeInfo = { pid: process.pid, wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/alive' };
    writeChromeJson(chromeJsonPath, info);

    const result = readChromeJson(chromeJsonPath);
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(process.pid);
    expect(result!.wsEndpoint).toBe(info.wsEndpoint);
  });
});

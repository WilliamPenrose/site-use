import { describe, it, expect } from 'vitest';
import { getScreenshotPath } from '../../src/cli/screenshot.js';

describe('getScreenshotPath', () => {
  it('returns path under data dir with site name', () => {
    const p = getScreenshotPath('/data', 'twitter');
    expect(p).toContain('screenshots');
    expect(p).toContain('twitter.png');
  });

  it('uses different filenames for different sites', () => {
    const a = getScreenshotPath('/data', 'twitter');
    const b = getScreenshotPath('/data', 'reddit');
    expect(a).not.toBe(b);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { unfreezePages } from '../browser.js';

function mockPage(url = 'https://x.com/home') {
  const cdp = {
    send: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
  };
  return {
    url: () => url,
    createCDPSession: vi.fn().mockResolvedValue(cdp),
    _cdp: cdp,
  };
}

describe('unfreezePages', () => {
  it('sends Page.setWebLifecycleState active to each page', async () => {
    const p1 = mockPage('https://x.com/home');
    const p2 = mockPage('https://example.com');

    await unfreezePages([p1 as any, p2 as any]);

    expect(p1._cdp.send).toHaveBeenCalledWith(
      'Page.setWebLifecycleState',
      { state: 'active' },
    );
    expect(p2._cdp.send).toHaveBeenCalledWith(
      'Page.setWebLifecycleState',
      { state: 'active' },
    );
    expect(p1._cdp.detach).toHaveBeenCalled();
    expect(p2._cdp.detach).toHaveBeenCalled();
  });

  it('does not throw when a page CDP session fails', async () => {
    const p1 = mockPage();
    p1.createCDPSession = vi.fn().mockRejectedValue(new Error('detached'));
    await expect(unfreezePages([p1 as any])).resolves.toBeUndefined();
  });

  it('handles empty page list', async () => {
    await expect(unfreezePages([])).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { hover } from '../../src/ops/hover.js';

function mockPrimitives(rect: { x: number; y: number; w: number; h: number } | null) {
  const sendFn = vi.fn().mockResolvedValue(undefined);
  const detachFn = vi.fn().mockResolvedValue(undefined);

  return {
    primitives: {
      evaluate: vi.fn().mockResolvedValue(rect),
      getRawPage: vi.fn().mockResolvedValue({
        createCDPSession: vi.fn().mockResolvedValue({
          send: sendFn,
          detach: detachFn,
        }),
      }),
    },
    sendFn,
    detachFn,
  };
}

describe('hover', () => {
  it('dispatches mouseMoved to element center', async () => {
    const { primitives, sendFn } = mockPrimitives({ x: 100, y: 200, w: 50, h: 30 });

    await hover(primitives as any, '.card');

    expect(sendFn).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 125,
      y: 215,
    });
  });

  it('throws when element is not found', async () => {
    const { primitives } = mockPrimitives(null);

    await expect(hover(primitives as any, '.missing')).rejects.toThrow(/not found/);
  });

  it('throws when element has zero size', async () => {
    const { primitives } = mockPrimitives({ x: 10, y: 10, w: 0, h: 0 });

    await expect(hover(primitives as any, '.hidden')).rejects.toThrow(/not found|zero/);
  });

  it('detaches CDP session after use', async () => {
    const { primitives, detachFn } = mockPrimitives({ x: 0, y: 0, w: 100, h: 100 });

    await hover(primitives as any, '.card');

    expect(detachFn).toHaveBeenCalled();
  });

  it('detaches CDP session even on error', async () => {
    const detachFn = vi.fn().mockResolvedValue(undefined);
    const primitives = {
      evaluate: vi.fn().mockResolvedValue({ x: 0, y: 0, w: 100, h: 100 }),
      getRawPage: vi.fn().mockResolvedValue({
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockRejectedValue(new Error('CDP error')),
          detach: detachFn,
        }),
      }),
    };

    await expect(hover(primitives as any, '.card')).rejects.toThrow('CDP error');
    expect(detachFn).toHaveBeenCalled();
  });
});

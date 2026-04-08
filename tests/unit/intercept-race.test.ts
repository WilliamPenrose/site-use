/**
 * Proves the Path Y race condition vulnerability and its fix.
 * See: https://github.com/WilliamPenrose/site-use/issues/18
 *
 * Path Y: R1's response EVENT fires AFTER reset/swapHandler.
 * This happens when navigate()'s HomeTimeline XHR response headers arrive
 * after the `load` event (waitUntil: 'load' does not wait for XHR).
 *
 * "Scheme H" = prior fix (capture-before-await + swapHandler + generation)
 * "Scheme I" = current fix (request Set tracking + post-await validity check)
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { InterceptHandler, InterceptControl } from '../../src/primitives/types.js';

// ---------------------------------------------------------------------------
// Mock Puppeteer Page — gives us precise control over event emission order
// ---------------------------------------------------------------------------
class MockPage extends EventEmitter {
  emitRequest(request: object) {
    this.emit('request', request);
  }

  emitResponse(response: { request: () => object; url: () => string; status: () => number; text: () => Promise<string> }) {
    this.emit('response', response);
  }
}

function makeResponse(request: object, url: string, body: string) {
  return {
    request: () => request,
    url: () => url,
    status: () => 200,
    text: () => Promise.resolve(body),
  };
}

// ---------------------------------------------------------------------------
// Scheme H implementation (from commit e84828a, inline for comparison)
// ---------------------------------------------------------------------------
function interceptSchemeH(
  page: MockPage,
  urlPattern: RegExp,
  handler: InterceptHandler,
): { cleanup: () => void; swapHandler: (h: InterceptHandler) => void } {
  let activeHandler = handler;

  const listener = async (response: any) => {
    const url: string = response.url();
    if (!urlPattern.test(url)) return;

    // Scheme H: capture handler BEFORE await
    const h = activeHandler;
    const body = await response.text();
    h({ url, status: response.status(), body });
  };

  page.on('response', listener);

  return {
    cleanup: () => { page.off('response', listener); },
    swapHandler: (newHandler: InterceptHandler) => { activeHandler = newHandler; },
  };
}

// ---------------------------------------------------------------------------
// Scheme I implementation (request Set tracking — current fix)
// ---------------------------------------------------------------------------
function interceptSchemeI(
  page: MockPage,
  urlPattern: RegExp,
  handler: InterceptHandler,
): InterceptControl {
  let validRequests = new Set<object>();

  const requestListener = (request: any) => {
    if (urlPattern.test(request.url())) validRequests.add(request);
  };

  const responseListener = async (response: any) => {
    if (!urlPattern.test(response.url())) return;
    const body = await response.text();
    // Check AFTER await
    if (!validRequests.has(response.request())) return;
    handler({ url: response.url(), status: response.status(), body });
  };

  page.on('request', requestListener);
  page.on('response', responseListener);

  return {
    cleanup: () => {
      page.off('request', requestListener);
      page.off('response', responseListener);
    },
    reset: () => { validRequests = new Set(); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const TIMELINE_PATTERN = /\/(Home|HomeLatest|ListLatestTweets|CommunityTweets)Timeline/;

describe('Path Y: response event fires AFTER handler swap / reset', () => {

  it('Scheme H: stale R1 data ACCEPTED (bug)', async () => {
    const page = new MockPage();
    const collected: string[] = [];

    let generation = 0;
    function makeHandler() {
      const gen = generation;
      return (r: { url: string; status: number; body: string }) => {
        if (gen !== generation) return;
        collected.push(r.body);
      };
    }

    const intercept = interceptSchemeH(page, TIMELINE_PATTERN, makeHandler());

    // --- Simulate navigate(home) → R1 request fires ---
    const r1Request = { url: () => '/i/api/graphql/xyz/HomeTimeline' };
    // R1 response event has NOT fired yet (headers still in transit)

    // --- switchTab → reRegisterInterceptor (swapHandler) ---
    generation++;
    intercept.swapHandler(makeHandler()); // activeHandler = new handler (gen=1)

    // --- Path Y: R1 response event fires NOW (after swapHandler) ---
    // The listener captures activeHandler which is the NEW handler (gen=1)
    const r1Response = makeResponse(r1Request, '/i/api/graphql/xyz/HomeTimeline', 'R1_STALE_DATA');
    page.emitResponse(r1Response);

    // Wait for async listener to complete
    await new Promise(r => setTimeout(r, 10));

    // BUG: gen=1 === generation=1 → generation guard passes → stale data accepted
    expect(collected).toHaveLength(1);
    expect(collected[0]).toBe('R1_STALE_DATA');
  });

  it('Scheme I: stale R1 data REJECTED (fixed)', async () => {
    const page = new MockPage();
    const collected: string[] = [];

    const handler = (r: { url: string; status: number; body: string }) => {
      collected.push(r.body);
    };

    const intercept = interceptSchemeI(page, TIMELINE_PATTERN, handler);

    // --- Simulate navigate(home) → R1 request fires ---
    const r1Request = { url: () => '/i/api/graphql/xyz/HomeTimeline' };
    page.emitRequest(r1Request); // R1 tracked in Set A

    // --- switchTab → reRegisterInterceptor (reset) ---
    intercept.reset(); // validRequests = Set B (empty)

    // --- Path Y: R1 response event fires NOW (after reset) ---
    const r1Response = makeResponse(r1Request, '/i/api/graphql/xyz/HomeTimeline', 'R1_STALE_DATA');
    page.emitResponse(r1Response);

    // Wait for async listener to complete
    await new Promise(r => setTimeout(r, 10));

    // FIXED: R1.request is in Set A, not Set B → rejected
    expect(collected).toHaveLength(0);
  });

  it('Scheme I: R2 data after reset is ACCEPTED', async () => {
    const page = new MockPage();
    const collected: string[] = [];

    const handler = (r: { url: string; status: number; body: string }) => {
      collected.push(r.body);
    };

    const intercept = interceptSchemeI(page, TIMELINE_PATTERN, handler);

    // --- navigate(home) → R1 ---
    const r1Request = { url: () => '/i/api/graphql/xyz/HomeTimeline' };
    page.emitRequest(r1Request);

    // --- reset ---
    intercept.reset();

    // --- R1 response (stale) ---
    page.emitResponse(makeResponse(r1Request, '/i/api/graphql/xyz/HomeTimeline', 'R1_STALE'));

    // --- click tab → R2 request fires (tracked in new Set) ---
    const r2Request = { url: () => '/i/api/graphql/xyz/ListLatestTweetsTimeline' };
    page.emitRequest(r2Request);

    // --- R2 response (correct) ---
    page.emitResponse(makeResponse(r2Request, '/i/api/graphql/xyz/ListLatestTweetsTimeline', 'R2_CORRECT'));

    await new Promise(r => setTimeout(r, 10));

    // R1 rejected, R2 accepted
    expect(collected).toEqual(['R2_CORRECT']);
  });

  it('Scheme I: Path X (in-flight callback) also rejected', async () => {
    const page = new MockPage();
    const collected: string[] = [];

    const handler = (r: { url: string; status: number; body: string }) => {
      collected.push(r.body);
    };

    const intercept = interceptSchemeI(page, TIMELINE_PATTERN, handler);

    // --- R1 request tracked ---
    const r1Request = { url: () => '/i/api/graphql/xyz/HomeTimeline' };
    page.emitRequest(r1Request);

    // --- R1 response event fires BEFORE reset (Path X setup) ---
    // The listener enters, starts await response.text()
    const slowBody = new Promise<string>(resolve => {
      // Body resolves AFTER reset (simulates slow response.text())
      setTimeout(() => resolve('R1_INFLIGHT'), 50);
    });
    const r1Response = {
      request: () => r1Request,
      url: () => '/i/api/graphql/xyz/HomeTimeline',
      status: () => 200,
      text: () => slowBody,
    };
    page.emitResponse(r1Response);

    // --- reset happens while R1 body is still resolving ---
    intercept.reset();

    // Wait for slow body to resolve
    await new Promise(r => setTimeout(r, 100));

    // Path X: listener entered before reset, but body resolved after.
    // Check is AFTER await → R1 request not in new Set → rejected
    expect(collected).toHaveLength(0);
  });
});
